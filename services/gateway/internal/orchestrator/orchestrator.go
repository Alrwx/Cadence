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

// defaultVoiceID is used until the person records a voice on the phone (POST /api/voices).
const defaultVoiceID = "default"

type Orchestrator struct {
	store  *store.Store
	models *models.Client
	clips  *clips.Cache

	// Single-user for now: every session belongs to this person.
	personID string
	locale   string

	voiceMu sync.RWMutex
	voiceID string // model service voiceId every clip is synthesized in; changed by SetVoice

	mu    sync.Mutex
	state map[string]*sessionState

	flightMu sync.Mutex
	inflight map[string]*flight // clip-cache key -> synthesis in progress
	warming  atomic.Bool
	rewarm   atomic.Bool // a warm-up was requested while one was running (e.g. the voice changed)
}

type sessionState struct {
	mu          sync.Mutex
	hub         *hub.Session // set on connect, so a voice change can refresh this session's phrases
	machine     *session.Machine
	turnID      string
	turnSeq     int
	suggestions map[string]string // suggestion id -> text, for the current turn
	history     []models.Turn
	cancelTurn  context.CancelFunc // cancels the in-flight /suggest for the current turn

	// The speech-to-text stream is managed separately because opening it can block on a dial.
	sttMu       sync.Mutex
	stt         *models.STTStream
	sttFailedAt time.Time
}

func New(st *store.Store, mc *models.Client, cc *clips.Cache, personID, locale string) *Orchestrator {
	return &Orchestrator{
		store: st, models: mc, clips: cc,
		personID: personID, locale: locale, voiceID: defaultVoiceID,
		state: map[string]*sessionState{}, inflight: map[string]*flight{},
	}
}

func (o *Orchestrator) OnConnect(s *hub.Session, role hub.Role) {
	ss := o.session(s.ID)
	ss.mu.Lock()
	ss.hub = s
	state, turnID := ss.machine.State(), ss.turnID
	ss.mu.Unlock()
	ctx := context.Background()
	_ = s.Send(ctx, role, protocol.TypeState, turnID, protocol.StateData{State: string(state)})
	if role == hub.Headset {
		o.sendPhrases(ctx, s)
		go o.warmClips()
	}
}

// voice is the model service voiceId clips are synthesized in.
func (o *Orchestrator) voice() string {
	o.voiceMu.RLock()
	defer o.voiceMu.RUnlock()
	return o.voiceID
}

// SetVoice switches every session to a newly cloned voice. Clips are cached per voice, so the headset's
// phrases show as not ready until warmClips has synthesized them in the new voice.
func (o *Orchestrator) SetVoice(voiceID string) {
	o.voiceMu.Lock()
	changed := o.voiceID != voiceID
	o.voiceID = voiceID
	o.voiceMu.Unlock()
	if !changed {
		return
	}
	sessions := o.hubSessions()
	ctx := context.Background()
	for _, s := range sessions {
		o.sendPhrases(ctx, s)
	}
	if len(sessions) > 0 {
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
	if !o.apply(ctx, s, ss, session.Speak) {
		return
	}
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

func (o *Orchestrator) sendError(ctx context.Context, s *hub.Session, code, message string) {
	_ = s.Send(ctx, hub.Headset, protocol.TypeError, "", protocol.ErrorData{Code: code, Message: message, Recoverable: true})
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
