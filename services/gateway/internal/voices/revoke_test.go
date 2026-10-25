package voices

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/Alrwx/Cadence/services/gateway/internal/clips"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

func revoke(h *Handler, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodDelete, "https://10.0.0.5:8443/api/voices", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	h.Revoke(rec, req)
	return rec
}

// recordVoice grants a consent, uploads a sample, and caches one clip in the new voice, as warm-up would.
func recordVoice(t *testing.T, h *Handler, fc *fakeCloner) (consentID, modelVoiceID, clipID string) {
	t.Helper()
	consentID = grantConsent(t, h)
	if rec := upload(h, []byte("webm"), map[string]string{"consentId": consentID, "sessionId": "demo"}); rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	modelVoiceID = fmt.Sprintf("mlx_voice_%d", fc.calls)
	return consentID, modelVoiceID, putClip(t, h, modelVoiceID, "Yes")
}

func putClip(t *testing.T, h *Handler, voice, text string) string {
	t.Helper()
	id := "c_" + voice + "_" + fmt.Sprint(len(text))
	if err := h.Clips.(*clips.Cache).Put(id, []byte("RIFF")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Store.PutClip(context.Background(), id, voice, store.DefaultLocale, text); err != nil {
		t.Fatal(err)
	}
	return id
}

func clipExists(t *testing.T, h *Handler, voice, text string) (row, file bool) {
	t.Helper()
	id, ok, err := h.Store.ClipID(context.Background(), voice, store.DefaultLocale, text)
	if err != nil {
		t.Fatal(err)
	}
	return ok, ok && h.Clips.(*clips.Cache).Has(id)
}

func TestRevokeDeletesVoicesAndClips(t *testing.T) {
	h, fc, fs := newHandler(t)
	ctx := context.Background()
	first, v1, c1 := recordVoice(t, h, fc)
	second, v2, _ := recordVoice(t, h, fc)
	defaultClip := putClip(t, h, defaultVoiceID, "Yes")
	chat, err := h.Store.CreateConsent(ctx, "p1", store.ConsentStoreChat, "", "")
	if err != nil {
		t.Fatal(err)
	}

	rec := revoke(h, "https://10.0.0.5:8443")
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("revoke: %d %q", rec.Code, rec.Body)
	}

	// Both consents are revoked (the rows stay, as the record) and the store_chat consent is untouched.
	for _, id := range []string{first, second} {
		if err := h.Store.ActiveConsent(ctx, "p1", id, store.ConsentVoiceClone); err == nil {
			t.Errorf("consent %s still active", id)
		}
	}
	if err := h.Store.ActiveConsent(ctx, "p1", chat, store.ConsentStoreChat); err != nil {
		t.Errorf("store_chat consent touched: %v", err)
	}
	// Each voice is gone from the model service, the sessions, the clip cache (row and file), and the profiles.
	if !slices.Equal(fc.deleted, []string{v1, v2}) {
		t.Errorf("model service deletes = %v, want %v", fc.deleted, []string{v1, v2})
	}
	if !slices.Contains(fs.forgotten, v1) || !slices.Contains(fs.forgotten, v2) || fs.voice != "" {
		t.Errorf("sessions: forgot %v, still on %q", fs.forgotten, fs.voice)
	}
	for _, v := range []string{v1, v2} {
		if row, file := clipExists(t, h, v, "Yes"); row || file {
			t.Errorf("%s clip left: row %v, file %v", v, row, file)
		}
	}
	if h.Clips.(*clips.Cache).Has(c1) {
		t.Error("clip file left on disk")
	}
	if left, _ := h.Store.RevokedVoiceProfiles(ctx, "p1"); len(left) != 0 {
		t.Errorf("voice profiles left: %+v", left)
	}
	if _, ok, _ := h.Store.ActiveVoice(ctx, "p1"); ok {
		t.Error("a voice is still active")
	}
	// The default voice is nobody's and stays.
	if row, file := clipExists(t, h, defaultVoiceID, "Yes"); !row || !file {
		t.Errorf("default voice clip %s deleted: row %v, file %v", defaultClip, row, file)
	}

	// The revoked consent can't make a new voice, and revoking again is a no-op.
	if rec := upload(h, []byte("x"), map[string]string{"consentId": first, "sessionId": "demo"}); rec.Code != http.StatusForbidden {
		t.Fatalf("upload with a revoked consent: %d %s", rec.Code, rec.Body)
	}
	if rec := revoke(h, ""); rec.Code != http.StatusNoContent || len(fc.deleted) != 2 {
		t.Fatalf("second revoke: %d, model deletes %v", rec.Code, fc.deleted)
	}
}

