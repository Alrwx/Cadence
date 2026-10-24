package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Consent kinds (the CHECK constraint on consent.kind).
const (
	ConsentVoiceClone = "voice_clone"
	ConsentStoreChat  = "store_chat"
)

// CreateConsent stores a granted consent record and returns its id.
// statement is the locale key of the consent text the user agreed to, so the record says what was shown.
func (s *Store) CreateConsent(ctx context.Context, personID, kind, voiceOwner, statement string) (string, error) {
	if kind != ConsentVoiceClone && kind != ConsentStoreChat {
		return "", fmt.Errorf("%w: unknown consent kind %q", ErrInvalid, kind)
	}
	owner, err := cleanText(voiceOwner, 120)
	if err != nil {
		return "", err
	}
	statement, err = cleanText(statement, 120)
	if err != nil {
		return "", err
	}
	id := newID("consent")
	_, err = s.DB.ExecContext(ctx,
		`INSERT INTO consent (id, person_id, kind, granted_at, voice_owner, statement) VALUES (?, ?, ?, ?, ?, ?)`,
		id, personID, kind, now(), owner, statement)
	if err != nil {
		return "", fmt.Errorf("create consent: %w", err)
	}
	return id, nil
}

// ActiveConsent reports whether consentID is a granted, unrevoked consent of kind for personID.
// A missing, revoked, other-kind or other-person consent is ErrNotFound.
func (s *Store) ActiveConsent(ctx context.Context, personID, consentID, kind string) error {
	var one int
	err := s.DB.QueryRowContext(ctx,
		`SELECT 1 FROM consent WHERE id = ? AND person_id = ? AND kind = ? AND revoked_at IS NULL`,
		consentID, personID, kind).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("check consent: %w", err)
	}
	return nil
}

// CreateVoiceProfile records a cloned voice. modelVoiceID is the voiceId the model service returned.
func (s *Store) CreateVoiceProfile(ctx context.Context, personID, consentID, modelVoiceID, locale string) (string, error) {
	id := newID("voice")
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO voice_profile (id, person_id, consent_id, model_voice_id, locale, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, personID, consentID, modelVoiceID, locale, now())
	if err != nil {
		return "", fmt.Errorf("create voice profile: %w", err)
	}
	return id, nil
}

// ActiveVoice returns the model service voiceId of the person's newest voice whose consent is still granted.
func (s *Store) ActiveVoice(ctx context.Context, personID string) (string, bool, error) {
	var voiceID string
	err := s.DB.QueryRowContext(ctx, `
		SELECT v.model_voice_id FROM voice_profile v JOIN consent c ON c.id = v.consent_id
		WHERE v.person_id = ? AND c.revoked_at IS NULL AND v.model_voice_id IS NOT NULL
		ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`, personID).Scan(&voiceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("active voice: %w", err)
	}
	return voiceID, true, nil
}
