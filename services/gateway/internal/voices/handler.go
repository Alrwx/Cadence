// Package voices serves the phone's voice setup: POST /api/consent stores a voice-clone consent record,
// POST /api/voices takes a recorded or picked sample, checks the consent, and has the model service clone it,
// and DELETE /api/voices withdraws the consent and deletes the voice with all of its clips.
// The sample goes only to the model service on localhost (AGENTS(GH).md §2) and is not kept by the gateway.
package voices

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strings"

	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// MaxSampleBytes caps an upload: plenty for a 30 s phone video.
const MaxSampleBytes = 25 << 20

const (
	maxConsentBytes = 16 << 10
	maxFieldBytes   = 4 << 10
	// Multipart headers and the small text fields ride on top of the file.
	multipartOverhead = 64 << 10
)

// Cloner creates and deletes voices in the model service.
type Cloner interface {
	CreateVoice(ctx context.Context, sample models.VoiceSample, consentID string) (string, error)
	DeleteVoice(ctx context.Context, modelVoiceID string) error
}

// VoiceSetter switches the live sessions' voice and language. No method may block on the sessions' sockets:
// they run inside an HTTP request.
type VoiceSetter interface {
	SetVoice(modelVoiceID string)
	// ForgetVoices stops using voices whose consent was revoked and stops caching clips in them.
	ForgetVoices(modelVoiceIDs []string)
	// Locale is the language conversations run in; SetLocale switches it (after a voice is made in another one).
	Locale() string
	SetLocale(ctx context.Context, locale string) error
}

// ClipRemover deletes cached clip files.
type ClipRemover interface {
	Remove(clipID string) error
}

type Handler struct {
	Store    *store.Store
	Models   Cloner
	Voices   VoiceSetter
	Clips    ClipRemover
	PersonID string // single-user for the hackathon: every session belongs to this person
	// Locales lists the languages a sample may be in (orchestrator.SupportedLocales); empty accepts any.
	Locales []string
	// OriginPatterns lists extra allowed browser origins (the Vite dev servers), the same as the /ws hub.
	OriginPatterns []string
}

// allowOrigin applies the /ws origin rule to these routes: same-origin and OriginPatterns pass, other web pages
// don't. Without it, any page opened on the demo hotspot could post a consent and swap in a different voice,
// since a JSON-as-text/plain or multipart POST is a "simple" request that browsers send without a preflight.
// Requests without an Origin header (curl, tests, the model tooling) are not from a browser page and pass.
func (h *Handler) allowOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err == nil && u.Host != "" {
		host := strings.ToLower(u.Host)
		if host == strings.ToLower(r.Host) {
			return true
		}
		for _, pattern := range h.OriginPatterns {
			if ok, _ := path.Match(strings.ToLower(pattern), host); ok {
				return true
			}
		}
	}
	slog.Warn("blocked cross-origin request", "path", r.URL.Path, "origin", origin)
	writeError(w, http.StatusForbidden, "bad_origin", "Requests from this page aren't allowed.")
	return false
}

type consentRequest struct {
	SessionID  string `json:"sessionId"`
	Kind       string `json:"kind"`
	VoiceOwner string `json:"voiceOwner"`
	Statement  string `json:"statement"`
}

// Consent handles POST /api/consent.
func (h *Handler) Consent(w http.ResponseWriter, r *http.Request) {
	if !h.allowOrigin(w, r) {
		return
	}
	// JSON only: a text/plain body is how a cross-site "no-cors" fetch would get past the browser.
	if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "bad_request", "Send the consent as application/json.")
		return
	}
	var req consentRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxConsentBytes))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "Couldn't read the consent request.")
		return
	}
	if strings.TrimSpace(req.SessionID) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "Missing sessionId.")
		return
	}
	// Only voice cloning is consented from the phone; store_chat has its own flow.
	if req.Kind != store.ConsentVoiceClone {
		writeError(w, http.StatusBadRequest, "bad_request", `kind must be "voice_clone".`)
		return
	}
	id, err := h.Store.CreateConsent(r.Context(), h.PersonID, req.Kind, req.VoiceOwner, req.Statement)
	if errors.Is(err, store.ErrInvalid) {
		writeError(w, http.StatusBadRequest, "bad_request", "Say whose voice this is, and agree to the consent text.")
		return
	}
	if err != nil {
		slog.Error("create consent", "err", err)
		writeError(w, http.StatusInternalServerError, "storage_failed", "Couldn't save the consent.")
		return
	}
	slog.Info("voice consent granted", "consent", id, "session", req.SessionID)
	writeJSON(w, http.StatusCreated, map[string]string{"consentId": id})
}

