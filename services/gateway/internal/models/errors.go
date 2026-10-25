package models

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
)

var (
	// ErrUnavailable means the model service is unreachable or still loading the model it needs (503).
	// It's worth retrying in a minute; the request itself was fine.
	ErrUnavailable = errors.New("model service unavailable")
	// ErrUnknownVoice means /tts doesn't know the voiceId (404), for example because the model service's
	// voices folder was wiped. Retrying with the same voice won't help.
	ErrUnknownVoice = errors.New("unknown voice")
)

// StatusError is a non-2xx answer from the model service.
type StatusError struct {
	Method, Path string
	Code         int    // HTTP status code
	Status       string // e.g. "422 Unprocessable Entity"
	Body         string // start of the response body (FastAPI's {"detail": ...})
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("%s %s: %s: %s", e.Method, e.Path, e.Status, e.Body)
}

// Is makes a 503 match ErrUnavailable.
func (e *StatusError) Is(target error) bool {
	return target == ErrUnavailable && e.Code == http.StatusServiceUnavailable
}

func statusError(method, path string, resp *http.Response) error {
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return &StatusError{Method: method, Path: path, Code: resp.StatusCode, Status: resp.Status, Body: string(msg)}
}

// transportError wraps an error from sending the request. If ctx isn't done, the connection itself failed
// (nothing listening, connection reset), so the model service counts as unavailable. A timeout does not:
// the service was up but slow.
func transportError(ctx context.Context, method, path string, err error) error {
	if ctx.Err() == nil {
		return fmt.Errorf("%s %s: %w: %w", method, path, ErrUnavailable, err)
	}
	return fmt.Errorf("%s %s: %w", method, path, err)
}
