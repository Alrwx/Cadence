// Package models is the gateway's client for the Python model service (AGENTS(GH).md §6.2).
// The gateway owns timeouts: /suggest 3 s, /tts 6 s.
package models

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	SuggestTimeout = 3 * time.Second
	TTSTimeout     = 6 * time.Second
)

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func New(baseURL string) *Client {
	return &Client{BaseURL: baseURL, HTTP: &http.Client{}}
}

type Turn struct {
	Speaker string `json:"speaker"`
	Text    string `json:"text"`
}

type Style struct {
	Phrases []string `json:"phrases"`
	Tone    string   `json:"tone"`
}

// ContextItem is a saved conversation attached as context (stretch).
type ContextItem struct {
	Label   string `json:"label"`
	Summary string `json:"summary"`
}

type SuggestRequest struct {
	TurnID  string        `json:"turnId"`
	History []Turn        `json:"history"`
	Style   Style         `json:"style"`
	Context []ContextItem `json:"context,omitempty"`
	N       int           `json:"n"`
}

type Suggestion struct {
	Text string `json:"text"`
	Kind string `json:"kind"`
}

type SuggestResponse struct {
	TurnID string       `json:"turnId"`
	Items  []Suggestion `json:"items"`
	Ms     int          `json:"ms"`
}

type Health struct {
	STT     string `json:"stt"`
	Suggest string `json:"suggest"`
	TTS     string `json:"tts"`
	Backend string `json:"backend"`
}

func (c *Client) Health(ctx context.Context) (Health, error) {
	var h Health
	err := c.do(ctx, http.MethodGet, "/health", nil, &h)
	return h, err
}

func (c *Client) Suggest(ctx context.Context, req SuggestRequest) (SuggestResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, SuggestTimeout)
	defer cancel()
	var resp SuggestResponse
	err := c.do(ctx, http.MethodPost, "/suggest", req, &resp)
	return resp, err
}

// TTS returns WAV bytes for text in the given voice and locale. A voiceId the model service doesn't know
// (404) is ErrUnknownVoice.
func (c *Client) TTS(ctx context.Context, voiceID, text, locale string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, TTSTimeout)
	defer cancel()
	var wav []byte
	err := c.do(ctx, http.MethodPost, "/tts", map[string]string{"voiceId": voiceID, "text": text, "locale": locale}, &wav)
	var se *StatusError
	if errors.As(err, &se) && se.Code == http.StatusNotFound {
		return nil, fmt.Errorf("%w %q: %w", ErrUnknownVoice, voiceID, err)
	}
	return wav, err
}

// do sends body as JSON and decodes the response into out (raw bytes when out is *[]byte).
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode %s: %w", path, err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return fmt.Errorf("build %s: %w", path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return transportError(ctx, method, path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return statusError(method, path, resp)
	}
	if raw, ok := out.(*[]byte); ok {
		*raw, err = io.ReadAll(resp.Body)
		return err
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}