// Upload handles POST /api/voices (multipart: audio, consentId, sessionId, optional transcript and locale).
// locale is the language spoken in the sample (default: the current language); once the voice is made, the
// whole app switches to it.
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	if !h.allowOrigin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxSampleBytes+multipartOverhead)
	form, err := readForm(r)
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig) || errors.Is(err, errSampleTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "The sample is over 25 MB.")
		return
	case err != nil:
		writeError(w, http.StatusBadRequest, "bad_request", "Couldn't read the upload: "+err.Error())
		return
	}
	switch {
	case len(form.sample.Data) == 0:
		writeError(w, http.StatusBadRequest, "bad_request", "Missing or empty audio.")
		return
	case form.consentID == "" || form.sessionID == "":
		writeError(w, http.StatusBadRequest, "bad_request", "Missing consentId or sessionId.")
		return
	case form.sample.Locale == "":
		form.sample.Locale = h.Voices.Locale()
	case len(h.Locales) > 0 && !slices.Contains(h.Locales, form.sample.Locale):
		writeError(w, http.StatusBadRequest, "unsupported_language", "That language isn't available yet.")
		return
	}

	// No voice is created without a stored, unrevoked consent record (§2).
	if err := h.Store.ActiveConsent(r.Context(), h.PersonID, form.consentID, store.ConsentVoiceClone); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusForbidden, "no_consent", "No consent record for this voice.")
			return
		}
		slog.Error("check consent", "err", err)
		writeError(w, http.StatusInternalServerError, "storage_failed", "Couldn't check the consent.")
		return
	}

	modelVoiceID, err := h.Models.CreateVoice(r.Context(), form.sample, form.consentID)
	if err != nil {
		slog.Error("create voice", "consent", form.consentID, "bytes", len(form.sample.Data), "err", err)
		// A model service that is down or still loading isn't the sample's fault: say to retry, not re-record.
		if errors.Is(err, models.ErrUnavailable) {
			writeError(w, http.StatusServiceUnavailable, "models_unavailable", "The voice model is still starting. Try again in a minute.")
			return
		}
		writeError(w, http.StatusBadGateway, "model_error", "The voice model couldn't use that sample. Try again or use another recording.")
		return
	}
	profileID, err := h.Store.CreateVoiceProfile(r.Context(), h.PersonID, form.consentID, modelVoiceID, form.sample.Locale)
	if err != nil {
		// No profile means nothing would ever delete the model service's copy: delete it now.
		h.deleteModelVoice(context.WithoutCancel(r.Context()), modelVoiceID)
		if errors.Is(err, store.ErrNotFound) { // the consent was revoked while the model service was cloning
			writeError(w, http.StatusForbidden, "no_consent", "The consent for this voice was withdrawn.")
			return
		}
		slog.Error("save voice profile", "err", err)
		writeError(w, http.StatusInternalServerError, "storage_failed", "The voice was made but couldn't be saved.")
		return
	}
	h.Voices.SetVoice(modelVoiceID)
	// The voice is made either way; a language that can't be saved just stays as it was.
	if err := h.Voices.SetLocale(context.WithoutCancel(r.Context()), form.sample.Locale); err != nil {
		slog.Error("switch to the sample's language", "locale", form.sample.Locale, "err", err)
	}
	slog.Info("voice created", "locale", form.sample.Locale, "voice", profileID, "model_voice", modelVoiceID, "session", form.sessionID, "bytes", len(form.sample.Data))
	writeJSON(w, http.StatusCreated, map[string]string{"voiceId": profileID})
}

func (h *Handler) deleteModelVoice(ctx context.Context, modelVoiceID string) {
	if err := h.Models.DeleteVoice(ctx, modelVoiceID); err != nil {
		slog.Error("delete unsaved voice from the model service", "model_voice", modelVoiceID, "err", err)
	}
}

