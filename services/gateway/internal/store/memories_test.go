package store

import (
	"context"
	"errors"
	"testing"
)

func TestStoreChatGatesAndRevokeWipes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.EnsurePerson(ctx, "p1", "Pat", DefaultLocale); err != nil {
		t.Fatal(err)
	}

	if id, err := s.StoreChatConsent(ctx, "p1"); err != nil || id != "" {
		t.Fatalf("StoreChatConsent = %q, %v before granting", id, err)
	}
	if _, err := s.AddMemory(ctx, "p1", "consent_missing", "The doctor visits at 3 pm."); !errors.Is(err, ErrNoConsent) {
		t.Fatalf("memory without consent: err = %v, want ErrNoConsent", err)
	}
	if _, err := s.SaveConversation(ctx, "p1", "consent_missing", "Dr. Lee", "Started lisinopril.", 1); !errors.Is(err, ErrNoConsent) {
		t.Fatalf("conversation without consent: err = %v, want ErrNoConsent", err)
	}

	// Granting twice keeps one active consent record.
	var consentIDs []string
	for range 2 {
		if err := s.SetStoreChat(ctx, "p1", true); err != nil {
			t.Fatal(err)
		}
		id, _ := s.StoreChatConsent(ctx, "p1")
		consentIDs = append(consentIDs, id)
	}
	consent := consentIDs[0]
	if consent == "" || consentIDs[1] != consent {
		t.Fatalf("consent ids after granting twice = %q", consentIDs)
	}
	if _, err := s.AddMemory(ctx, "p1", consent, "The doctor visits at 3 pm."); err != nil {
		t.Fatal(err)
	}
	// Foreign keys are on and the save must not depend on a session row.
	cv, err := s.SaveConversation(ctx, "p1", consent, "  Dr. Lee  ", "Started lisinopril.", 1)
	if err != nil || cv.Label != "Dr. Lee" {
		t.Fatalf("SaveConversation = %+v, %v", cv, err)
	}

	if err := s.SetStoreChat(ctx, "p1", false); err != nil {
		t.Fatal(err)
	}
	if id, _ := s.StoreChatConsent(ctx, "p1"); id != "" {
		t.Fatal("store_chat still granted after revoking")
	}
	mems, _ := s.Memories(ctx, "p1")
	convs, _ := s.Conversations(ctx, "p1")
	if len(mems) != 0 || len(convs) != 0 {
		t.Fatalf("after revoke: %d memories, %d conversations, want none", len(mems), len(convs))
	}
	var active, revoked int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL), COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)
		FROM consent WHERE kind = 'store_chat'`).Scan(&active, &revoked); err != nil || active != 0 || revoked != 1 {
		t.Fatalf("store_chat consent rows: %d active, %d revoked, err %v; want 0 and 1", active, revoked, err)
	}

	// A summary of speech captured under the revoked consent isn't stored under a new grant.
	if err := s.SetStoreChat(ctx, "p1", true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMemory(ctx, "p1", consent, "From before the revoke."); !errors.Is(err, ErrNoConsent) {
		t.Fatalf("memory under a revoked consent: err = %v, want ErrNoConsent", err)
	}
}

func TestMemoriesAndConversationsCRUD(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for _, p := range []string{"p1", "p2"} {
		if _, err := s.EnsurePerson(ctx, p, p, DefaultLocale); err != nil {
			t.Fatal(err)
		}
		if err := s.SetStoreChat(ctx, p, true); err != nil {
			t.Fatal(err)
		}
	}
	consent, _ := s.StoreChatConsent(ctx, "p1")

	first, _ := s.AddMemory(ctx, "p1", consent, "first")
	second, _ := s.AddMemory(ctx, "p1", consent, "second")
	if mems, _ := s.Memories(ctx, "p1"); len(mems) != 2 || mems[0].ID != second.ID {
		t.Fatalf("memories = %+v, want newest first", mems)
	}
	if err := s.DeleteMemory(ctx, "p2", first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting another person's memory: err = %v", err)
	}
	if err := s.DeleteMemory(ctx, "p1", first.ID); err != nil {
		t.Fatal(err)
	}
	if mems, _ := s.Memories(ctx, "p1"); len(mems) != 1 || mems[0].ID != second.ID {
		t.Fatalf("memories after delete = %+v", mems)
	}

	if _, err := s.SaveConversation(ctx, "p1", consent, "   ", "summary", 1); !errors.Is(err, ErrInvalid) {
		t.Fatalf("blank label: err = %v, want ErrInvalid", err)
	}
	older, _ := s.SaveConversation(ctx, "p1", consent, "Older", "a", 1)
	newer, _ := s.SaveConversation(ctx, "p1", consent, "Newer", "b", 2)
	if convs, _ := s.Conversations(ctx, "p1"); len(convs) != 2 || convs[0].ID != newer.ID {
		t.Fatalf("conversations = %+v, want newest first", convs)
	}
	if err := s.DeleteConversation(ctx, "p1", older.ID); err != nil {
		t.Fatal(err)
	}
	if convs, _ := s.Conversations(ctx, "p1"); len(convs) != 1 || convs[0].ID != newer.ID {
		t.Fatalf("conversations after delete = %+v", convs)
	}
}
