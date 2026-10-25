package orchestrator

import (
	"context"
	"slices"
	"testing"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
)

func (f *fakeModels) sttLocalesSeen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.sttLocales)
}

func (f *fakeModels) ttsLocaleOf(text string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ttsLocales[text]
}

// TestLanguageSetSwitchesEverything: after language.set es, both clients are told, the choice is saved, the
// Spanish starter phrases appear, replies offered in English are withdrawn, the speech stream reopens listening
// for Spanish, /suggest is asked for Spanish without the English history, and instant phrases speak Spanish.
func TestLanguageSetSwitchesEverything(t *testing.T) {
	fm := &fakeModels{}
	o, headset, phone := pairedSession(t, fm)

	var lang protocol.LanguageData
	headset.expect(protocol.TypeLanguage, &lang, func() bool { return lang.Locale == "en" })
	if !slices.Equal(lang.Supported, []string{"en", "es"}) {
		t.Fatalf("supported = %v", lang.Supported)
	}

	// An English turn, waiting for a choice.
	phone.sendAudio(make([]byte, 640))
	headset.expectState("CHOOSING")

	phone.send(protocol.TypeLanguageSet, protocol.LanguageSetData{Locale: "es"})
	headset.expect(protocol.TypeLanguage, &lang, func() bool { return lang.Locale == "es" })
	phone.expect(protocol.TypeLanguage, &lang, func() bool { return lang.Locale == "es" })
	if got, err := o.store.PersonLocale(context.Background(), o.personID); err != nil || got != "es" {
		t.Fatalf("saved locale = %q, %v", got, err)
	}
	var phrases protocol.PhrasesData
	headset.expect(protocol.TypePhrases, &phrases, func() bool { return len(phrases.Groups) == 4 })
	if phrases.Groups[2].Name != "Hospital (español)" || phrases.Groups[2].Items[0].Text != "Necesito agua" {
		t.Fatalf("phrases = %+v", phrases.Groups)
	}
	if st := o.stateOf(o.session("s1")); st != "LISTENING" {
		t.Fatalf("state after the switch = %s, want the English replies withdrawn", st)
	}

	// The next speech reopens the stream in Spanish, and the replies are asked for in Spanish, fresh.
	phone.sendAudio(make([]byte, 640))
	headset.expectState("CHOOSING")
	if got := fm.sttLocalesSeen(); !slices.Equal(got, []string{"en", "es"}) {
		t.Fatalf("/stt locales = %v", got)
	}
	reqs := fm.suggestRequests()
	last := reqs[len(reqs)-1]
	if last.Locale != "es" || len(last.History) != 1 {
		t.Fatalf("/suggest after the switch = locale %q, history %+v", last.Locale, last.History)
	}

	headset.send(protocol.TypeInstant, protocol.InstantData{PhraseID: "yes"})
	var play protocol.AudioPlayData
	phone.expect(protocol.TypeAudioPlay, &play, nil)
	if play.Text != "Sí" || fm.ttsLocaleOf("Sí") != "es" {
		t.Fatalf("instant yes = %+v, synthesized in %q", play, fm.ttsLocaleOf("Sí"))
	}
}

// An unsupported language is refused, and the sender is told the language hasn't changed.
func TestLanguageSetRejectsUnsupported(t *testing.T) {
	fm := &fakeModels{}
	o, headset, _ := pairedSession(t, fm)

	headset.send(protocol.TypeLanguageSet, protocol.LanguageSetData{Locale: "fr"})
	var e protocol.ErrorData
	headset.expect(protocol.TypeError, &e, func() bool { return e.Code == "unsupported_language" })
	var lang protocol.LanguageData
	headset.expect(protocol.TypeLanguage, &lang, nil)
	if lang.Locale != "en" || o.Locale() != "en" {
		t.Fatalf("language = %q, orchestrator = %q", lang.Locale, o.Locale())
	}
}

func TestInstantPhraseFallsBackToEnglish(t *testing.T) {
	for _, c := range []struct{ locale, id, want string }{
		{"es", "wait", "Dame un segundo"},
		{"fr", "wait", "Give me a second"},
		{"es", "nope", ""},
	} {
		if got := instantPhrase(c.locale, c.id); got != c.want {
			t.Errorf("instantPhrase(%q, %q) = %q, want %q", c.locale, c.id, got, c.want)
		}
	}
}
