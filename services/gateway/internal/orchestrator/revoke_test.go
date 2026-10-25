package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/voices"
)

// The phone's whole voice lifecycle through the real HTTP routes: consent, upload, speak in the clone, revoke,
// and speak in the default voice again.
func TestRevokeFallsBackToTheDefaultVoice(t *testing.T) {
	fm := &fakeModels{}
	o := newTestOrchestrator(t, fm)
	vh := &voices.Handler{Store: o.store, Models: o.models, Voices: o, Clips: o.clips, PersonID: o.personID, Locale: o.locale}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", hub.New(o))
	mux.HandleFunc("POST /api/consent", vh.Consent)
	mux.HandleFunc("POST /api/voices", vh.Upload)
	mux.HandleFunc("DELETE /api/voices", vh.Revoke)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	headset := dial(t, srv.URL, "headset")
	phone := dial(t, srv.URL, "phone")
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	phone.expectState("LISTENING")

	// Record a voice.
	res, err := http.Post(srv.URL+"/api/consent", "application/json",
		strings.NewReader(`{"sessionId":"s1","kind":"voice_clone","voiceOwner":"Alex","statement":"voice.consentCheck"}`))
	if err != nil {
		t.Fatal(err)
	}
	var consent struct{ ConsentID string }
	decodeBody(t, res, http.StatusCreated, &consent)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, _ := form.CreateFormFile("audio", "sample.webm")
	_, _ = part.Write([]byte("webm"))
	_ = form.WriteField("consentId", consent.ConsentID)
	_ = form.WriteField("sessionId", "s1")
	_ = form.Close()
	res, err = http.Post(srv.URL+"/api/voices", form.FormDataContentType(), &body)
	if err != nil {
		t.Fatal(err)
	}
	decodeBody(t, res, http.StatusCreated, nil)

	headset.expectVoice("cloned", true)
	phone.expectVoice("cloned", true)
	o.clipVoice(t, "mlx_cloned", "Yes", sayYes(t, headset, phone))

	// Revoke it.
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/voices", nil)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	decodeBody(t, res, http.StatusNoContent, nil)

	headset.expectVoice("default", false)
	phone.expectVoice("default", false)
	o.clipVoice(t, defaultVoiceID, "Yes", sayYes(t, headset, phone))

	fm.mu.Lock()
	deleted := slices.Clone(fm.deletedVoices)
	fm.mu.Unlock()
	if !slices.Equal(deleted, []string{"mlx_cloned"}) {
		t.Fatalf("model service deletes = %v", deleted)
	}
	// No clip of the voice is left. A warm-up synthesis still in flight during the revoke removes its own clip
	// when it finishes, so allow it a moment.
	deadline := time.Now().Add(2 * time.Second)
	for {
		ids, err := o.store.VoiceClips(context.Background(), "mlx_cloned")
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("clips left in the revoked voice: %v", ids)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A late SetVoice for the revoked voice (an upload that raced the revoke) is ignored.
	o.SetVoice("mlx_cloned")
	if o.voice() != defaultVoiceID {
		t.Fatalf("voice = %q after re-setting a revoked voice", o.voice())
	}
}

// A synthesis that was already running when the consent was revoked doesn't leave a clip behind.
func TestRevokedVoiceIsNotCached(t *testing.T) {
	fm := &fakeModels{delay: 200 * time.Millisecond}
	o := newTestOrchestrator(t, fm)
	o.SetVoice("mlx_cloned")

	done := make(chan error, 1)
	go func() {
		_, err := o.clipIn(context.Background(), "mlx_cloned", "Yes", o.locale)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond) // /tts is running
	o.ForgetVoices([]string{"mlx_cloned"})
	if err := <-done; err == nil {
		t.Fatal("a clip in the revoked voice was returned")
	}
	if ids, _ := o.store.VoiceClips(context.Background(), "mlx_cloned"); len(ids) != 0 {
		t.Fatalf("clips cached in the revoked voice: %v", ids)
	}
	// Speaking still works, in the default voice.
	id, err := o.clipFor(context.Background(), "Yes", o.locale)
	if err != nil {
		t.Fatal(err)
	}
	o.clipVoice(t, defaultVoiceID, "Yes", id)
}

func decodeBody(t *testing.T, res *http.Response, status int, out any) {
	t.Helper()
	defer res.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(res.Body)
	if res.StatusCode != status {
		t.Fatalf("%s %s: %d %s, want %d", res.Request.Method, res.Request.URL.Path, res.StatusCode, buf.String(), status)
	}
	if out != nil {
		if err := json.Unmarshal(buf.Bytes(), out); err != nil {
			t.Fatal(err)
		}
	}
}
