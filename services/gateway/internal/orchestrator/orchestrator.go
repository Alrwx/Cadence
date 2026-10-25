// Package orchestrator decides what happens when: it drives each session's state machine,
// calls the model service, and turns selections into audio.play events.
package orchestrator

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/clips"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/session"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// defaultVoiceID is the model service's built-in generic voice: used until the person records a voice on the
// phone (POST /api/voices), and whenever they switch to it with voice.use.
const defaultVoiceID = "default"

type Orchestrator struct {
	store  *store.Store
	models *models.Client
	clips  *clips.Cache

	// Single-user for now: every session belongs to this person.
	personID string
	locale   string

	// The voice clips are made in (see voice.go). Never held while sending.
	voiceMu     sync.RWMutex
	clonedVoice string          // model service voiceId of the person's cloned voice; "" if none
	useDefault  bool            // the person chose the generic voice (voice.use) over the cloned one
	revoked     map[string]bool // model voiceIds whose consent was revoked: never used or cached again

	voiceRefreshing atomic.Bool // refreshVoice is sending the voice to the sessions
	voiceDirty      atomic.Bool // the voice changed while it was

	mu    sync.Mutex
	state map[string]*sessionState

	flightMu sync.Mutex
	inflight map[string]*flight // clip-cache key -> synthesis in progress
	warming  atomic.Bool
	rewarm   atomic.Bool // a warm-up was requested while one was running (e.g. the voice changed)

	writer *dbWriter // metric, session and turn rows, written off the event path (metrics.go)

	speculateAfter time.Duration // partial-transcript debounce before a speculative /suggest; 0 = default (speculation.go)
}

type sessionState struct {
	mu           sync.Mutex
	hub          *hub.Session // set on connect, so a voice change can refresh this session's phrases
	machine      *session.Machine
	turnID       string
	turnSeq      int
	suggestions  map[string]string // suggestion id -> text, for the current turn
	history      []heardTurn
	attached     []string           // saved conversation ids used as /suggest context (conversation.attach)
	savedThrough time.Time          // when the last turn of the last saved conversation was said
	summarizing  bool               // a memory.save or conversation.save is waiting on /summarize
	cancelTurn   context.CancelFunc // cancels the in-flight /suggest for the current turn

	spec speculator // speculative /suggest on partials; its own lock, taken before mu (speculation.go)

	// The speech-to-text stream is managed separately because opening it can block on a dial.
	sttMu       sync.Mutex
	stt         *models.STTStream
	sttFailedAt time.Time
}

func New(st *store.Store, mc *models.Client, cc *clips.Cache, personID, locale string) *Orchestrator {
	return &Orchestrator{
		store: st, models: mc, clips: cc,
		personID: personID, locale: locale, revoked: map[string]bool{},
		state: map[string]*sessionState{}, inflight: map[string]*flight{},
		writer: newDBWriter(),
	}
}

func (o *Orchestrator) OnConnect(s *hub.Session, role hub.Role) {
	o.sessionStarted(s.ID)
	ss := o.session(s.ID)
	ss.mu.Lock()
	ss.hub = s
	state, turnID := ss.machine.State(), ss.turnID
	ss.mu.Unlock()
	ctx := context.Background()
	_ = s.Send(ctx, role, protocol.TypeState, turnID, protocol.StateData{State: string(state)})
	_ = s.Send(ctx, role, protocol.TypeVoice, "", o.voiceStatus())
	if role == hub.Headset {
		o.sendPhrases(ctx, s)
		o.sendConsent(ctx, s)
		o.sendMemories(ctx, s)
		o.sendConversations(ctx, s)
		go o.warmClips()
	}
}

// hubSessions lists the sessions that have connected at least once.
func (o *Orchestrator) hubSessions() []*hub.Session {
	o.mu.Lock()
	states := make([]*sessionState, 0, len(o.state))
	for _, ss := range o.state {
		states = append(states, ss)
	}
	o.mu.Unlock()
	var out []*hub.Session
	for _, ss := range states {
		ss.mu.Lock()
		if ss.hub != nil {
			out = append(out, ss.hub)
		}
		ss.mu.Unlock()
	}
	return out
}

// OnAudio forwards phone mic frames to the model service's STT stream; transcripts come back through readSTT.
func (o *Orchestrator) OnAudio(s *hub.Session, frame []byte) {
	ss := o.session(s.ID)
	stream := o.sttStream(s, ss)
	if stream == nil {
		return
	}
	if err := stream.Send(frame); err != nil {
		o.endSTT(s, ss, stream)
	}
}

