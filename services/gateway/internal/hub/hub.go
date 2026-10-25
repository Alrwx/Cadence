// Package hub accepts headset and phone WebSockets and groups them by session.
// It knows nothing about the conversation; it hands events and audio frames to a Handler.
package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
)

type Role string

const (
	Headset Role = "headset"
	Phone   Role = "phone"
)

type Handler interface {
	OnConnect(s *Session, role Role)
	OnEvent(s *Session, from Role, env protocol.Envelope)
	// OnAudio receives phone mic frames: PCM16 mono, 16 kHz, 20 ms.
	OnAudio(s *Session, frame []byte)
}

// DisconnectHandler is optionally implemented by a Handler to hear when a client's socket closes.
// last is true when no client of the session is still connected. A socket replaced by a reconnect
// doesn't count as a disconnect.
type DisconnectHandler interface {
	OnDisconnect(s *Session, role Role, last bool)
}

type Hub struct {
	handler Handler
	// OriginPatterns lists extra allowed origins (the Vite dev servers); same-origin is always allowed.
	OriginPatterns []string

	mu       sync.Mutex
	sessions map[string]*Session
}

func New(handler Handler) *Hub {
	return &Hub{handler: handler, sessions: map[string]*Session{}}
}

// Session is one conversation: at most one headset and one phone.
type Session struct {
	ID string

	mu      sync.Mutex
	clients map[Role]*websocket.Conn
}

// Connected reports whether a client with the given role has a socket open.
func (s *Session) Connected(role Role) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clients[role] != nil
}

// Send writes one event to the client with the given role, if connected.
func (s *Session) Send(ctx context.Context, role Role, eventType, turnID string, data any) error {
	s.mu.Lock()
	conn := s.clients[role]
	s.mu.Unlock()
	if conn == nil {
		return nil
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("encode %s: %w", eventType, err)
	}
	env, err := json.Marshal(protocol.Envelope{
		Type: eventType, V: protocol.Version, SessionID: s.ID, TurnID: turnID,
		TS: time.Now().UnixMilli(), Data: raw,
	})
	if err != nil {
		return fmt.Errorf("encode envelope: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, env)
}

// Broadcast sends an event to every connected client in the session.
func (s *Session) Broadcast(ctx context.Context, eventType, turnID string, data any) {
	for _, role := range []Role{Headset, Phone} {
		if err := s.Send(ctx, role, eventType, turnID, data); err != nil {
			slog.Warn("broadcast", "session", s.ID, "role", role, "type", eventType, "err", err)
		}
	}
}

// ServeHTTP handles /ws?role=headset|phone&session=<id>.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	role := Role(r.URL.Query().Get("role"))
	sessionID := r.URL.Query().Get("session")
	if (role != Headset && role != Phone) || sessionID == "" {
		http.Error(w, "need role=headset|phone and session", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.OriginPatterns})
	if err != nil {
		slog.Warn("ws accept", "err", err)
		return
	}
	conn.SetReadLimit(1 << 20)

	s := h.session(sessionID)
	s.mu.Lock()
	if old := s.clients[role]; old != nil {
		old.Close(websocket.StatusPolicyViolation, "replaced by a newer connection")
	}
	s.clients[role] = conn
	s.mu.Unlock()
	slog.Info("client connected", "session", sessionID, "role", role)
	h.handler.OnConnect(s, role)

	h.read(r.Context(), s, role, conn)

	s.mu.Lock()
	removed := s.clients[role] == conn
	if removed {
		delete(s.clients, role)
	}
	last := len(s.clients) == 0
	s.mu.Unlock()
	slog.Info("client disconnected", "session", sessionID, "role", role)
	if dh, ok := h.handler.(DisconnectHandler); ok && removed {
		dh.OnDisconnect(s, role, last)
	}
}

func (h *Hub) read(ctx context.Context, s *Session, role Role, conn *websocket.Conn) {
	for {
		kind, msg, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if kind == websocket.MessageBinary {
			if role == Phone {
				h.handler.OnAudio(s, msg)
			}
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal(msg, &env); err != nil {
			slog.Warn("bad event", "session", s.ID, "role", role, "err", err)
			continue
		}
		h.handler.OnEvent(s, role, env)
	}
}

func (h *Hub) session(id string) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[id]
	if !ok {
		s = &Session{ID: id, clients: map[Role]*websocket.Conn{}}
		h.sessions[id] = s
	}
	return s
}
