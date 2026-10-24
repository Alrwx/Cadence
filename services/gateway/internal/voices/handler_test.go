package voices

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

type fakeCloner struct {
	calls  int
	sample models.VoiceSample
	err    error
}

func (f *fakeCloner) CreateVoice(_ context.Context, sample models.VoiceSample, _ string) (string, error) {
	f.calls++
	f.sample = sample
	if f.err != nil {
		return "", f.err
	}
	return "mlx_voice_1", nil
}

type fakeSetter struct{ voice string }

func (f *fakeSetter) SetVoice(id string) { f.voice = id }

func newHandler(t *testing.T) (*Handler, *fakeCloner, *fakeSetter) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.EnsurePerson(context.Background(), "p1", "Pat", store.DefaultLocale); err != nil {
		t.Fatal(err)
	}
	fc, fs := &fakeCloner{}, &fakeSetter{}
	return &Handler{Store: st, Models: fc, Voices: fs, PersonID: "p1", Locale: store.DefaultLocale}, fc, fs
}

func postConsent(h *Handler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.Consent(rec, httptest.NewRequest(http.MethodPost, "/api/consent", strings.NewReader(body)))
	return rec
}

// upload builds the request the phone sends: audio first, then consentId and sessionId (FormData order).
func upload(h *Handler, audio []byte, fields map[string]string) *httptest.ResponseRecorder {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if audio != nil {
		part, _ := w.CreateFormFile("audio", "sample.webm")
		_, _ = part.Write(audio)
	}
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/voices", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	h.Upload(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	var out map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	return out
}

func grantConsent(t *testing.T, h *Handler) string {
	t.Helper()
	rec := postConsent(h, `{"sessionId":"demo","kind":"voice_clone","voiceOwner":"Alex Rivera","statement":"voice.consentCheck"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("consent: %d %s", rec.Code, rec.Body)
	}
	return decode(t, rec)["consentId"]
}

func TestConsentValidation(t *testing.T) {
	h, _, _ := newHandler(t)
	for name, body := range map[string]string{
		"not json":          `nope`,
		"missing session":   `{"kind":"voice_clone","voiceOwner":"Alex","statement":"voice.consentCheck"}`,
		"store_chat":        `{"sessionId":"demo","kind":"store_chat","voiceOwner":"Alex","statement":"x"}`,
		"blank owner":       `{"sessionId":"demo","kind":"voice_clone","voiceOwner":"  ","statement":"voice.consentCheck"}`,
		"missing statement": `{"sessionId":"demo","kind":"voice_clone","voiceOwner":"Alex"}`,
	} {
		rec := postConsent(h, body)
		if rec.Code != http.StatusBadRequest || decode(t, rec)["code"] != "bad_request" {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body)
		}
	}
	if id := grantConsent(t, h); !strings.HasPrefix(id, "consent_") {
		t.Fatalf("consentId = %q", id)
	}
}

func TestUploadCreatesVoiceAndSwitchesSessions(t *testing.T) {
	h, fc, fs := newHandler(t)
	consent := grantConsent(t, h)

	rec := upload(h, []byte("webm-bytes"), map[string]string{"consentId": consent, "sessionId": "demo"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	if id := decode(t, rec)["voiceId"]; !strings.HasPrefix(id, "voice_") {
		t.Fatalf("voiceId = %q", id)
	}
	if fc.calls != 1 || string(fc.sample.Data) != "webm-bytes" || fc.sample.FileName != "sample.webm" || fc.sample.Transcript != "" {
		t.Fatalf("model service got %+v", fc.sample)
	}
	if fs.voice != "mlx_voice_1" {
		t.Fatalf("sessions switched to %q", fs.voice)
	}
	if v, ok, _ := h.Store.ActiveVoice(context.Background(), "p1"); !ok || v != "mlx_voice_1" {
		t.Fatalf("active voice = %q, %v", v, ok)
	}
}

func TestUploadErrors(t *testing.T) {
	h, fc, fs := newHandler(t)
	consent := grantConsent(t, h)
	ok := map[string]string{"consentId": consent, "sessionId": "demo"}

	cases := []struct {
		name   string
		rec    func() *httptest.ResponseRecorder
		status int
		code   string
	}{
		{"no audio", func() *httptest.ResponseRecorder { return upload(h, nil, ok) }, 400, "bad_request"},
		{"empty audio", func() *httptest.ResponseRecorder { return upload(h, []byte{}, ok) }, 400, "bad_request"},
		{"no session", func() *httptest.ResponseRecorder {
			return upload(h, []byte("x"), map[string]string{"consentId": consent})
		}, 400, "bad_request"},
		{"unknown consent", func() *httptest.ResponseRecorder {
			return upload(h, []byte("x"), map[string]string{"consentId": "consent_nope", "sessionId": "demo"})
		}, 403, "no_consent"},
		{"too large", func() *httptest.ResponseRecorder {
			return upload(h, make([]byte, MaxSampleBytes+1), ok)
		}, 413, "too_large"},
		{"not multipart", func() *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			h.Upload(rec, httptest.NewRequest(http.MethodPost, "/api/voices", strings.NewReader("{}")))
			return rec
		}, 400, "bad_request"},
	}
	for _, tc := range cases {
		rec := tc.rec()
		if rec.Code != tc.status || decode(t, rec)["code"] != tc.code {
			t.Errorf("%s: %d %s, want %d %s", tc.name, rec.Code, rec.Body, tc.status, tc.code)
		}
	}
	if fc.calls != 0 || fs.voice != "" {
		t.Fatalf("rejected uploads reached the model service (%d calls) or switched voice (%q)", fc.calls, fs.voice)
	}

	// A revoked consent is refused like a missing one.
	if _, err := h.Store.DB.Exec(`UPDATE consent SET revoked_at = 1 WHERE id = ?`, consent); err != nil {
		t.Fatal(err)
	}
	if rec := upload(h, []byte("x"), ok); rec.Code != http.StatusForbidden {
		t.Fatalf("revoked consent: %d %s", rec.Code, rec.Body)
	}
}

func TestUploadModelFailure(t *testing.T) {
	h, fc, fs := newHandler(t)
	consent := grantConsent(t, h)
	fc.err = errors.New("POST /voices: 500")
	rec := upload(h, []byte("x"), map[string]string{"consentId": consent, "sessionId": "demo"})
	if rec.Code != http.StatusBadGateway || decode(t, rec)["code"] != "model_error" {
		t.Fatalf("model failure: %d %s", rec.Code, rec.Body)
	}
	if _, ok, _ := h.Store.ActiveVoice(context.Background(), "p1"); ok || fs.voice != "" {
		t.Fatal("a failed clone must not create or switch to a voice")
	}
}
