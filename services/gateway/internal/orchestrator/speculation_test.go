package orchestrator

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
)

func TestNormalizeUtterance(t *testing.T) {
	for _, tc := range []struct{ a, b string }{
		{"How are you feeling", "how are you feeling?"},
		{"  How   are you\tfeeling ", "How are you feeling."},
		{"Hi, how are you", "hi how are you!"},
		{"It's late", "it’s late…"},
		{`"Ready?" she asked`, "ready she asked"},
	} {
		if na, nb := normalizeUtterance(tc.a), normalizeUtterance(tc.b); na != nb {
			t.Errorf("normalize(%q) = %q, normalize(%q) = %q; want equal", tc.a, na, tc.b, nb)
		}
	}
	for _, tc := range []struct{ a, b string }{
		{"How are you", "How are you feeling"},
		{"It's late", "Its late"},
		{"Are you okay", "You are okay"},
	} {
		if normalizeUtterance(tc.a) == normalizeUtterance(tc.b) {
			t.Errorf("normalize(%q) == normalize(%q); want different", tc.a, tc.b)
		}
	}
	if got := normalizeUtterance(" ?! "); got != "" {
		t.Errorf("punctuation only = %q, want empty", got)
	}
}

func sttMsg(kind, text string) string {
	b, _ := json.Marshal(map[string]string{"kind": kind, "text": text})
	return string(b)
}

// sttStep is one transcript message from the fake STT, then an optional wait before the next one.
type sttStep struct {
	kind, text   string
	pause        time.Duration // sleep after sending
	untilSuggest int           // or wait until the fake has received this many /suggest calls
}

