package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestVoiceConsentAndProfiles(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.EnsurePerson(ctx, "p1", "Pat", DefaultLocale); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EnsurePerson(ctx, "p2", "Sam", DefaultLocale); err != nil {
		t.Fatal(err)
	}

	// Invalid input is rejected before anything is stored.
	for _, tc := range []struct{ kind, owner, statement string }{
		{"selfie", "Alex", "voice.consentCheck"},
		{ConsentVoiceClone, "   ", "voice.consentCheck"},
		{ConsentVoiceClone, "Alex", ""},
	} {
		if _, err := s.CreateConsent(ctx, "p1", tc.kind, tc.owner, tc.statement); !errors.Is(err, ErrInvalid) {
			t.Errorf("CreateConsent(%q, %q, %q) err = %v, want ErrInvalid", tc.kind, tc.owner, tc.statement, err)
		}
	}

	// store_chat has no voice owner; it must not be rejected for one (consent.set over the WebSocket, #11).
	chat, err := s.CreateConsent(ctx, "p1", ConsentStoreChat, "", "")
	if err != nil {
		t.Fatalf("store_chat consent: %v", err)
	}
	var chatOwner sql.NullString
	if err := s.DB.QueryRow(`SELECT voice_owner FROM consent WHERE id = ?`, chat).Scan(&chatOwner); err != nil || chatOwner.Valid {
		t.Fatalf("store_chat voice_owner = %+v, %v; want NULL", chatOwner, err)
	}
	if err := s.ActiveConsent(ctx, "p1", chat, ConsentVoiceClone); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a store_chat consent must not authorize a voice clone: %v", err)
	}

	consent, err := s.CreateConsent(ctx, "p1", ConsentVoiceClone, "  Alex   Rivera ", "voice.consentCheck")
	if err != nil {
		t.Fatal(err)
	}
	var owner, statement string
	if err := s.DB.QueryRow(`SELECT voice_owner, statement FROM consent WHERE id = ?`, consent).Scan(&owner, &statement); err != nil {
		t.Fatal(err)
	}
	if owner != "Alex Rivera" || statement != "voice.consentCheck" {
		t.Fatalf("stored owner %q statement %q", owner, statement)
	}

	if err := s.ActiveConsent(ctx, "p1", consent, ConsentVoiceClone); err != nil {
		t.Fatalf("ActiveConsent = %v", err)
	}
	for name, check := range map[string]error{
		"unknown id":   s.ActiveConsent(ctx, "p1", "consent_nope", ConsentVoiceClone),
		"other kind":   s.ActiveConsent(ctx, "p1", consent, ConsentStoreChat),
		"other person": s.ActiveConsent(ctx, "p2", consent, ConsentVoiceClone),
	} {
		if !errors.Is(check, ErrNotFound) {
			t.Errorf("%s: err = %v, want ErrNotFound", name, check)
		}
	}

	if _, ok, err := s.ActiveVoice(ctx, "p1"); err != nil || ok {
		t.Fatalf("ActiveVoice before any voice = %v, %v", ok, err)
	}
	if _, err := s.CreateVoiceProfile(ctx, "p1", consent, "mlx_old", DefaultLocale); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateVoiceProfile(ctx, "p1", consent, "mlx_new", DefaultLocale); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := s.ActiveVoice(ctx, "p1"); err != nil || !ok || v != "mlx_new" {
		t.Fatalf("ActiveVoice = %q, %v, %v; want the newest", v, ok, err)
	}

	// Revoking the consent retires its voices.
	if _, err := s.DB.Exec(`UPDATE consent SET revoked_at = 1 WHERE id = ?`, consent); err != nil {
		t.Fatal(err)
	}
	if err := s.ActiveConsent(ctx, "p1", consent, ConsentVoiceClone); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked consent: err = %v, want ErrNotFound", err)
	}
	if v, ok, err := s.ActiveVoice(ctx, "p1"); err != nil || ok {
		t.Fatalf("ActiveVoice after revoke = %q, %v, %v; want none", v, ok, err)
	}
}
