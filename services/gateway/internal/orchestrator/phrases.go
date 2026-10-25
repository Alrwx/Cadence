package orchestrator

import (
	"context"
	"errors"
	"log/slog"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// onPhraseEvent handles phrase.speak/save/delete and phrase.group.save/delete.
func (o *Orchestrator) onPhraseEvent(ctx context.Context, s *hub.Session, ss *sessionState, data any) {
	var err error
	switch d := data.(type) {
	case *protocol.PhraseSpeakData:
		var p store.Phrase
		if p, err = o.store.Phrase(ctx, o.personID, d.PhraseID); err == nil {
			o.speak(ctx, s, ss, p.Text, "saved", p.Locale)
			return
		}
	case *protocol.PhraseSaveData:
		// fromClipId needs no special handling: the clip cache is keyed by text, so a bookmarked reply
		// reuses the clip that was just played.
		var p store.Phrase
		if p, err = o.store.SavePhrase(ctx, o.personID, d.GroupID, d.Text, o.locale); err == nil {
			o.sendPhrases(ctx, s)
			go o.prepareClip(s, p.Text, p.Locale)
			return
		}
	case *protocol.PhraseDeleteData:
		err = o.store.DeletePhrase(ctx, o.personID, d.PhraseID)
	case *protocol.PhraseGroupSaveData:
		_, err = o.store.SaveGroup(ctx, o.personID, d.GroupID, d.Name, d.Order)
	case *protocol.PhraseGroupDeleteData:
		err = o.store.DeleteGroup(ctx, o.personID, d.GroupID)
	}
	if err != nil {
		o.phraseError(ctx, s, err)
		return
	}
	o.sendPhrases(ctx, s)
}

// sendPhrases sends the person's saved phrases to the headset.
func (o *Orchestrator) sendPhrases(ctx context.Context, s *hub.Session) {
	groups, err := o.store.PhraseGroups(ctx, o.personID, o.voice())
	if err != nil {
		slog.Error("load phrases", "session", s.ID, "err", err)
		o.sendError(ctx, s, "storage_failed", "Couldn't load saved phrases.")
		return
	}
	out := make([]protocol.PhrasesGroup, len(groups))
	for i, g := range groups {
		items := make([]protocol.PhrasesGroupItem, len(g.Phrases))
		for j, p := range g.Phrases {
			items[j] = protocol.PhrasesGroupItem{ID: p.ID, Text: p.Text, Icon: p.Icon, AudioReady: p.AudioReady}
		}
		out[i] = protocol.PhrasesGroup{ID: g.ID, Name: g.Name, Items: items}
	}
	_ = s.Send(ctx, hub.Headset, protocol.TypePhrases, "", protocol.PhrasesData{Groups: out})
}

// prepareClip synthesizes a newly saved phrase, then resends phrases so the headset sees audioReady.
func (o *Orchestrator) prepareClip(s *hub.Session, text, locale string) {
	ctx := context.Background()
	if _, err := o.clipFor(ctx, text, locale); err != nil {
		slog.Warn("prepare saved phrase", "session", s.ID, "err", err)
		return
	}
	o.sendPhrases(ctx, s)
}

// warmClips pre-synthesizes every saved and instant phrase that has no clip in the current voice yet,
// so they play as fast as the instant tier, then refreshes every connected headset's phrases.
// One warm-up runs at a time; a request that arrives during one (say, after a voice change) runs another after it.
func (o *Orchestrator) warmClips() {
	o.rewarm.Store(true)
	for o.rewarm.Load() && o.warming.CompareAndSwap(false, true) {
		o.rewarm.Store(false)
		o.warmOnce(o.voice())
		o.warming.Store(false)
	}
}

func (o *Orchestrator) warmOnce(voice string) {
	ctx := context.Background()

	type item struct{ text, locale string }
	var todo []item
	for _, text := range instantText {
		todo = append(todo, item{text, o.locale})
	}
	groups, err := o.store.PhraseGroups(ctx, o.personID, voice)
	if err != nil {
		slog.Error("warm clips", "err", err)
		return
	}
	for _, g := range groups {
		for _, p := range g.Phrases {
			if !p.AudioReady {
				todo = append(todo, item{p.Text, p.Locale})
			}
		}
	}

	made := 0
	for _, it := range todo {
		if voice != o.voice() {
			break // the voice changed mid warm-up; the next round warms the new one
		}
		if _, ok, _ := o.store.ClipID(ctx, voice, it.locale, it.text); ok {
			continue
		}
		if _, err := o.clipFor(ctx, it.text, it.locale); err != nil {
			// Usually the model service is down or still loading; phrases get synthesized on first use instead.
			slog.Warn("warm clips stopped", "err", err)
			break
		}
		made++
	}
	if made > 0 {
		slog.Info("warmed clips", "count", made, "voice", voice)
		for _, s := range o.hubSessions() {
			o.sendPhrases(ctx, s)
		}
	}
}

func (o *Orchestrator) phraseError(ctx context.Context, s *hub.Session, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		o.sendError(ctx, s, "not_found", "That phrase or group no longer exists.")
		o.sendPhrases(ctx, s) // the headset's list is stale; refresh it
	case errors.Is(err, store.ErrInvalid):
		o.sendError(ctx, s, "invalid_phrase", "Phrases and group names can't be empty or too long.")
	default:
		slog.Error("saved phrases", "session", s.ID, "err", err)
		o.sendError(ctx, s, "storage_failed", "Couldn't save that change.")
	}
}
