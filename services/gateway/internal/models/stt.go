package models

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

const sttDialTimeout = 3 * time.Second

// STTEvent is one transcript from the model service: Kind is "partial" or "final".
type STTEvent struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// STTStream is one open WS /stt connection: PCM16 frames go in, transcripts come out.
type STTStream struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
	events chan STTEvent
}

// OpenSTT connects to the model service's WS /stt. Events is closed when the connection ends.
func (c *Client) OpenSTT(ctx context.Context, locale string) (*STTStream, error) {
	target, err := sttURL(c.BaseURL, locale)
	if err != nil {
		return nil, err
	}
	dialCtx, cancelDial := context.WithTimeout(ctx, sttDialTimeout)
	defer cancelDial()
	conn, _, err := websocket.Dial(dialCtx, target, nil)
	if err != nil {
		return nil, fmt.Errorf("dial /stt: %w", err)
	}
	conn.SetReadLimit(1 << 20)

	readCtx, cancel := context.WithCancel(context.Background())
	s := &STTStream{conn: conn, cancel: cancel, events: make(chan STTEvent, 16)}
	go s.read(readCtx)
	return s, nil
}

func (s *STTStream) Events() <-chan STTEvent { return s.events }

// Send writes one binary audio frame.
func (s *STTStream) Send(frame []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return s.conn.Write(ctx, websocket.MessageBinary, frame)
}

func (s *STTStream) Close() {
	s.cancel()
	_ = s.conn.Close(websocket.StatusNormalClosure, "")
}

func (s *STTStream) read(ctx context.Context) {
	defer close(s.events)
	for {
		kind, msg, err := s.conn.Read(ctx)
		if err != nil {
			return
		}
		if kind != websocket.MessageText {
			continue
		}
		var ev STTEvent
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Text == "" {
			continue
		}
		select {
		case s.events <- ev:
		case <-ctx.Done():
			return
		}
	}
}

// sttURL turns the model service's http(s) base URL into its ws(s) /stt URL.
func sttURL(base, locale string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("parse models url: %w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("models url %q: want http or https", base)
	}
	u.Path = "/stt"
	u.RawQuery = url.Values{"locale": {locale}}.Encode()
	return u.String(), nil
}
