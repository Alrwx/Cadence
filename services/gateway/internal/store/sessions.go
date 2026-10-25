package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// HasConsent reports whether personID has a granted, unrevoked consent of kind (for example ConsentStoreChat).
func (s *Store) HasConsent(ctx context.Context, personID, kind string) (bool, error) {
	var one int
	err := s.DB.QueryRowContext(ctx,
		`SELECT 1 FROM consent WHERE person_id = ? AND kind = ? AND revoked_at IS NULL LIMIT 1`,
		personID, kind).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check %s consent: %w", kind, err)
	}
	return true, nil
}

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

// AddTurn records one turn of the conversation: speaker "other" (what the listener said) or "user" (a reply
// that was spoken). The text is stored only if the person has an active store_chat consent; otherwise the
// row is kept with text NULL (§2: no conversation text without store_chat). The consent is checked here, at
// write time, so no caller can forget it. The session row is created if it doesn't exist yet.
func (s *Store) AddTurn(ctx context.Context, sessionID, personID, speaker, text string, ts int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("add turn: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO session (id, person_id, started_at) VALUES (?, ?, ?)`, sessionID, personID, ts); err != nil {
		return fmt.Errorf("add turn: ensure session: %w", err)
	}
	var stored sql.NullString
	var one int
	err = tx.QueryRowContext(ctx,
		`SELECT 1 FROM consent WHERE person_id = ? AND kind = ? AND revoked_at IS NULL LIMIT 1`,
		personID, ConsentStoreChat).Scan(&one)
	switch {
	case err == nil:
		stored = sql.NullString{String: text, Valid: true}
	case !errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("add turn: check consent: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO turn (id, session_id, speaker, text, ts) VALUES (?, ?, ?, ?, ?)`,
		newID("turn"), sessionID, speaker, stored, ts); err != nil {
		return fmt.Errorf("add turn: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("add turn: commit: %w", err)
	}
	return nil
}
