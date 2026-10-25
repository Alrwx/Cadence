package orchestrator

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/session"
)

// Speculation (AGENTS(GH).md §3): while the other person is still talking, call /suggest on the partial
// transcript once it has had no new words for speculateAfter. If the final then says the same thing, its turn
// reuses that answer instead of waiting for a second /suggest. A speculative answer is never shown on its own:
// it only becomes suggestions through the normal final -> beginTurn -> SUGGESTING -> suggest path.

const speculateAfter = 400 * time.Millisecond // default debounce: no new words for this long

// Metric for each turn: did the final reuse a speculative /suggest?
const metricSpeculation = "speculation" // count only; detail hit|miss|none|failed

// speculator is one session's speculation state. Lock order: spec.mu before ss.mu, never the other way.
type speculator struct {
	mu    sync.Mutex
	key   string // normalized text of the latest partial
	raw   string // the latest partial as heard
	gen   int    // bumped whenever the partial changes or the speculation is taken, so stale timers do nothing
	timer *time.Timer
	call  *specCall // the speculative /suggest for key, in flight or done
}

// specCall is one speculative /suggest. resp and err are set before done is closed.
type specCall struct {
	key     string
	history []models.Turn // exactly what was sent, ending with the partial
	cancel  context.CancelFunc
	done    chan struct{}
	resp    models.SuggestResponse
	err     error
}

func (o *Orchestrator) speculationDelay() time.Duration {
	if o.speculateAfter > 0 {
		return o.speculateAfter
	}
	return speculateAfter
}

// normalizeUtterance is the speculation matching rule: case, whitespace and punctuation don't count, except
// apostrophes inside words ("it's" stays different from "its"). See docs/decisions.md.
func normalizeUtterance(text string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(text) {
		switch {
		case r == '\'' || r == '’':
			b.WriteRune('\'')
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	words := strings.Fields(b.String())
	for i, w := range words {
		words[i] = strings.Trim(w, "'") // quotes, not contractions
	}
	return strings.Join(slices.DeleteFunc(words, func(w string) bool { return w == "" }), " ")
}

// onPartial restarts the debounce whenever the partial transcript gains or changes words. A speculative call
// for older words is cancelled right away. Partials outside LISTENING (choosing, composing, speaking) don't
// speculate: a final then doesn't start a turn, or is the phone's own speaker.
func (o *Orchestrator) onPartial(s *hub.Session, ss *sessionState, text string) {
	key := normalizeUtterance(text)
	if key == "" {
		return
	}
	if o.stateOf(ss) != session.Listening {
		o.dropSpeculation(ss)
		return
	}
	sp := &ss.spec
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if key == sp.key {
		return // no new words: let the debounce run out
	}
	sp.key, sp.raw = key, text
	sp.gen++
	if sp.call != nil {
		sp.call.cancel()
		sp.call = nil
	}
	if sp.timer != nil {
		sp.timer.Stop()
	}
	gen := sp.gen
	sp.timer = time.AfterFunc(o.speculationDelay(), func() { o.speculate(s, ss, gen) })
}

// speculate starts the speculative /suggest when the debounce for generation gen runs out.
func (o *Orchestrator) speculate(s *hub.Session, ss *sessionState, gen int) {
	sp := &ss.spec
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.gen != gen || sp.call != nil {
		return
	}
	ss.mu.Lock()
	listening := ss.machine.State() == session.Listening
	nextTurn := fmt.Sprintf("t_%d", ss.turnSeq+1) // the id beginTurn will give this utterance's turn
	history := append(append([]models.Turn(nil), ss.history...), models.Turn{Speaker: "other", Text: sp.raw})
	ss.mu.Unlock()
	if !listening {
		return
	}
	history = history[max(0, len(history)-historySent):]

	ctx, cancel := context.WithCancel(context.Background())
	c := &specCall{key: sp.key, history: history, cancel: cancel, done: make(chan struct{})}
	sp.call = c
	go func() {
		start := time.Now()
		c.resp, c.err = o.models.Suggest(ctx, models.SuggestRequest{
			TurnID: nextTurn, History: c.history, Style: models.Style{Phrases: []string{}}, N: suggestCount,
		})
		o.recordSince(s.ID, metricSuggest, start, "spec:"+suggestOutcome(ctx, c.err))
		close(c.done)
	}()
}

// takeSpeculation ends the current utterance's speculation and returns its call, if any, for the caller to
// reuse or cancel. A debounce still pending is stopped.
func (o *Orchestrator) takeSpeculation(ss *sessionState) *specCall {
	sp := &ss.spec
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.timer != nil {
		sp.timer.Stop()
		sp.timer = nil
	}
	sp.gen++
	sp.key, sp.raw = "", ""
	c := sp.call
	sp.call = nil
	return c
}

// dropSpeculation cancels any speculation in progress.
func (o *Orchestrator) dropSpeculation(ss *sessionState) {
	if c := o.takeSpeculation(ss); c != nil {
		c.cancel()
	}
}

// matchSpeculation decides whether the final's turn can reuse c: the final must normalize to the same words
// as the speculated partial, and the turns before it must be the ones the speculative call was sent. A call
// that already failed isn't reused. Calls that don't match are cancelled. It returns the call to reuse (or nil)
// and the speculation metric's detail.
func matchSpeculation(c *specCall, final string, history []models.Turn) (*specCall, string) {
	if c == nil {
		return nil, "none"
	}
	n := len(history)
	if c.key != normalizeUtterance(final) || len(c.history) != n || n == 0 || !slices.Equal(c.history[:n-1], history[:n-1]) {
		c.cancel()
		return nil, "miss"
	}
	select {
	case <-c.done:
		if c.err != nil {
			return nil, "failed"
		}
	default:
	}
	return c, "hit"
}
