// Package orchestrator decides what happens when: it drives each session's state machine,
// calls the model service, and turns selections into audio.play events.
package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/clips"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/session"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// defaultVoiceID is used until voice profiles and consent are wired up.
const defaultVoiceID = "default"

type Orchestrator struct {
	store  *store.Store
	models *models.Client
	clips  *clips.Cache

	mu    sync.Mutex
	state map[string]*sessionState
}

type sessionState struct {
	mu          sync.Mutex
	machine     *session.Machine
	turnID      string
	suggestions map[string]string // suggestion id -> text, for the current turn
}

func New(st *store.Store, mc *models.Client, cc *clips.Cache) *Orchestrator {
	return &Orchestrator{store: st, models: mc, clips: cc, state: map[string]*sessionState{}}
}

func (o *Orchestrator) OnConnect(s *hub.Session, role hub.Role) {
	ss := o.session(s.ID)
	ss.mu.Lock()
	state := ss.machine.State()
	ss.mu.Unlock()
	ctx := context.Background()
	_ = s.Send(ctx, role, protocol.TypeState, ss.turnID, protocol.StateData{State: string(state)})
	if role == hub.Headset {
		// TODO(Dev 4): load phrase_group + saved_phrase rows for the session's person.
		_ = s.Send(ctx, role, protocol.TypePhrases, "", protocol.PhrasesData{Groups: []protocol.PhrasesGroup{}})
	}
}

func (o *Orchestrator) OnAudio(s *hub.Session, frame []byte) {
	// TODO(Dev 4): forward frames to the model service's WS /stt, broadcast transcript.partial/final,
	// debounce partials (~400 ms) and speculatively call /suggest and /tts for the top 3.
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
		o.apply(ctx, s, ss, session.Start)
	case *protocol.ComposeStartData:
		o.apply(ctx, s, ss, session.ComposeStart)
	case *protocol.CancelData:
		o.apply(ctx, s, ss, session.Cancel)
	case *protocol.AudioDoneData:
		o.apply(ctx, s, ss, session.ClipDone)
	case *protocol.ComposeSubmitData:
		o.speak(ctx, s, ss, d.Text, "typed")
	case *protocol.SelectData:
		ss.mu.Lock()
		text, ok := ss.suggestions[d.SuggestionID]
		ss.mu.Unlock()
		if !ok {
			o.sendError(ctx, s, "stale_suggestion", "That suggestion is no longer available.")
			return
		}
		o.speak(ctx, s, ss, text, "suggestion")
	case *protocol.InstantData:
		// TODO(Dev 4): play the clip pre-synthesized at voice-creation time instead of synthesizing now.
		o.speak(ctx, s, ss, instantText[d.PhraseID], "instant")
	case *protocol.PhraseSpeakData:
		// TODO(Dev 4): look up the saved phrase and play its pre-synthesized clip.
		o.sendError(ctx, s, "not_implemented", "Saved phrases aren't wired up yet.")
	case *protocol.PhraseSaveData, *protocol.PhraseDeleteData, *protocol.PhraseGroupSaveData, *protocol.PhraseGroupDeleteData:
		// TODO(Dev 4): CRUD in store, synthesize on save, then resend the phrases event.
		o.sendError(ctx, s, "not_implemented", "Editing saved phrases isn't wired up yet.")
	default:
		slog.Info("event not handled yet", "session", s.ID, "type", env.Type)
	}
}

var instantText = map[string]string{
	"yes": "Yes", "no": "No", "wait": "Give me a second", "hello": "Hello", "laugh": "Ha ha",
}

// speak synthesizes text, caches the clip, logs it, and tells the phone to play it.
func (o *Orchestrator) speak(ctx context.Context, s *hub.Session, ss *sessionState, text, source string) {
	if text == "" {
		o.sendError(ctx, s, "unknown_phrase", "Nothing to say for that selection.")
		return
	}
	if !o.apply(ctx, s, ss, session.Speak) {
		return
	}
	clipID := fmt.Sprintf("c_%d", time.Now().UnixNano())
	wav, err := o.models.TTS(ctx, defaultVoiceID, text)
	if err == nil {
		err = o.clips.Put(clipID, wav)
	}
	if err != nil {
		slog.Error("tts", "session", s.ID, "err", err)
		o.sendError(ctx, s, "tts_failed", "Couldn't make that audio. Instant phrases and typing still work.")
		o.apply(ctx, s, ss, session.ClipDone)
		return
	}
	if err := o.store.LogUtterance(s.ID, clipID, text, source, time.Now().UnixMilli()); err != nil {
		slog.Error("audit log", "session", s.ID, "err", err)
	}
	_ = s.Send(ctx, hub.Phone, protocol.TypeAudioPlay, ss.turnID, protocol.AudioPlayData{
		ClipID: clipID, URL: "/clips/" + clipID + ".wav", Text: text, Source: source,
	})
}

// apply feeds an input to the state machine and broadcasts the new state. It reports whether the input was accepted.
func (o *Orchestrator) apply(ctx context.Context, s *hub.Session, ss *sessionState, in session.Input) bool {
	ss.mu.Lock()
	next, err := ss.machine.Apply(in)
	turnID := ss.turnID
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
