package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ErrNoConsent means the person hasn't granted store_chat, so no conversation content may be stored.
var ErrNoConsent = errors.New("no store_chat consent")

const maxLabelLen = 80

type Memory struct {
	ID        string
	Summary   string
	CreatedAt int64
}

type Conversation struct {
	ID        string
	Label     string
	Summary   string
	StartedAt int64
}

// activeStoreChat takes the person id as its one parameter.
const activeStoreChat = `EXISTS (SELECT 1 FROM consent WHERE person_id = ? AND kind = 'store_chat' AND revoked_at IS NULL)`

// StoreChat reports whether the person currently grants store_chat consent.
func (s *Store) StoreChat(ctx context.Context, personID string) (bool, error) {
	var granted bool
	if err := s.DB.QueryRowContext(ctx, "SELECT "+activeStoreChat, personID).Scan(&granted); err != nil {
		return false, fmt.Errorf("store_chat consent: %w", err)
	}
	return granted, nil
}

// SetStoreChat grants or revokes store_chat consent. Revoking deletes every memory and saved conversation.
func (s *Store) SetStoreChat(ctx context.Context, personID string, granted bool) error {
	if granted {
		_, err := s.DB.ExecContext(ctx, `
			INSERT INTO consent (id, person_id, kind, granted_at, statement)
			SELECT ?, ?, 'store_chat', ?, 'memories.consentQuestion' WHERE NOT `+activeStoreChat,
			newID("consent"), personID, now(), personID)
		if err != nil {
			return fmt.Errorf("grant store_chat: %w", err)
		}
		return nil
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		"UPDATE consent SET revoked_at = ? WHERE person_id = ? AND kind = 'store_chat' AND revoked_at IS NULL",
		now(), personID); err != nil {
		return fmt.Errorf("revoke store_chat: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM memory WHERE person_id = ?", personID); err != nil {
		return fmt.Errorf("delete memories: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM saved_conversation WHERE person_id = ?", personID); err != nil {
		return fmt.Errorf("delete saved conversations: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// AddMemory stores a quick-memory summary. It is ErrNoConsent if store_chat isn't granted at the moment of the insert.
func (s *Store) AddMemory(ctx context.Context, personID, summary string) (Memory, error) {
	m := Memory{ID: newID("mem"), Summary: strings.TrimSpace(summary), CreatedAt: now()}
	if m.Summary == "" {
		return Memory{}, fmt.Errorf("%w: empty summary", ErrInvalid)
	}
	res, err := s.DB.ExecContext(ctx, `
		INSERT INTO memory (id, person_id, summary, created_at) SELECT ?, ?, ?, ? WHERE `+activeStoreChat,
		m.ID, personID, m.Summary, m.CreatedAt, personID)
	if err != nil {
		return Memory{}, fmt.Errorf("add memory: %w", err)
	}
	if err := requireOne(res); errors.Is(err, ErrNotFound) {
		return Memory{}, ErrNoConsent
	} else if err != nil {
		return Memory{}, err
	}
	return m, nil
}

// Memories returns the person's quick memories, newest first.
func (s *Store) Memories(ctx context.Context, personID string) ([]Memory, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, summary, created_at FROM memory WHERE person_id = ? ORDER BY created_at DESC, rowid DESC", personID)
	if err != nil {
		return nil, fmt.Errorf("memories: %w", err)
	}
	defer rows.Close()
	out := []Memory{}
	for rows.Next() {
		var m Memory
		if err := rows.Scan(&m.ID, &m.Summary, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan memory: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) DeleteMemory(ctx context.Context, personID, memoryID string) error {
	res, err := s.DB.ExecContext(ctx, "DELETE FROM memory WHERE id = ? AND person_id = ?", memoryID, personID)
	if err != nil {
		return fmt.Errorf("delete memory: %w", err)
	}
	return requireOne(res)
}

// SaveConversation stores a labelled conversation summary (never its transcript). startedAt is in Unix ms.
// It is ErrNoConsent if store_chat isn't granted at the moment of the insert.
func (s *Store) SaveConversation(ctx context.Context, personID, label, summary string, startedAt int64) (Conversation, error) {
	label, err := cleanText(label, maxLabelLen)
	if err != nil {
		return Conversation{}, err
	}
	c := Conversation{ID: newID("cv"), Label: label, Summary: strings.TrimSpace(summary), StartedAt: startedAt}
	if c.Summary == "" {
		return Conversation{}, fmt.Errorf("%w: empty summary", ErrInvalid)
	}
	res, err := s.DB.ExecContext(ctx, `
		INSERT INTO saved_conversation (id, person_id, label, summary, started_at, created_at)
		SELECT ?, ?, ?, ?, ?, ? WHERE `+activeStoreChat,
		c.ID, personID, c.Label, c.Summary, c.StartedAt, now(), personID)
	if err != nil {
		return Conversation{}, fmt.Errorf("save conversation: %w", err)
	}
	if err := requireOne(res); errors.Is(err, ErrNotFound) {
		return Conversation{}, ErrNoConsent
	} else if err != nil {
		return Conversation{}, err
	}
	return c, nil
}

// Conversations returns the person's saved conversations, newest first.
func (s *Store) Conversations(ctx context.Context, personID string) ([]Conversation, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT id, label, summary, started_at FROM saved_conversation WHERE person_id = ?
		ORDER BY started_at DESC, rowid DESC`, personID)
	if err != nil {
		return nil, fmt.Errorf("saved conversations: %w", err)
	}
	defer rows.Close()
	out := []Conversation{}
	for rows.Next() {
		var c Conversation
		if err := rows.Scan(&c.ID, &c.Label, &c.Summary, &c.StartedAt); err != nil {
			return nil, fmt.Errorf("scan saved conversation: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) DeleteConversation(ctx context.Context, personID, conversationID string) error {
	res, err := s.DB.ExecContext(ctx, "DELETE FROM saved_conversation WHERE id = ? AND person_id = ?", conversationID, personID)
	if err != nil {
		return fmt.Errorf("delete saved conversation: %w", err)
	}
	return requireOne(res)
}
