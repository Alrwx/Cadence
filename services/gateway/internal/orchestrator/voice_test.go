package orchestrator

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
)

// voiceSession is pairedSession for a person whose recorded voice is cloned ("" for none), set at startup as
// main does. It returns the voice event the phone got on connect; the headset's is left unread.
func voiceSession(t *testing.T, fm *fakeModels, cloned string) (o *Orchestrator, headset, phone *client, onConnect protocol.VoiceData) {
	t.Helper()
	o = newTestOrchestrator(t, fm)
	if cloned != "" {
		o.SetVoice(cloned)
	}
	srv := httptest.NewServer(hub.New(o))
	t.Cleanup(srv.Close)
	headset = dial(t, srv.URL, "headset")
	phone = dial(t, srv.URL, "phone")
	phone.expect(protocol.TypeVoice, &onConnect, nil) // sent right after state on connect
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	phone.expectState("LISTENING")
	return o, headset, phone, onConnect
}

func (c *client) expectVoice(active string, cloned bool) {
	c.t.Helper()
	var v protocol.VoiceData
	c.expect(protocol.TypeVoice, &v, func() bool { return v.Active == active && v.Cloned == cloned })
}

// sayYes makes the headset say the instant "Yes" and returns the clip the phone was told to play.
func sayYes(t *testing.T, headset, phone *client) string {
	t.Helper()
	headset.send(protocol.TypeInstant, protocol.InstantData{PhraseID: "yes"})
	var play protocol.AudioPlayData
	phone.expect(protocol.TypeAudioPlay, &play, nil)
	if play.Text != "Yes" {
		t.Fatalf("audio.play = %+v", play)
	}
	phone.send(protocol.TypeAudioDone, protocol.AudioDoneData{ClipID: play.ClipID})
	phone.expectState("LISTENING")
	return play.ClipID
}

func (o *Orchestrator) clipVoice(t *testing.T, voice, text, clipID string) {
	t.Helper()
	id, ok, err := o.store.ClipID(context.Background(), voice, o.locale, text)
	if err != nil || !ok || id != clipID {
		t.Fatalf("clip %s for %q isn't the %s voice's (that one is %q, ok=%v, err=%v)", clipID, text, voice, id, ok, err)
	}
}

// Demo step 6: switch to the generic voice for contrast, then back to the cloned one.
func TestVoiceUseSwitchesBetweenClonedAndDefault(t *testing.T) {
	fm := &fakeModels{}
	o, headset, phone, phoneVoice := voiceSession(t, fm, "mlx_cloned")

	// Both clients learn the voice on connect.
	headset.expectVoice("cloned", true)
	if phoneVoice != (protocol.VoiceData{Active: "cloned", Cloned: true}) {
		t.Fatalf("phone's voice on connect = %+v", phoneVoice)
	}
	o.clipVoice(t, "mlx_cloned", "Yes", sayYes(t, headset, phone))

	// The phone picks the generic voice: everyone hears about it, the headset's phrases are resent (they're not
	// ready in that voice yet), and the next "Yes" is synthesized in it.
	phone.send(protocol.TypeVoiceUse, protocol.VoiceUseData{Voice: "default"})
	phone.expectVoice("default", true)
	headset.expectVoice("default", true)
	var phrases protocol.PhrasesData
	headset.expect(protocol.TypePhrases, &phrases, nil)
	o.clipVoice(t, defaultVoiceID, "Yes", sayYes(t, headset, phone))
	if fm.ttsCallsFor(defaultVoiceID) == 0 {
		t.Fatal("no /tts call with voiceId default")
	}
	if o.voice() != defaultVoiceID {
		t.Fatalf("voice = %q", o.voice())
	}

	// And back, from the headset this time.
	headset.send(protocol.TypeVoiceUse, protocol.VoiceUseData{Voice: "cloned"})
	headset.expectVoice("cloned", true)
	phone.expectVoice("cloned", true)
	o.clipVoice(t, "mlx_cloned", "Yes", sayYes(t, headset, phone))

	// Recording a new voice replaces the cloned one and clears a choice of the generic voice.
	phone.send(protocol.TypeVoiceUse, protocol.VoiceUseData{Voice: "default"})
	phone.expectVoice("default", true)
	o.SetVoice("mlx_newer")
	phone.expectVoice("cloned", true)
	if o.voice() != "mlx_newer" {
		t.Fatalf("voice after a new recording = %q", o.voice())
	}
}

