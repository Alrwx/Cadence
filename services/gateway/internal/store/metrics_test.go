package store

import (
	"context"
	"database/sql"
	"testing"
)

func TestTurnTextNeedsStoreChatConsent(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.EnsurePerson(ctx, "p1", "Pat", DefaultLocale); err != nil {
		t.Fatal(err)
	}
	text := func(speaker string) sql.NullString {
		t.Helper()
		var v sql.NullString
		if err := s.DB.QueryRow(`SELECT text FROM turn WHERE speaker = ? ORDER BY ts DESC LIMIT 1`, speaker).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}

	if ok, err := s.HasConsent(ctx, "p1", ConsentStoreChat); err != nil || ok {
		t.Fatalf("HasConsent before any consent = %v, %v", ok, err)
	}
	// No session row yet: AddTurn creates it.
	if err := s.AddTurn(ctx, "s1", "p1", "other", "How are you?", 1); err != nil {
		t.Fatal(err)
	}
	if v := text("other"); v.Valid {
		t.Fatalf("turn text stored without store_chat consent: %q", v.String)
	}

	// A voice_clone consent is not store_chat.
	if _, err := s.CreateConsent(ctx, "p1", ConsentVoiceClone, "Pat", "voice.consentCheck"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.HasConsent(ctx, "p1", ConsentStoreChat); ok {
		t.Fatal("voice_clone consent counted as store_chat")
	}
	id, err := s.CreateConsent(ctx, "p1", ConsentStoreChat, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.HasConsent(ctx, "p1", ConsentStoreChat); !ok {
		t.Fatal("HasConsent = false after store_chat consent")
	}
	if err := s.AddTurn(ctx, "s1", "p1", "user", "Fine, thanks", 2); err != nil {
		t.Fatal(err)
	}
	if v := text("user"); v.String != "Fine, thanks" {
		t.Fatalf("turn text with consent = %+v", v)
	}

	// Revoked: text goes back to NULL.
	if _, err := s.DB.Exec(`UPDATE consent SET revoked_at = 3 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if err := s.AddTurn(ctx, "s1", "p1", "other", "Good to hear", 4); err != nil {
		t.Fatal(err)
	}
	if v := text("other"); v.Valid {
		t.Fatalf("turn text stored after store_chat was revoked: %q", v.String)
	}
}

func TestSessionStartAndEnd(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.EnsurePerson(ctx, "p1", "Pat", DefaultLocale); err != nil {
		t.Fatal(err)
	}
	read := func() (started int64, ended sql.NullInt64) {
		t.Helper()
		if err := s.DB.QueryRow(`SELECT started_at, ended_at FROM session WHERE id = 's1'`).Scan(&started, &ended); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := s.StartSession(ctx, "s1", "p1", 10); err != nil {
		t.Fatal(err)
	}
	if err := s.EndSession(ctx, "s1", 20); err != nil {
		t.Fatal(err)
	}
	if started, ended := read(); started != 10 || ended.Int64 != 20 {
		t.Fatalf("session = %d..%v", started, ended)
	}
	// Reconnecting with the same id reopens it and keeps started_at.
	if err := s.StartSession(ctx, "s1", "p1", 30); err != nil {
		t.Fatal(err)
	}
	if started, ended := read(); started != 10 || ended.Valid {
		t.Fatalf("reopened session = %d..%v", started, ended)
	}
}

func TestMetricSummary(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for i := int64(1); i <= 20; i++ {
		detail := "ok"
		if i > 18 {
			detail = "timeout"
		}
		if err := s.AddMetric(ctx, Metric{SessionID: "s1", Name: "suggest", ValueMs: i * 10, Detail: detail, TS: i}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AddMetric(ctx, Metric{Name: "selection", ValueMs: -1, Detail: "instant", TS: 1}); err != nil {
		t.Fatal(err)
	}

	stats, err := s.MetricSummary(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]MetricStat{}
	for _, st := range stats {
		byKey[st.Name+"/"+st.Detail] = st
	}
	all := byKey["suggest/*"]
	if all.Count != 20 || *all.P50 != 100 || *all.P95 != 190 || *all.Max != 200 {
		t.Fatalf("suggest/* = %+v", all)
	}
	if ok := byKey["suggest/ok"]; ok.Count != 18 || *ok.Max != 180 {
		t.Fatalf("suggest/ok = %+v", ok)
	}
	if sel := byKey["selection/instant"]; sel.Count != 1 || sel.P50 != nil {
		t.Fatalf("count-only metric = %+v", sel)
	}
	if stats[0].Name != "selection" || stats[0].Detail != "*" {
		t.Fatalf("first stat = %+v, want selection/* (sorted by name, aggregate first)", stats[0])
	}

	// since filters by ts.
	stats, _ = s.MetricSummary(ctx, 15)
	for _, st := range stats {
		if st.Name == "suggest" && st.Detail == "*" && st.Count != 6 {
			t.Fatalf("since=15 suggest/* count = %d, want 6", st.Count)
		}
	}
}
