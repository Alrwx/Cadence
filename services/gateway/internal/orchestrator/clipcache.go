package orchestrator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"

	"github.com/Alrwx/Cadence/services/gateway/internal/models"
)

// flight is one in-progress synthesis that concurrent callers for the same key wait on.
type flight struct {
	done chan struct{}
	id   string
	err  error
}

// clipFor returns a clip of text in the current voice and locale, synthesizing it only if no clip exists yet.
// If the model service no longer knows the cloned voice, it switches to the default voice for good (loseVoice)
// and makes the clip in that instead, so the user can still speak.
func (o *Orchestrator) clipFor(ctx context.Context, text, locale string) (string, error) {
	voice := o.voice()
	id, err := o.clipIn(ctx, voice, text, locale)
	if voice != defaultVoiceID && errors.Is(err, models.ErrUnknownVoice) {
		o.loseVoice(voice)
		return o.clipIn(ctx, defaultVoiceID, text, locale)
	}
	return id, err
}

// clipIn returns a clip of text in voice. Concurrent requests for the same key share one /tts call
// (AGENTS(GH).md §7: never synthesize a phrase twice).
func (o *Orchestrator) clipIn(ctx context.Context, voice, text, locale string) (string, error) {
	if o.isRevoked(voice) {
		return "", errRevoked(voice)
	}
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
	// The consent may have been revoked while /tts ran. ForgetVoices happens before the revoke deletes the
	// voice's clips, so either that delete sees this clip, or this check sees the revoke and removes it here.
	if o.isRevoked(voice) {
		_ = o.store.DeleteVoiceClips(ctx, voice, []string{stored})
		_ = o.clips.Remove(id)
		_ = o.clips.Remove(stored)
		return "", errRevoked(voice)
	}
	slog.Info("clip synthesized", "clip", stored, "chars", len(text))
	return stored, nil
}

// errRevoked is returned for a voice whose consent was revoked. It counts as an unknown voice, so clipFor
// makes the clip in the default voice instead.
func errRevoked(voice string) error {
	return fmt.Errorf("%w %q: consent revoked", models.ErrUnknownVoice, voice)
}

func newClipID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "c_" + hex.EncodeToString(b)
}
