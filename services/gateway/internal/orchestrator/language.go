package orchestrator

import (
	"context"
	"errors"
	"log/slog"
	"slices"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/session"
)

// The language everything runs in: what STT listens for, what /suggest and /summarize answer in, and what
// typed replies and instant phrases are spoken in. Saved phrases keep the language they were written in.

// SupportedLocales are the languages with UI strings, instant phrases and starter phrases. The model service
// handles more (services/models/app/locale.py); adding one here is translation work, not plumbing.
var SupportedLocales = []string{"en", "es"}

// ErrUnsupportedLocale is returned by SetLocale for a language not in SupportedLocales.
var ErrUnsupportedLocale = errors.New("unsupported locale")

// instantText is what each instant phrase says, per locale.
var instantText = map[string]map[string]string{
	"en": {"yes": "Yes", "no": "No", "wait": "Give me a second", "hello": "Hello", "laugh": "Ha ha"},
	"es": {"yes": "Sí", "no": "No", "wait": "Dame un segundo", "hello": "Hola", "laugh": "Ja ja"},
}

// instantPhrase is the text of an instant phrase in locale, falling back to English; "" for an unknown id.
func instantPhrase(locale, id string) string {
	if text, ok := instantText[locale][id]; ok {
		return text
	}
	return instantText["en"][id]
}

func (o *Orchestrator) currentLocale() string {
	o.localeMu.RLock()
	defer o.localeMu.RUnlock()
	return o.locale
}

func (o *Orchestrator) languageStatus() protocol.LanguageData {
	return protocol.LanguageData{Locale: o.currentLocale(), Supported: SupportedLocales}
}

// Locale is the language conversations currently run in.
func (o *Orchestrator) Locale() string { return o.currentLocale() }

// SetLocale switches every session to locale: it's saved, the language's starter phrases are added if the person
// has none in it, and then, in the background (so a stalled socket can't hold up the caller, e.g. the voice
// upload's HTTP response), both clients are told, pending replies in the old language are dropped, STT streams
// reopen listening for the new language, and its instant phrases are synthesized ahead of use.
func (o *Orchestrator) SetLocale(ctx context.Context, locale string) error {
	if !slices.Contains(SupportedLocales, locale) {
		return ErrUnsupportedLocale
	}
	o.localeMu.Lock()
	changed := o.locale != locale
	if changed {
		if err := o.store.SetPersonLocale(ctx, o.personID, locale); err != nil {
			o.localeMu.Unlock()
			return err
		}
		o.locale = locale
	}
	o.localeMu.Unlock()
	if !changed {
		return nil
	}
	slog.Info("language changed", "locale", locale)
	if _, err := o.store.EnsureStarterPhrases(ctx, o.personID, locale); err != nil {
		slog.Error("starter phrases", "locale", locale, "err", err)
	}
	go o.refreshLanguage()
	return nil
}

// refreshLanguage moves every session to the current language. Overlapping calls coalesce, and the last one to
// run reads the newest language, so clients never end on a stale language event (the same scheme as refreshVoice).
func (o *Orchestrator) refreshLanguage() {
	o.languageDirty.Store(true)
	for o.languageDirty.Load() && o.languageRefreshing.CompareAndSwap(false, true) {
		o.languageDirty.Store(false)
		ctx := context.Background()
		status := o.languageStatus()
		for _, s := range o.hubSessions() {
			ss := o.session(s.ID)
			o.restartTurn(ctx, s, ss)
			o.restartSTT(ss)
			s.Broadcast(ctx, protocol.TypeLanguage, "", status)
			o.sendPhrases(ctx, s) // the language's starter phrases may have just been added
		}
		o.languageRefreshing.Store(false)
	}
	if len(o.hubSessions()) > 0 {
		o.warmClips() // instant phrases in the new language, and the new starter phrases
	}
}

// setLanguage handles language.set from the phone or the headset.
func (o *Orchestrator) setLanguage(ctx context.Context, s *hub.Session, from hub.Role, locale string) {
	err := o.SetLocale(ctx, locale)
	switch {
	case errors.Is(err, ErrUnsupportedLocale):
		o.sendErrorTo(ctx, s, from, "unsupported_language", "That language isn't available yet.")
	case err != nil:
		slog.Error("set language", "session", s.ID, "err", err)
		o.sendErrorTo(ctx, s, from, "storage_failed", "Couldn't change the language.")
	default:
		return
	}
	// Tell the sender where things stand, so its picker doesn't stay on the rejected language.
	_ = s.Send(ctx, from, protocol.TypeLanguage, "", o.languageStatus())
}

// restartTurn forgets what was said in the old language and backs out of replies offered in it, so the next
// suggestions aren't conditioned on (or written in) the old language.
func (o *Orchestrator) restartTurn(ctx context.Context, s *hub.Session, ss *sessionState) {
	o.dropSpeculation(ss)
	ss.mu.Lock()
	ss.history = nil
	st := ss.machine.State()
	ss.mu.Unlock()
	if st == session.Suggesting || st == session.Choosing {
		o.apply(ctx, s, ss, session.Cancel)
	}
}

// restartSTT closes the session's STT stream without reporting an error; the next mic frame opens a new one in
// the current language.
func (o *Orchestrator) restartSTT(ss *sessionState) {
	ss.sttMu.Lock()
	stream := ss.stt
	ss.stt = nil
	ss.sttMu.Unlock()
	if stream != nil {
		stream.Close() // readSTT's endSTT sees it's no longer current and stays quiet
	}
}
