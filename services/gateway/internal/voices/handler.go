// Package voices serves the phone's voice setup: POST /api/consent stores a voice-clone consent record, and
// POST /api/voices takes a recorded or picked sample, checks the consent, and has the model service clone it.
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

// Cloner creates a voice in the model service.
type Cloner interface {
	CreateVoice(ctx context.Context, sample models.VoiceSample, consentID string) (string, error)
}

// VoiceSetter switches the live sessions to a new voice.
type VoiceSetter interface {
	SetVoice(modelVoiceID string)
}

type Handler struct {
	Store    *store.Store
	Models   Cloner
	Voices   VoiceSetter
	PersonID string // single-user for the hackathon: every session belongs to this person
	Locale   string
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

// Upload handles POST /api/voices (multipart: audio, consentId, sessionId, optional transcript).
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
		writeError(w, http.StatusBadGateway, "model_error", "The voice model couldn't use that sample. Try again or use another recording.")
		return
	}
	profileID, err := h.Store.CreateVoiceProfile(r.Context(), h.PersonID, form.consentID, modelVoiceID, h.Locale)
	if err != nil {
		slog.Error("save voice profile", "err", err)
		writeError(w, http.StatusInternalServerError, "storage_failed", "The voice was made but couldn't be saved.")
		return
	}
	h.Voices.SetVoice(modelVoiceID)
	slog.Info("voice created", "voice", profileID, "model_voice", modelVoiceID, "session", form.sessionID, "bytes", len(form.sample.Data))
	writeJSON(w, http.StatusCreated, map[string]string{"voiceId": profileID})
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
		case "consentId", "sessionId", "transcript":
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
