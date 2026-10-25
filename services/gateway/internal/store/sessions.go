package store

import (
	"context"
	"fmt"
)

// StartSession records that a session id connected. A session seen before keeps its started_at and is
// reopened (ended_at cleared), since clients reuse their session id across reconnects.
func (s *Store) StartSession(ctx context.Context, sessionID, personID string, ts int64) error {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO session (id, person_id, started_at) VALUES (?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET ended_at = NULL`, sessionID, personID, ts)
	if err != nil {
		return fmt.Errorf("start session: %w", err)
	}
	return nil
}

// EndSession sets ended_at, for when the session's last client disconnects.
func (s *Store) EndSession(ctx context.Context, sessionID string, ts int64) error {
	if _, err := s.DB.ExecContext(ctx, `UPDATE session SET ended_at = ? WHERE id = ?`, ts, sessionID); err != nil {
		return fmt.Errorf("end session: %w", err)
	}
	return nil
}

// AddTurn records that someone spoke: speaker "other" (the listener) or "user" (a reply that was played). Its
// text is never stored, even with store_chat consent, which covers only summaries. The session row is created
// if it doesn't exist yet.
func (s *Store) AddTurn(ctx context.Context, sessionID, personID, speaker string, ts int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("add turn: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO session (id, person_id, started_at) VALUES (?, ?, ?)`, sessionID, personID, ts); err != nil {
		return fmt.Errorf("add turn: ensure session: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO turn (id, session_id, speaker, ts) VALUES (?, ?, ?, ?)`,
		newID("turn"), sessionID, speaker, ts); err != nil {
		return fmt.Errorf("add turn: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("add turn: commit: %w", err)
	}
	return nil
}
