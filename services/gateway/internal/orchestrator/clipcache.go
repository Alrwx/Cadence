package orchestrator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
)

// flight is one in-progress synthesis that concurrent callers for the same key wait on.
type flight struct {
	done chan struct{}
	id   string
	err  error
}

// clipFor returns a clip of text in the current voice and locale, synthesizing it only if no clip exists yet.
// Concurrent requests for the same key share one /tts call (AGENTS(GH).md §7: never synthesize a phrase twice).
func (o *Orchestrator) clipFor(ctx context.Context, text, locale string) (string, error) {
	voice := o.voiceID
	id, ok, err := o.store.ClipID(ctx, voice, locale, text)
	if err != nil {
		return "", err
	}
	if ok && o.clips.Has(id) {
		return id, nil
	}

	key := voice + "\x00" + locale + "\x00" + text
	o.flightMu.Lock()
	if f, ok := o.inflight[key]; ok {
		o.flightMu.Unlock()
		select {
		case <-f.done:
			return f.id, f.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	o.inflight[key] = f
	o.flightMu.Unlock()

	f.id, f.err = o.synthesize(ctx, voice, locale, text, id)

	o.flightMu.Lock()
	delete(o.inflight, key)
	o.flightMu.Unlock()
	close(f.done)
	return f.id, f.err
}

// synthesize calls /tts and records the clip. existingID reuses a DB row whose file went missing.
func (o *Orchestrator) synthesize(ctx context.Context, voice, locale, text, existingID string) (string, error) {
	wav, err := o.models.TTS(ctx, voice, text, locale)
	if err != nil {
		return "", fmt.Errorf("tts: %w", err)
	}
	id := existingID
	if id == "" {
		id = newClipID()
	}
	if err := o.clips.Put(id, wav); err != nil {
		return "", err
	}
	stored, err := o.store.PutClip(ctx, id, voice, locale, text)
	if err != nil {
		return "", err
	}
	slog.Info("clip synthesized", "clip", stored, "chars", len(text))
	return stored, nil
}

func newClipID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "c_" + hex.EncodeToString(b)
}
