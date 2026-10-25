package orchestrator

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// Metric names written to the metric table (§2: latency and selection type only, never content).
const (
	metricSuggest            = "suggest"              // /suggest ms; detail ok|error|timeout|cancelled|empty
	metricTTS                = "tts"                  // /tts ms; detail = why: suggestion|instant|saved|typed|warm (":error" on failure)
	metricFinalToSuggestions = "final_to_suggestions" // STT final -> suggestions sent to the headset
	metricSelectToPlay       = "select_to_play"       // selection -> audio.play sent; detail <source>:cached|synthesized
	metricSelection          = "selection"            // count only; detail = source (suggestion|instant|saved|typed)
)

// writeQueueSize bounds how far SQLite writes can fall behind. When it is full, rows are dropped (and logged)
// rather than slowing the WebSocket read loop or the speaking path.
const writeQueueSize = 512

// dbWriter runs metric, session and turn writes on one goroutine, in the order they were queued, so they
// never block event handling. Order matters: a session's row is written before its turns.
type dbWriter struct {
	jobs chan func(context.Context) error
	once sync.Once
	stop chan struct{}
	done chan struct{}
}

func newDBWriter() *dbWriter {
	w := &dbWriter{jobs: make(chan func(context.Context) error, writeQueueSize), stop: make(chan struct{}), done: make(chan struct{})}
	go w.run()
	return w
}

func (w *dbWriter) run() {
	defer close(w.done)
	ctx := context.Background()
	for {
		select {
		case job := <-w.jobs:
			if err := job(ctx); err != nil {
				slog.Error("metrics write", "err", err)
			}
		case <-w.stop:
			// Drain what is already queued, then exit; later enqueues are dropped.
			for {
				select {
				case job := <-w.jobs:
					if err := job(ctx); err != nil {
						slog.Error("metrics write", "err", err)
					}
				default:
					return
				}
			}
		}
	}
}

// enqueue never blocks: a full queue drops the write.
func (w *dbWriter) enqueue(what string, job func(context.Context) error) {
	select {
	case w.jobs <- job:
	default:
		slog.Warn("metrics queue full; dropped a write", "what", what)
	}
}

// flush waits until every write queued before it has run (tests use it before reading the tables).
func (w *dbWriter) flush() {
	ran := make(chan struct{})
	select {
	case w.jobs <- func(context.Context) error { close(ran); return nil }:
	case <-w.done:
		return
	}
	select {
	case <-ran:
	case <-w.done:
	}
}

func (w *dbWriter) close() {
	w.once.Do(func() { close(w.stop) })
	<-w.done
}

// Close finishes the queued metric/session/turn writes. Call it before closing the store.
func (o *Orchestrator) Close() { o.writer.close() }

// record queues one metric. ms < 0 records a count with no value.
func (o *Orchestrator) record(sessionID, name string, ms int64, detail string) {
	m := store.Metric{SessionID: sessionID, Name: name, ValueMs: ms, Detail: detail, TS: time.Now().UnixMilli()}
	o.writer.enqueue(name, func(ctx context.Context) error { return o.store.AddMetric(ctx, m) })
}

func (o *Orchestrator) recordSince(sessionID, name string, start time.Time, detail string) {
	o.record(sessionID, name, time.Since(start).Milliseconds(), detail)
}

// recordTurn queues a turn row. The store keeps the text only with an active store_chat consent.
func (o *Orchestrator) recordTurn(sessionID, speaker, text string) {
	ts := time.Now().UnixMilli()
	o.writer.enqueue("turn", func(ctx context.Context) error {
		return o.store.AddTurn(ctx, sessionID, o.personID, speaker, text, ts)
	})
}

// sessionStarted records that a client connected to the session (creating or reopening its row).
func (o *Orchestrator) sessionStarted(sessionID string) {
	ts := time.Now().UnixMilli()
	o.writer.enqueue("session", func(ctx context.Context) error {
		return o.store.StartSession(ctx, sessionID, o.personID, ts)
	})
}

// OnDisconnect (hub.DisconnectHandler) ends the session's row when its last client has gone.
func (o *Orchestrator) OnDisconnect(s *hub.Session, _ hub.Role, last bool) {
	if !last {
		return
	}
	ts := time.Now().UnixMilli()
	o.writer.enqueue("session", func(ctx context.Context) error { return o.store.EndSession(ctx, s.ID, ts) })
}

// suggestOutcome is the detail for a /suggest metric.
func suggestOutcome(ctx context.Context, err error) string {
	switch {
	case ctx.Err() != nil:
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case err != nil:
		return "error"
	}
	return "ok"
}

// ttsTag rides on the context of a clipFor call so /tts metrics can say why a clip was made, and the
// caller can tell whether its clip came straight from the cache.
type ttsTag struct {
	sessionID string
	purpose   string
	waited    bool // set by clipFor when the clip was not already cached (synthesized now, or joined a synthesis)
}

type ttsTagKey struct{}

func withTTSPurpose(ctx context.Context, sessionID, purpose string) (context.Context, *ttsTag) {
	tag := &ttsTag{sessionID: sessionID, purpose: purpose}
	return context.WithValue(ctx, ttsTagKey{}, tag), tag
}

func ttsTagFrom(ctx context.Context) *ttsTag {
	tag, _ := ctx.Value(ttsTagKey{}).(*ttsTag)
	return tag
}

// ttsPurpose returns the session and purpose a clipFor call was tagged with ("" and "other" if untagged).
func ttsPurpose(ctx context.Context) (sessionID, purpose string) {
	if tag := ttsTagFrom(ctx); tag != nil {
		return tag.sessionID, tag.purpose
	}
	return "", "other"
}

func markWaited(ctx context.Context) {
	if tag := ttsTagFrom(ctx); tag != nil {
		tag.waited = true
	}
}

// spoken records the metrics for one reply that was just sent to the phone, plus its turn row.
func (o *Orchestrator) spoken(sessionID, source, text string, selectedAt time.Time, tag *ttsTag) {
	clip := "cached"
	if tag != nil && tag.waited {
		clip = "synthesized"
	}
	o.recordSince(sessionID, metricSelectToPlay, selectedAt, source+":"+clip)
	o.recordTurn(sessionID, "user", text)
}
