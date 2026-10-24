package store

import (
	"path/filepath"
	"testing"
)

func TestOpenMigratesAndLogs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LogUtterance("s_1", "c_1", "Yes", "instant", 1); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// Reopening must not re-apply migrations.
	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s.Close()
	var n int
	if err := s.DB.QueryRow("SELECT COUNT(*) FROM audit_log").Scan(&n); err != nil || n != 1 {
		t.Fatalf("audit_log rows = %d, err = %v", n, err)
	}
}
