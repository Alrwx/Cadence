// Package store owns the gateway's SQLite database: consent, profiles, saved phrases, audit log, metrics.
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct {
	DB *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	s := &Store{DB: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }

// migrate applies migrations/*.sql in name order, each once, tracked by PRAGMA user_version.
func (s *Store) migrate() error {
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(names)
	var version int
	if err := s.DB.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	for i := version; i < len(names); i++ {
		body, err := migrations.ReadFile(names[i])
		if err != nil {
			return fmt.Errorf("read %s: %w", names[i], err)
		}
		tx, err := s.DB.Begin()
		if err != nil {
			return fmt.Errorf("begin %s: %w", names[i], err)
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", names[i], err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return fmt.Errorf("bump user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit %s: %w", names[i], err)
		}
	}
	return nil
}

// LogUtterance records a played clip in the audit log (§2: every utterance is logged).
func (s *Store) LogUtterance(sessionID, clipID, text, source string, ts int64) error {
	_, err := s.DB.Exec(
		"INSERT INTO audit_log (session_id, clip_id, text, source, ts) VALUES (?, ?, ?, ?, ?)",
		sessionID, clipID, text, source, ts,
	)
	if err != nil {
		return fmt.Errorf("log utterance: %w", err)
	}
	return nil
}