func TestSpeculation(t *testing.T) {
	const partial = "How are you feeling"
	slowForPartial := func(d time.Duration) func(models.SuggestRequest) time.Duration {
		return func(req models.SuggestRequest) time.Duration {
			if req.History[len(req.History)-1].Text == partial {
				return d
			}
			return 0
		}
	}
	for _, tc := range []struct {
		name         string
		debounce     time.Duration
		delayFor     func(models.SuggestRequest) time.Duration
		steps        []sttStep
		wantCalls    int    // /suggest calls in total
		wantQuote    string // the suggestions shown answer this text
		wantCanceled int64
		wantOutcome  string
	}{
		{
			name:     "matching final reuses the finished speculative call",
			debounce: 20 * time.Millisecond,
			steps: []sttStep{
				{kind: "partial", text: partial, untilSuggest: 1},
				{kind: "final", text: "How are you feeling?"},
			},
			wantCalls: 1, wantQuote: partial, wantOutcome: "hit",
		},
		{
			name:     "matching final waits for the speculative call in flight",
			debounce: 20 * time.Millisecond,
			delayFor: slowForPartial(300 * time.Millisecond),
			steps: []sttStep{
				{kind: "partial", text: partial, untilSuggest: 1},
				{kind: "final", text: "how are you feeling."},
			},
			wantCalls: 1, wantQuote: partial, wantOutcome: "hit",
		},
		{
			name:     "different final cancels the speculative call and asks again",
			debounce: 20 * time.Millisecond,
			delayFor: slowForPartial(5 * time.Second),
			steps: []sttStep{
				{kind: "partial", text: partial, untilSuggest: 1},
				{kind: "final", text: "How are you feeling about the surgery?"},
			},
			wantCalls: 2, wantQuote: "How are you feeling about the surgery?", wantCanceled: 1, wantOutcome: "miss",
		},
		{
			name:     "new words cancel the speculative call",
			debounce: 20 * time.Millisecond,
			delayFor: slowForPartial(5 * time.Second),
			steps: []sttStep{
				{kind: "partial", text: partial, untilSuggest: 1},
				{kind: "partial", text: partial + " today", untilSuggest: 2},
				{kind: "final", text: partial + " today?"},
			},
			wantCalls: 2, wantQuote: partial + " today", wantCanceled: 1, wantOutcome: "hit",
		},
		{
			// Each partial arrives before the debounce runs out, so none is speculated on, even though the
			// partials together span longer than the debounce.
			name:     "partials changing within the debounce make no call",
			debounce: 300 * time.Millisecond,
			steps: []sttStep{
				{kind: "partial", text: "How", pause: 100 * time.Millisecond},
				{kind: "partial", text: "How are", pause: 100 * time.Millisecond},
				{kind: "partial", text: "How are you", pause: 100 * time.Millisecond},
				{kind: "partial", text: partial, pause: 100 * time.Millisecond},
				{kind: "final", text: "How are you feeling?"},
			},
			wantCalls: 1, wantQuote: "How are you feeling?", wantOutcome: "none",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fm := &fakeModels{sttScript: make(chan string), suggestEcho: true, suggestDelayFor: tc.delayFor}
			o, headset, phone := pairedSession(t, fm, func(o *Orchestrator) { o.speculateAfter = tc.debounce })
			phone.sendAudio(make([]byte, 640)) // opens the STT stream
			for _, st := range tc.steps {
				fm.sttScript <- sttMsg(st.kind, st.text)
				time.Sleep(st.pause)
				if st.untilSuggest > 0 {
					eventually(t, "speculative /suggest call", func() bool { return len(fm.suggestRequests()) >= st.untilSuggest })
				}
			}

			if turn := headset.expectStateTurn("SUGGESTING"); turn != "t_1" {
				t.Fatalf("SUGGESTING turn = %s", turn)
			}
			var sugg protocol.SuggestionsData
			headset.expect(protocol.TypeSuggestions, &sugg, nil)
			for _, it := range sugg.Items {
				if !strings.HasPrefix(it.Text, tc.wantQuote+" / ") || !strings.HasPrefix(it.ID, "s_t_1_") {
					t.Fatalf("suggestion %+v doesn't answer %q in turn t_1", it, tc.wantQuote)
				}
			}
			headset.expectState("CHOOSING")

			eventually(t, "speculative call cancelled", func() bool { return fm.suggestCancelled.Load() >= tc.wantCanceled })
			if n := len(fm.suggestRequests()); n != tc.wantCalls {
				t.Errorf("/suggest calls = %d, want %d", n, tc.wantCalls)
			}
			if n := fm.suggestCancelled.Load(); n != tc.wantCanceled {
				t.Errorf("cancelled /suggest calls = %d, want %d", n, tc.wantCanceled)
			}
			o.writer.flush()
			if got, _ := metricDetails(t, o, metricSpeculation); len(got) != 1 || got[0] != tc.wantOutcome {
				t.Errorf("speculation metric = %v, want [%s]", got, tc.wantOutcome)
			}
			if got, _ := metricDetails(t, o, metricFinalToSuggestions); len(got) != 1 || got[0] != tc.wantOutcome {
				t.Errorf("final_to_suggestions detail = %v, want [%s]", got, tc.wantOutcome)
			}
		})
	}
}

// Partials heard while the user is choosing (or speaking) don't speculate: a final then starts no turn.
func TestNoSpeculationOutsideListening(t *testing.T) {
	fm := &fakeModels{sttScript: make(chan string)}
	_, headset, phone := pairedSession(t, fm, func(o *Orchestrator) { o.speculateAfter = 10 * time.Millisecond })
	phone.sendAudio(make([]byte, 640))
	fm.sttScript <- sttMsg("final", "Hello there")
	headset.expectState("CHOOSING")

	fm.sttScript <- sttMsg("partial", "Are you still there")
	fm.sttScript <- sttMsg("partial", "Are you still there or")
	time.Sleep(100 * time.Millisecond) // well past the debounce
	if n := len(fm.suggestRequests()); n != 1 {
		t.Fatalf("/suggest calls = %d while CHOOSING, want 1 (the turn's own)", n)
	}
}
