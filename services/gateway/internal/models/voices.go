package models

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"time"
)

// VoiceTimeout is generous: the model service extracts audio with ffmpeg, may transcribe the sample, and builds
// the voice prompt before it answers.
const VoiceTimeout = 60 * time.Second

// VoiceSample is an uploaded voice sample: audio, or video with an audio track.
type VoiceSample struct {
	Data        []byte
	FileName    string
	ContentType string
	// Transcript of the sample, if known. Empty means the model service transcribes it (§6.2).
	Transcript string
	// Locale of the speech in the sample, e.g. "es": what the model service transcribes it as. Empty means "en".
	Locale string
}

// CreateVoice clones a voice from sample (POST /voices) and returns the model service's voiceId.
// ErrUnavailable means the service is down or still loading its models; any other *StatusError means it
// rejected the sample.
func (c *Client) CreateVoice(ctx context.Context, sample VoiceSample, consentID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, VoiceTimeout)
	defer cancel()

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="audio"; filename=%q`, sample.FileName))
	contentType := sample.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	header.Set("Content-Type", contentType)
	part, err := form.CreatePart(header)
	if err != nil {
		return "", fmt.Errorf("build /voices: %w", err)
	}
	if _, err := part.Write(sample.Data); err != nil {
		return "", fmt.Errorf("build /voices: %w", err)
	}
	if err := form.WriteField("consentId", consentID); err != nil {
		return "", fmt.Errorf("build /voices: %w", err)
	}
	for name, value := range map[string]string{"transcript": sample.Transcript, "locale": sample.Locale} {
		if value == "" {
			continue
		}
		if err := form.WriteField(name, value); err != nil {
			return "", fmt.Errorf("build /voices: %w", err)
		}
	}
	if err := form.Close(); err != nil {
		return "", fmt.Errorf("build /voices: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/voices", &body)
	if err != nil {
		return "", fmt.Errorf("build /voices: %w", err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", transportError(ctx, http.MethodPost, "/voices", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return "", statusError(http.MethodPost, "/voices", resp)
	}
	var out struct {
		VoiceID string `json:"voiceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode /voices: %w", err)
	}
	if out.VoiceID == "" {
		return "", fmt.Errorf("POST /voices: empty voiceId")
	}
	return out.VoiceID, nil
}

// DeleteVoiceTimeout covers removing the voice's folder and its cached prompt.
const DeleteVoiceTimeout = 10 * time.Second

// DeleteVoice deletes a cloned voice from the model service (DELETE /voices/{voiceId}). A voice the service
// doesn't have (404) counts as deleted.
func (c *Client) DeleteVoice(ctx context.Context, voiceID string) error {
	ctx, cancel := context.WithTimeout(ctx, DeleteVoiceTimeout)
	defer cancel()
	err := c.do(ctx, http.MethodDelete, "/voices/"+url.PathEscape(voiceID), nil, nil)
	var se *StatusError
	if errors.As(err, &se) && se.Code == http.StatusNotFound {
		return nil
	}
	return err
}
