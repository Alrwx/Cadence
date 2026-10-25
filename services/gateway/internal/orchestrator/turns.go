package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/session"
)

const (
	partialInterval = 400 * time.Millisecond // transcript.partial is rate-limited to this
	sttRetryAfter   = 5 * time.Second        // wait this long after a failed /stt dial before trying again
	suggestCount    = 3
	historySent     = 20 // turns sent to /suggest
	historyKept     = 50 // turns kept in memory per session
)

// endTurnLocked cancels the turn's in-flight /suggest and forgets its suggestions. Callers hold ss.mu.
func (ss *sessionState) endTurnLocked() {
	if ss.cancelTurn != nil {
		ss.cancelTurn()
		ss.cancelTurn = nil
	}
	ss.suggestions = map[string]string{}
}

func (ss *sessionState) addTurnLocked(speaker, text string) {
	ss.history = append(ss.history, models.Turn{Speaker: speaker, Text: text})
	if len(ss.history) > historyKept {
		ss.history = append([]models.Turn(nil), ss.history[len(ss.history)-historyKept:]...)
	}
}

// sttStream returns the session's open STT stream, dialing one if needed. After a failed dial it returns nil
// until sttRetryAfter has passed (or the phone unlocks again), so a down model service isn't dialed per frame.
func (o *Orchestrator) sttStream(s *hub.Session, ss *sessionState) *models.STTStream {
	ss.sttMu.Lock()
	defer ss.sttMu.Unlock()
	if ss.stt != nil {
		return ss.stt
	}
	if !ss.sttFailedAt.IsZero() && time.Since(ss.sttFailedAt) < sttRetryAfter {
		return nil
	}
	stream, err := o.models.OpenSTT(context.Background(), o.locale)
	if err != nil {
		slog.Warn("stt unavailable", "session", s.ID, "err", err)
		ss.sttFailedAt = time.Now()
		o.sendError(context.Background(), s, "stt_failed", "Can't hear the speaker right now. Instant phrases and typing still work.")
		return nil
	}
	ss.stt = stream
	go o.readSTT(s, ss, stream)
	return stream
}

func (o *Orchestrator) resetSTTBackoff(ss *sessionState) {
	ss.sttMu.Lock()
	ss.sttFailedAt = time.Time{}
	ss.sttMu.Unlock()
}

// endSTT forgets stream if it is still the session's current one, closes it, and tells the headset.
func (o *Orchestrator) endSTT(s *hub.Session, ss *sessionState, stream *models.STTStream) {
	ss.sttMu.Lock()
	current := ss.stt == stream
	if current {
		ss.stt = nil
		ss.sttFailedAt = time.Now()
	}
	ss.sttMu.Unlock()
	stream.Close()
	if current {
		slog.Warn("stt stream ended", "session", s.ID)
		o.sendError(context.Background(), s, "stt_failed", "Lost the speech connection. Instant phrases and typing still work.")
	}
}

// readSTT turns the model service's transcripts into events until the stream ends.
func (o *Orchestrator) readSTT(s *hub.Session, ss *sessionState, stream *models.STTStream) {
	ctx := context.Background()
	var lastPartial time.Time
	for ev := range stream.Events() {
		switch ev.Kind {
		case "partial":
			if time.Since(lastPartial) < partialInterval || o.stateOf(ss) == session.Speaking {
				continue
			}
			lastPartial = time.Now()
			s.Broadcast(ctx, protocol.TypeTranscriptPartial, ss.currentTurn(), protocol.TranscriptPartialData{Text: ev.Text, Speaker: "other"})
		case "final":
			o.onFinal(s, ss, ev.Text)
		}
	}
	o.endSTT(s, ss, stream)
}

func (ss *sessionState) currentTurn() string {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return ss.turnID
}

func (o *Orchestrator) stateOf(ss *sessionState) session.State {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return ss.machine.State()
}

// onFinal handles a finished utterance from the other person. Finals heard before Start or while a reply is
// playing (the phone's own speaker) are dropped. If the user is already choosing or composing, the caption is
// shown but no new turn starts.
func (o *Orchestrator) onFinal(s *hub.Session, ss *sessionState, text string) {
	if st := o.stateOf(ss); st == session.Idle || st == session.Speaking {
		return
	}
	finalAt := time.Now()
	ctx := context.Background()
	s.Broadcast(ctx, protocol.TypeTranscriptFinal, ss.currentTurn(), protocol.TranscriptFinalData{Text: text, Speaker: "other"})

	turnCtx, turnID, history, ok := o.beginTurn(ss, text)
	if !ok {
		return
	}
	o.recordTurn(s.ID, "other", text)
	s.Broadcast(ctx, protocol.TypeState, turnID, protocol.StateData{State: string(session.Suggesting)})
	go o.suggest(turnCtx, s, ss, turnID, history, finalAt)
}