// Revoke handles DELETE /api/voices: the person withdraws voice-clone consent (AGENTS(GH).md §2). Every
// unrevoked voice_clone consent is revoked, and every voice under a revoked consent is deleted: the model
// service's copy, its cached clips (rows and WAV files), and its profile. Sessions fall back to the default voice.
//
// Revoking comes first, so a failure at any later step never leaves a usable voice. If the model service can't
// delete its copy, everything local still goes except the profile row, which is kept as the record of what to
// delete, and the answer is 502: calling DELETE again finishes the job.
func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	if !h.allowOrigin(w, r) {
		return
	}
	// Finish even if the phone goes away mid-request: stopping halfway would only leave work for a retry.
	ctx := context.WithoutCancel(r.Context())
	revoked, err := h.Store.RevokeVoiceConsents(ctx, h.PersonID)
	if err != nil {
		slog.Error("revoke voice consent", "err", err)
		writeError(w, http.StatusInternalServerError, "storage_failed", "Couldn't withdraw the consent. Try again.")
		return
	}
	profiles, err := h.Store.RevokedVoiceProfiles(ctx, h.PersonID)
	if err != nil {
		slog.Error("list revoked voices", "err", err)
		writeError(w, http.StatusInternalServerError, "storage_failed", "The consent was withdrawn, but the voice couldn't be deleted yet. Try again.")
		return
	}
	ids := make([]string, len(profiles))
	for i, p := range profiles {
		ids[i] = p.ModelVoiceID
	}
	// Before the clips go: from here on, nothing new is cached in these voices.
	h.Voices.ForgetVoices(ids)

	var modelFailed, storageFailed bool
	for _, p := range profiles {
		modelOK, localOK := h.deleteVoice(ctx, p)
		modelFailed = modelFailed || !modelOK
		storageFailed = storageFailed || !localOK
	}
	slog.Info("voice consent revoked", "consents", revoked, "voices", len(profiles),
		"model_failed", modelFailed, "storage_failed", storageFailed)
	switch {
	case modelFailed:
		writeError(w, http.StatusBadGateway, "model_error",
			"Your voice was removed from this device, but the voice model couldn't delete its copy. Try again.")
	case storageFailed:
		writeError(w, http.StatusInternalServerError, "storage_failed",
			"The consent was withdrawn, but some of the voice's clips couldn't be deleted. Try again.")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// deleteVoice deletes one revoked voice: the model service's copy, then its clips, then (only if both went)
// its profile. It reports whether the model side and the local side were fully deleted.
func (h *Handler) deleteVoice(ctx context.Context, p store.VoiceProfile) (modelOK, localOK bool) {
	modelOK, localOK = true, true
	// The default voice has no consent and its clips serve everyone, so it's never deleted. The model service
	// never hands out "default" for a cloned voice; this is a guard.
	if mv := p.ModelVoiceID; mv != "" && mv != defaultVoiceID {
		if err := h.Models.DeleteVoice(ctx, mv); err != nil {
			slog.Error("delete voice from the model service", "voice", p.ID, "model_voice", mv, "err", err)
			modelOK = false
		}
		localOK = h.deleteClips(ctx, mv)
	}
	if modelOK && localOK {
		if err := h.Store.DeleteVoiceProfile(ctx, h.PersonID, p.ID); err != nil {
			slog.Error("delete voice profile", "voice", p.ID, "err", err)
			localOK = false
		}
	}
	return modelOK, localOK
}

// defaultVoiceID is the model service's built-in generic voice.
const defaultVoiceID = "default"

// deleteClips deletes a voice's cached clips: files first, then the rows of the files that are gone, so a
// failure leaves rows that the next revoke finds again.
func (h *Handler) deleteClips(ctx context.Context, modelVoiceID string) bool {
	ids, err := h.Store.VoiceClips(ctx, modelVoiceID)
	if err != nil {
		slog.Error("list voice clips", "model_voice", modelVoiceID, "err", err)
		return false
	}
	ok := true
	gone := make([]string, 0, len(ids))
	for _, id := range ids {
		if err := h.Clips.Remove(id); err != nil {
			slog.Error("delete clip file", "clip", id, "err", err)
			ok = false
			continue
		}
		gone = append(gone, id)
	}
	if err := h.Store.DeleteVoiceClips(ctx, modelVoiceID, gone); err != nil {
		slog.Error("delete voice clips", "model_voice", modelVoiceID, "err", err)
		return false
	}
	return ok
}

var errSampleTooLarge = errors.New("sample too large")

type uploadForm struct {
	sample    models.VoiceSample
	consentID string
	sessionID string
}

// readForm streams the multipart body, keeping the sample in memory: it never touches the disk.
func readForm(r *http.Request) (uploadForm, error) {
	var f uploadForm
	mr, err := r.MultipartReader()
	if err != nil {
		return f, fmt.Errorf("expected multipart/form-data")
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return f, nil
		}
		if err != nil {
			return f, err
		}
		switch part.FormName() {
		case "audio":
			var buf bytes.Buffer
			n, err := io.Copy(&buf, io.LimitReader(part, MaxSampleBytes+1))
			if err != nil {
				return f, err
			}
			if n > MaxSampleBytes {
				return f, errSampleTooLarge
			}
			f.sample.Data = buf.Bytes()
			f.sample.FileName = part.FileName()
			f.sample.ContentType = part.Header.Get("Content-Type")
		case "consentId", "sessionId", "transcript", "locale":
			value, err := io.ReadAll(io.LimitReader(part, maxFieldBytes))
			if err != nil {
				return f, err
			}
			text := strings.TrimSpace(string(value))
			switch part.FormName() {
			case "consentId":
				f.consentID = text
			case "sessionId":
				f.sessionID = text
			case "locale":
				f.sample.Locale = text
			default:
				f.sample.Transcript = text
			}
		}
		part.Close()
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeError answers with { code, message } so the phone can show the message.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}
