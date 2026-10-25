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
	// And no voice can be added under it.
	if _, err := s.CreateVoiceProfile(ctx, "p1", consent, "mlx_late", DefaultLocale); !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateVoiceProfile under a revoked consent: err = %v, want ErrNotFound", err)
	}
	if _, err := s.CreateVoiceProfile(ctx, "p1", chat, "mlx_chat", DefaultLocale); !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateVoiceProfile under a store_chat consent: err = %v, want ErrNotFound", err)
	}
}

func TestRevokeVoiceConsents(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for _, p := range []string{"p1", "p2"} {
		if _, err := s.EnsurePerson(ctx, p, p, DefaultLocale); err != nil {
			t.Fatal(err)
		}
	}
	mustConsent := func(person, kind string) string {
		t.Helper()
		id, err := s.CreateConsent(ctx, person, kind, "Alex", "voice.consentCheck")
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	mustVoice := func(person, consent, model string) string {
		t.Helper()
		id, err := s.CreateVoiceProfile(ctx, person, consent, model, DefaultLocale)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	a, b := mustConsent("p1", ConsentVoiceClone), mustConsent("p1", ConsentVoiceClone)
	chat := mustConsent("p1", ConsentStoreChat)
	other := mustConsent("p2", ConsentVoiceClone)
	va, vb := mustVoice("p1", a, "mlx_a"), mustVoice("p1", b, "mlx_b")
	mustVoice("p2", other, "mlx_other")

	if left, err := s.RevokedVoiceProfiles(ctx, "p1"); err != nil || len(left) != 0 {
		t.Fatalf("revoked voices before a revoke = %+v, %v", left, err)
	}
	if n, err := s.RevokeVoiceConsents(ctx, "p1"); err != nil || n != 2 {
		t.Fatalf("RevokeVoiceConsents = %d, %v; want 2", n, err)
	}
	if n, err := s.RevokeVoiceConsents(ctx, "p1"); err != nil || n != 0 {
		t.Fatalf("second RevokeVoiceConsents = %d, %v; want 0", n, err)
	}
	if err := s.ActiveConsent(ctx, "p1", chat, ConsentStoreChat); err != nil {
		t.Fatalf("store_chat consent revoked too: %v", err)
	}
	if v, ok, _ := s.ActiveVoice(ctx, "p2"); !ok || v != "mlx_other" {
		t.Fatalf("another person's voice was revoked: %q, %v", v, ok)
	}
	left, err := s.RevokedVoiceProfiles(ctx, "p1")
	want := []VoiceProfile{{va, "mlx_a"}, {vb, "mlx_b"}}
	if err != nil || len(left) != 2 || left[0] != want[0] || left[1] != want[1] {
		t.Fatalf("RevokedVoiceProfiles = %+v, %v; want %+v", left, err, want)
	}

	// Clips: only the listed ids of that voice go.
	for i, v := range []string{"mlx_a", "mlx_a", "mlx_b", "default"} {
		if _, err := s.PutClip(ctx, "c_"+string(rune('0'+i)), v, DefaultLocale, "text "+string(rune('0'+i))); err != nil {
			t.Fatal(err)
		}
	}
	ids, err := s.VoiceClips(ctx, "mlx_a")
	if err != nil || len(ids) != 2 {
		t.Fatalf("VoiceClips = %v, %v", ids, err)
	}
	if err := s.DeleteVoiceClips(ctx, "mlx_a", append(ids[:1], "c_2")); err != nil { // c_2 is mlx_b's: untouched
		t.Fatal(err)
	}
	for voice, want := range map[string]int{"mlx_a": 1, "mlx_b": 1, "default": 1} {
		if got, _ := s.VoiceClips(ctx, voice); len(got) != want {
			t.Errorf("%s clips = %v, want %d", voice, got, want)
		}
	}

	if err := s.DeleteVoiceProfile(ctx, "p1", va); err != nil {
		t.Fatal(err)
	}
	if left, _ := s.RevokedVoiceProfiles(ctx, "p1"); len(left) != 1 || left[0].ID != vb {
		t.Fatalf("after deleting one profile: %+v", left)
	}
}