// beginTurn moves LISTENING -> SUGGESTING under a new turn id and records what the other person said.
func (o *Orchestrator) beginTurn(ss *sessionState, text string) (context.Context, string, []models.Turn, bool) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if _, err := ss.machine.Apply(session.SpeechEnded); err != nil {
		return nil, "", nil, false
	}
	ss.endTurnLocked()
	ss.turnSeq++
	ss.turnID = fmt.Sprintf("t_%d", ss.turnSeq)
	ss.addTurnLocked("other", text)
	ctx, cancel := context.WithCancel(context.Background())
	ss.cancelTurn = cancel
	recent := ss.history[max(0, len(ss.history)-historySent):]
	return ctx, ss.turnID, append([]models.Turn(nil), recent...), true
}

// suggest asks the model service for replies and, if the turn is still current, shows them on the headset
// and starts synthesizing them so the one that gets picked is usually ready to play.
// finalAt is when the STT final arrived, for the final_to_suggestions metric.
func (o *Orchestrator) suggest(ctx context.Context, s *hub.Session, ss *sessionState, turnID string, history []models.Turn, finalAt time.Time) {
	start := time.Now()
	resp, err := o.models.Suggest(ctx, models.SuggestRequest{
		TurnID: turnID, History: history, Style: models.Style{Phrases: []string{}}, N: suggestCount,
	})
	outcome := suggestOutcome(ctx, err)
	if err == nil && len(resp.Items) == 0 {
		err = errors.New("no suggestions returned")
		outcome = "empty"
	}
	o.recordSince(s.ID, metricSuggest, start, outcome)
	if ctx.Err() != nil {
		return // cancelled or superseded: the turn moved on
	}
	if err != nil {
		slog.Error("suggest", "session", s.ID, "turn", turnID, "err", err)
		if next, ok := o.finishSuggesting(ss, turnID, session.Cancel, nil); ok {
			o.sendError(context.Background(), s, "suggest_failed", "Couldn't think of replies. Instant phrases and typing still work.")
			s.Broadcast(context.Background(), protocol.TypeState, turnID, protocol.StateData{State: string(next)})
		}
		return
	}

	bg := context.Background()
	items := make(map[string]string, len(resp.Items))
	out := make([]protocol.SuggestionsItem, 0, len(resp.Items))
	var pending []protocol.SuggestionsItem
	for i, it := range resp.Items {
		if it.Text == "" {
			continue
		}
		kind := it.Kind
		if kind == "" {
			kind = "statement"
		}
		item := protocol.SuggestionsItem{
			ID: fmt.Sprintf("s_%s_%d", turnID, i), Text: it.Text, Kind: kind,
			AudioReady: o.clipReady(bg, it.Text, o.locale),
		}
		items[item.ID] = it.Text
		out = append(out, item)
		if !item.AudioReady {
			pending = append(pending, item)
		}
	}
	next, ok := o.finishSuggesting(ss, turnID, session.SuggestionsReady, items)
	if !ok {
		return
	}
	o.recordSince(s.ID, metricFinalToSuggestions, finalAt, "")
	_ = s.Send(bg, hub.Headset, protocol.TypeSuggestions, turnID, protocol.SuggestionsData{Items: out})
	s.Broadcast(bg, protocol.TypeState, turnID, protocol.StateData{State: string(next)})
	for _, item := range pending {
		go o.prepareSuggestion(s, ss, turnID, item)
	}
}

// finishSuggesting applies in only if turnID is still the current turn and the session is still SUGGESTING;
// otherwise the result is stale and is dropped. On success it stores items as the turn's suggestions.
func (o *Orchestrator) finishSuggesting(ss *sessionState, turnID string, in session.Input, items map[string]string) (session.State, bool) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.turnID != turnID || ss.machine.State() != session.Suggesting {
		return "", false
	}
	next, err := ss.machine.Apply(in)
	if err != nil {
		return "", false
	}
	if in == session.Cancel {
		ss.endTurnLocked()
	} else {
		ss.suggestions = items
	}
	return next, true
}

// prepareSuggestion synthesizes one suggestion, then tells the headset it's ready. It deliberately ignores the
// turn's cancellation: if the user picks this reply meanwhile, speak() shares this synthesis (see clipFor), and
// a finished clip is cached for next time either way.
func (o *Orchestrator) prepareSuggestion(s *hub.Session, ss *sessionState, turnID string, item protocol.SuggestionsItem) {
	ctx, _ := withTTSPurpose(context.Background(), s.ID, "suggestion")
	if _, err := o.clipFor(ctx, item.Text, o.locale); err != nil {
		slog.Warn("prepare suggestion", "session", s.ID, "turn", turnID, "err", err)
		return
	}
	ss.mu.Lock()
	_, live := ss.suggestions[item.ID]
	current := ss.turnID == turnID
	ss.mu.Unlock()
	if live && current {
		_ = s.Send(ctx, hub.Headset, protocol.TypeSuggestionAudioReady, turnID, protocol.SuggestionAudioReadyData{ID: item.ID})
	}
}

// clipReady reports whether text already has a playable clip in the current voice.
func (o *Orchestrator) clipReady(ctx context.Context, text, locale string) bool {
	id, ok, err := o.store.ClipID(ctx, o.voice(), locale, text)
	return err == nil && ok && o.clips.Has(id)
}