// If the model service can't delete its copy, everything local still goes, and a retry finishes the job.
func TestRevokeModelFailureIsRetried(t *testing.T) {
	h, fc, _ := newHandler(t)
	ctx := context.Background()
	_, v1, _ := recordVoice(t, h, fc)

	fc.deleteErr = fmt.Errorf("DELETE /voices: %w", models.ErrUnavailable)
	rec := revoke(h, "")
	if rec.Code != http.StatusBadGateway || decode(t, rec)["code"] != "model_error" {
		t.Fatalf("revoke with the model service down: %d %s", rec.Code, rec.Body)
	}
	if _, ok, _ := h.Store.ActiveVoice(ctx, "p1"); ok {
		t.Fatal("the voice is still usable after a failed revoke")
	}
	if row, file := clipExists(t, h, v1, "Yes"); row || file {
		t.Fatalf("clips kept after a failed model delete: row %v, file %v", row, file)
	}
	if left, _ := h.Store.RevokedVoiceProfiles(ctx, "p1"); len(left) != 1 || left[0].ModelVoiceID != v1 {
		t.Fatalf("the profile must stay as the record of what to delete: %+v", left)
	}

	fc.deleteErr = nil
	if rec := revoke(h, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("retry: %d %s", rec.Code, rec.Body)
	}
	if !slices.Equal(fc.deleted, []string{v1, v1}) {
		t.Fatalf("model service deletes = %v, want the retry to ask again", fc.deleted)
	}
	if left, _ := h.Store.RevokedVoiceProfiles(ctx, "p1"); len(left) != 0 {
		t.Fatalf("profiles left after the retry: %+v", left)
	}
}

func TestRevokeRejectsOtherOrigins(t *testing.T) {
	h, fc, _ := newHandler(t)
	consent, _, _ := recordVoice(t, h, fc)
	rec := revoke(h, "https://evil.example")
	if rec.Code != http.StatusForbidden || decode(t, rec)["code"] != "bad_origin" {
		t.Fatalf("cross-origin revoke: %d %s", rec.Code, rec.Body)
	}
	if err := h.Store.ActiveConsent(context.Background(), "p1", consent, store.ConsentVoiceClone); err != nil || len(fc.deleted) != 0 {
		t.Fatalf("a cross-origin request revoked something: %v, deletes %v", err, fc.deleted)
	}
}

// A voice the gateway couldn't record a profile for is deleted from the model service, since nothing else
// would ever delete it.
func TestUploadDeletesVoiceItCouldNotSave(t *testing.T) {
	h, fc, fs := newHandler(t)
	fields := func(consent string) map[string]string {
		return map[string]string{"consentId": consent, "sessionId": "demo"}
	}

	// The consent is withdrawn while the model service clones.
	consent := grantConsent(t, h)
	fc.during = func() {
		if rec := revoke(h, ""); rec.Code != http.StatusNoContent {
			t.Errorf("revoke: %d %s", rec.Code, rec.Body)
		}
	}
	rec := upload(h, []byte("x"), fields(consent))
	if rec.Code != http.StatusForbidden || decode(t, rec)["code"] != "no_consent" {
		t.Fatalf("upload that raced a revoke: %d %s", rec.Code, rec.Body)
	}
	if !slices.Equal(fc.deleted, []string{"mlx_voice_1"}) || fs.voice != "" {
		t.Fatalf("model deletes %v, sessions on %q; want the new voice deleted and unused", fc.deleted, fs.voice)
	}
	if _, ok, _ := h.Store.ActiveVoice(context.Background(), "p1"); ok {
		t.Fatal("a voice was saved under a revoked consent")
	}

	// The database fails after the clone.
	consent = grantConsent(t, h)
	fc.during = func() { h.Store.DB.Close() }
	rec = upload(h, []byte("x"), fields(consent))
	if rec.Code != http.StatusInternalServerError || decode(t, rec)["code"] != "storage_failed" {
		t.Fatalf("upload with the database gone: %d %s", rec.Code, rec.Body)
	}
	if !slices.Equal(fc.deleted, []string{"mlx_voice_1", "mlx_voice_2"}) || fs.voice != "" {
		t.Fatalf("model deletes %v, sessions on %q", fc.deleted, fs.voice)
	}
}
