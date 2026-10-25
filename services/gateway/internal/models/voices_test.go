package models

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateVoiceSendsMultipart(t *testing.T) {
	var got struct {
		consentID, transcript, fileName, contentType, audio string
		hasTranscript                                       bool
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/voices" {
			http.NotFound(w, r)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		got.consentID = r.FormValue("consentId")
		_, got.hasTranscript = r.MultipartForm.Value["transcript"]
		got.transcript = r.FormValue("transcript")
		file, header, err := r.FormFile("audio")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		body, _ := io.ReadAll(file)
		got.audio, got.fileName, got.contentType = string(body), header.Filename, header.Header.Get("Content-Type")
		_, _ = w.Write([]byte(`{"voiceId":"mlx_1"}`))
	}))
	defer srv.Close()
	c := New(srv.URL)

	id, err := c.CreateVoice(context.Background(), VoiceSample{Data: []byte("RIFF"), FileName: "sample.webm", ContentType: "audio/webm"}, "consent_1")
	if err != nil || id != "mlx_1" {
		t.Fatalf("CreateVoice = %q, %v", id, err)
	}
	if got.consentID != "consent_1" || got.audio != "RIFF" || got.fileName != "sample.webm" || got.contentType != "audio/webm" {
		t.Fatalf("model service got %+v", got)
	}
	if got.hasTranscript {
		t.Fatal("an empty transcript must be left out so the model service transcribes the sample")
	}

	if _, err := c.CreateVoice(context.Background(), VoiceSample{Data: []byte("x"), FileName: "a.m4a", Transcript: "Hello there"}, "consent_1"); err != nil {
		t.Fatal(err)
	}
	if got.transcript != "Hello there" {
		t.Fatalf("transcript = %q", got.transcript)
	}
}

func TestCreateVoiceReportsModelErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "ffmpeg failed", http.StatusUnprocessableEntity)
	}))
	defer srv.Close()
	_, err := New(srv.URL).CreateVoice(context.Background(), VoiceSample{Data: []byte("x"), FileName: "a.webm"}, "consent_1")
	if err == nil || !strings.Contains(err.Error(), "422") || !strings.Contains(err.Error(), "ffmpeg failed") {
		t.Fatalf("err = %v", err)
	}
	if errors.Is(err, ErrUnavailable) {
		t.Fatal("a rejected sample is not an unavailable model service")
	}
}

// A model service that is still loading (503) or not running at all is ErrUnavailable, so the gateway can
// tell the phone to retry instead of blaming the sample.
func TestCreateVoiceUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"detail":"tts is loading"}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	sample := VoiceSample{Data: []byte("x"), FileName: "a.webm"}
	if _, err := New(srv.URL).CreateVoice(context.Background(), sample, "consent_1"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("503: err = %v, want ErrUnavailable", err)
	}

	down := httptest.NewServer(http.NotFoundHandler())
	url := down.URL
	down.Close()
	if _, err := New(url).CreateVoice(context.Background(), sample, "consent_1"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unreachable: err = %v, want ErrUnavailable", err)
	}
}

func TestDeleteVoice(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "wrong method", http.StatusMethodNotAllowed)
			return
		}
		paths = append(paths, r.URL.EscapedPath())
		switch r.URL.Path {
		case "/voices/mlx_1":
			w.WriteHeader(http.StatusNoContent)
		case "/voices/mlx_gone":
			http.Error(w, "not found", http.StatusNotFound)
		default:
			http.Error(w, "loading", http.StatusServiceUnavailable)
		}
	}))
	defer srv.Close()
	c := New(srv.URL)
	if err := c.DeleteVoice(context.Background(), "mlx_1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := c.DeleteVoice(context.Background(), "mlx_gone"); err != nil {
		t.Fatalf("an already deleted voice: %v", err)
	}
	if err := c.DeleteVoice(context.Background(), "a/b"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("503: err = %v", err)
	}
	if paths[2] != "/voices/a%2Fb" {
		t.Fatalf("voiceId not escaped: %q", paths[2])
	}
}

func TestTTSUnknownVoice(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"detail":"unknown voiceId mlx_gone"}`, http.StatusNotFound)
	}))
	defer srv.Close()
	_, err := New(srv.URL).TTS(context.Background(), "mlx_gone", "Yes", "en")
	if !errors.Is(err, ErrUnknownVoice) {
		t.Fatalf("err = %v, want ErrUnknownVoice", err)
	}
}