func TestVoiceUseClonedWithoutARecordedVoice(t *testing.T) {
	fm := &fakeModels{}
	o, headset, phone, phoneVoice := voiceSession(t, fm, "")
	headset.expectVoice("default", false)
	if phoneVoice != (protocol.VoiceData{Active: "default", Cloned: false}) {
		t.Fatalf("phone's voice on connect = %+v", phoneVoice)
	}

	phone.send(protocol.TypeVoiceUse, protocol.VoiceUseData{Voice: "cloned"})
	var errData protocol.ErrorData
	phone.expect(protocol.TypeError, &errData, nil)
	if errData.Code != "no_cloned_voice" || !errData.Recoverable {
		t.Fatalf("error = %+v", errData)
	}
	phone.expectVoice("default", false) // the sender's toggle is put back
	if o.voice() != defaultVoiceID {
		t.Fatalf("voice = %q", o.voice())
	}
}

// If the model service lost the cloned voice (/tts 404), the clip is made in the default voice instead and
// the gateway stays on it, rather than failing everything the user says.
func TestLostVoiceFallsBackToDefault(t *testing.T) {
	fm := &fakeModels{missingVoice: "mlx_gone"}
	o := newTestOrchestrator(t, fm)
	o.SetVoice("mlx_gone")

	id, err := o.clipFor(context.Background(), "Yes", o.locale)
	if err != nil {
		t.Fatalf("clipFor: %v", err)
	}
	o.clipVoice(t, defaultVoiceID, "Yes", id)
	if got := o.voiceStatus(); got != (protocol.VoiceData{Active: "default", Cloned: false}) {
		t.Fatalf("voice after the loss = %+v", got)
	}
	// From then on nothing asks for the lost voice.
	before := fm.ttsCallsFor("mlx_gone")
	if _, err := o.clipFor(context.Background(), "No", o.locale); err != nil {
		t.Fatal(err)
	}
	if fm.ttsCallsFor("mlx_gone") != before {
		t.Fatal("the lost voice was asked for again")
	}
}

func TestLostVoiceTellsTheUser(t *testing.T) {
	fm := &fakeModels{missingVoice: "mlx_gone"}
	o, headset, phone, phoneVoice := voiceSession(t, fm, "mlx_gone")

	// The headset's warm-up hits the 404 first; the user is told, and both clients see the switch.
	// They're sent separately, so either may come first.
	var gotError, gotVoice bool
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for !gotError || !gotVoice {
		_, msg, err := headset.conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for the error and the voice switch (error %v, voice %v): %v", gotError, gotVoice, err)
		}
		var env protocol.Envelope
		_ = json.Unmarshal(msg, &env)
		switch env.Type {
		case protocol.TypeError:
			var e protocol.ErrorData
			_ = json.Unmarshal(env.Data, &e)
			if e.Code != "voice_missing" || !e.Recoverable {
				t.Fatalf("error = %+v", e)
			}
			gotError = true
		case protocol.TypeVoice:
			var v protocol.VoiceData
			_ = json.Unmarshal(env.Data, &v)
			gotVoice = gotVoice || v == (protocol.VoiceData{Active: "default", Cloned: false})
		}
	}
	if phoneVoice.Active == "cloned" { // the phone connected before the loss
		phone.expectVoice("default", false)
	}
	o.clipVoice(t, defaultVoiceID, "Yes", sayYes(t, headset, phone))
}