func (o *Orchestrator) OnEvent(s *hub.Session, from hub.Role, env protocol.Envelope) {
	data, ok := protocol.NewData(env.Type)
	if !ok {
		slog.Warn("unknown event ignored", "session", s.ID, "role", from, "type", env.Type)
		return
	}
	if err := json.Unmarshal(env.Data, data); err != nil {
		slog.Warn("bad event data", "session", s.ID, "type", env.Type, "err", err)
		return
	}
	ctx := context.Background()
	ss := o.session(s.ID)

	switch d := data.(type) {
	case *protocol.PhoneUnlockData:
		o.resetSTTBackoff(ss) // the user tapped Start: retry the model service right away
		o.apply(ctx, s, ss, session.Start)
	case *protocol.ComposeStartData:
		o.apply(ctx, s, ss, session.ComposeStart)
	case *protocol.CancelData:
		o.apply(ctx, s, ss, session.Cancel)
	case *protocol.ConversationResetData:
		o.resetConversation(ctx, s, ss)
	case *protocol.AudioDoneData:
		o.apply(ctx, s, ss, session.ClipDone)
	case *protocol.ComposeSubmitData:
		o.speak(ctx, s, ss, d.Text, "typed", o.locale)
	case *protocol.SelectData:
		ss.mu.Lock()
		text, ok := ss.suggestions[d.SuggestionID]
		ss.mu.Unlock()
		if !ok {
			o.sendError(ctx, s, "stale_suggestion", "That suggestion is no longer available.")
			return
		}
		o.speak(ctx, s, ss, text, "suggestion", o.locale)
	case *protocol.InstantData:
		// Pre-synthesized by warmClips; synthesized now only if warm-up hasn't reached it yet.
		o.speak(ctx, s, ss, instantText[d.PhraseID], "instant", o.locale)
	case *protocol.PhraseSpeakData, *protocol.PhraseSaveData, *protocol.PhraseDeleteData,
		*protocol.PhraseGroupSaveData, *protocol.PhraseGroupDeleteData:
		o.onPhraseEvent(ctx, s, ss, d)
	case *protocol.ConsentSetData, *protocol.MemorySaveData, *protocol.MemoryDeleteData,
		*protocol.ConversationSaveData, *protocol.ConversationDeleteData, *protocol.ConversationAttachData:
		o.onMemoryEvent(ctx, s, ss, d)
	case *protocol.VoiceUseData:
		o.useVoice(ctx, s, from, d.Voice)
	default:
		slog.Info("event not handled yet", "session", s.ID, "type", env.Type)
	}
}

var instantText = map[string]string{
	"yes": "Yes", "no": "No", "wait": "Give me a second", "hello": "Hello", "laugh": "Ha ha",
}

// speak gets a clip for text (from the cache, or synthesized now), logs it, and tells the phone to play it.
func (o *Orchestrator) speak(ctx context.Context, s *hub.Session, ss *sessionState, text, source, locale string) {
	if text == "" {
		o.sendError(ctx, s, "unknown_phrase", "Nothing to say for that selection.")
		return
	}
	selectedAt := time.Now()
	if !o.apply(ctx, s, ss, session.Speak) {
		return
	}
	o.record(s.ID, metricSelection, -1, source)
	ctx, tag := withTTSPurpose(ctx, s.ID, source)
	clipID, err := o.clipFor(ctx, text, locale)
	if err != nil {
		slog.Error("tts", "session", s.ID, "err", err)
		o.sendError(ctx, s, "tts_failed", "Couldn't make that audio. Instant phrases and typing still work.")
		o.apply(ctx, s, ss, session.ClipDone)
		return
	}
	if err := o.store.LogUtterance(s.ID, clipID, text, source, time.Now().UnixMilli()); err != nil {
		slog.Error("audit log", "session", s.ID, "err", err)
	}
	ss.mu.Lock()
	ss.addTurnLocked("user", text)
	turnID := ss.turnID
	ss.mu.Unlock()
	o.spoken(s.ID, source, selectedAt, tag) // queued before the send, so it's in by the time the phone hears it
	_ = s.Send(ctx, hub.Phone, protocol.TypeAudioPlay, turnID, protocol.AudioPlayData{
		ClipID: clipID, URL: "/clips/" + clipID + ".wav", Text: text, Source: source,
	})
}

// apply feeds an input to the state machine and broadcasts the new state. It reports whether the input was accepted.
func (o *Orchestrator) apply(ctx context.Context, s *hub.Session, ss *sessionState, in session.Input) bool {
	ss.mu.Lock()
	next, err := ss.machine.Apply(in)
	turnID := ss.turnID
	if err == nil && (in == session.Speak || in == session.ComposeStart || in == session.Cancel) {
		ss.endTurnLocked()
	}
	ss.mu.Unlock()
	if err != nil {
		slog.Info("ignored input", "session", s.ID, "err", err)
		return false
	}
	s.Broadcast(ctx, protocol.TypeState, turnID, protocol.StateData{State: string(next)})
	return true
}

// sendError sends a recoverable error to the headset, where the user sees it.
func (o *Orchestrator) sendError(ctx context.Context, s *hub.Session, code, message string) {
	o.sendErrorTo(ctx, s, hub.Headset, code, message)
}

func (o *Orchestrator) sendErrorTo(ctx context.Context, s *hub.Session, role hub.Role, code, message string) {
	_ = s.Send(ctx, role, protocol.TypeError, "", protocol.ErrorData{Code: code, Message: message, Recoverable: true})
}

func (o *Orchestrator) session(id string) *sessionState {
	o.mu.Lock()
	defer o.mu.Unlock()
	ss, ok := o.state[id]
	if !ok {
		ss = &sessionState{
			machine:     session.NewMachine(),
			turnID:      "t_0",
			suggestions: map[string]string{},
		}
		o.state[id] = ss
	}
	return ss
}
