package orchestrator

import (
	"context"
	"log/slog"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
)

// Which voice clips are made in. The person's cloned voice (if they recorded one) is kept apart from their
// choice to speak in the generic voice instead (voice.use, the robot-voice contrast in demo step 6), so
// switching back and forth never loses the cloned voice.

// Values of voice.use's voice and voice's active.
const (
	choiceCloned  = "cloned"
	choiceDefault = "default"
)

// voice is the model service voiceId clips are synthesized in: the cloned voice, unless there is none or the
// person chose the generic one.
func (o *Orchestrator) voice() string {
	o.voiceMu.RLock()
	defer o.voiceMu.RUnlock()
	return o.activeVoiceLocked()
}

func (o *Orchestrator) activeVoiceLocked() string {
	if o.useDefault || o.clonedVoice == "" {
		return defaultVoiceID
	}
	return o.clonedVoice
}

// voiceStatus is the voice event the clients see.
func (o *Orchestrator) voiceStatus() protocol.VoiceData {
	o.voiceMu.RLock()
	defer o.voiceMu.RUnlock()
	return o.voiceStatusLocked()
}

func (o *Orchestrator) voiceStatusLocked() protocol.VoiceData {
	active := choiceCloned
	if o.activeVoiceLocked() == defaultVoiceID {
		active = choiceDefault
	}
	return protocol.VoiceData{Active: active, Cloned: o.clonedVoice != ""}
}

// SetVoice records the person's cloned voice (after an upload, or at startup) and switches to it, clearing a
// choice of the generic voice. An empty id forgets the cloned voice. It doesn't wait for the sessions to be
// refreshed, so a stalled socket can't hold up the caller (the voice upload's HTTP response).
func (o *Orchestrator) SetVoice(modelVoiceID string) {
	o.updateVoice(func() {
		o.clonedVoice = modelVoiceID
		o.useDefault = false
	})
}

// updateVoice applies change under voiceMu. If the active voice or the voice event changed, it refreshes every
// session in the background and reports true.
func (o *Orchestrator) updateVoice(change func()) bool {
	o.voiceMu.Lock()
	beforeVoice, beforeStatus := o.activeVoiceLocked(), o.voiceStatusLocked()
	change()
	changed := o.activeVoiceLocked() != beforeVoice || o.voiceStatusLocked() != beforeStatus
	o.voiceMu.Unlock()
	if changed {
		go o.refreshVoice()
	}
	return changed
}

// useVoice handles voice.use from the phone or the headset.
func (o *Orchestrator) useVoice(ctx context.Context, s *hub.Session, from hub.Role, choice string) {
	var changed bool
	switch choice {
	case choiceDefault:
		changed = o.updateVoice(func() { o.useDefault = true })
	case choiceCloned:
		have := false
		changed = o.updateVoice(func() {
			if have = o.clonedVoice != ""; have {
				o.useDefault = false
			}
		})
		if !have {
			o.sendErrorTo(ctx, s, from, "no_cloned_voice", "There's no recorded voice yet. Record one on the phone first.")
		}
	default:
		slog.Warn("unknown voice choice ignored", "session", s.ID, "voice", choice)
	}
	if !changed {
		// Nothing to refresh, but the sender's toggle may be out of date: tell it where things stand.
		_ = s.Send(ctx, from, protocol.TypeVoice, "", o.voiceStatus())
	}
}

// loseVoice handles /tts not knowing the cloned voice (its files were wiped on the model service): speak in
// the generic voice from now on instead of failing every clip, and tell the user why. Only the first request
// to hit it reports it.
func (o *Orchestrator) loseVoice(voice string) {
	lost := false
	o.updateVoice(func() {
		if o.clonedVoice == voice {
			o.clonedVoice, o.useDefault, lost = "", false, true
		}
	})
	if !lost {
		return
	}
	slog.Warn("model service doesn't know the cloned voice; using the default voice", "model_voice", voice)
	go func() {
		ctx := context.Background()
		for _, s := range o.hubSessions() {
			o.sendError(ctx, s, "voice_missing",
				"Your recorded voice is missing, so the generic voice is being used. Record it again on the phone.")
		}
	}()
}

// refreshVoice tells every session about the current voice, resends phrases (audioReady is per voice), and
// warms clips in the voice now in use. Runs in the background; overlapping calls coalesce, and the last one
// to run reads the newest voice, so clients never end on a stale voice event.
func (o *Orchestrator) refreshVoice() {
	o.voiceDirty.Store(true)
	for o.voiceDirty.Load() && o.voiceRefreshing.CompareAndSwap(false, true) {
		o.voiceDirty.Store(false)
		ctx := context.Background()
		status := o.voiceStatus()
		for _, s := range o.hubSessions() {
			s.Broadcast(ctx, protocol.TypeVoice, "", status)
			o.sendPhrases(ctx, s)
		}
		o.voiceRefreshing.Store(false)
	}
	if len(o.hubSessions()) > 0 {
		o.warmClips()
	}
}
