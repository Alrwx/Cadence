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
// voiceOwner (whose voice is cloned) and statement are required for voice_clone; store_chat has no voice
// owner, and its statement is optional.
func (s *Store) CreateConsent(ctx context.Context, personID, kind, voiceOwner, statement string) (string, error) {
	var owner, shown sql.NullString
	switch kind {
	case ConsentVoiceClone:
		o, err := cleanText(voiceOwner, 120)
		if err != nil {
			return "", err
		}
		st, err := cleanText(statement, 120)
		if err != nil {
			return "", err
		}
		owner, shown = sql.NullString{String: o, Valid: true}, sql.NullString{String: st, Valid: true}
	case ConsentStoreChat:
		if st, err := cleanText(statement, 120); err == nil {
			shown = sql.NullString{String: st, Valid: true}
		}
	default:
		return "", fmt.Errorf("%w: unknown consent kind %q", ErrInvalid, kind)
	}
	id := newID("consent")
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO consent (id, person_id, kind, granted_at, voice_owner, statement) VALUES (?, ?, ?, ?, ?, ?)`,
		id, personID, kind, now(), owner, shown)
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
// The insert only happens if consentID is still an active voice_clone consent of personID, checked in the
// same statement, so a consent revoked while the model service was cloning never gets a voice: ErrNotFound.
func (s *Store) CreateVoiceProfile(ctx context.Context, personID, consentID, modelVoiceID, locale string) (string, error) {
	id := newID("voice")
	res, err := s.DB.ExecContext(ctx, `
		INSERT INTO voice_profile (id, person_id, consent_id, model_voice_id, locale, created_at)
		SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
			SELECT 1 FROM consent WHERE id = ? AND person_id = ? AND kind = ? AND revoked_at IS NULL)`,
		id, personID, consentID, modelVoiceID, locale, now(), consentID, personID, ConsentVoiceClone)
	if err != nil {
		return "", fmt.Errorf("create voice profile: %w", err)
	}
	if err := requireOne(res); err != nil {
		return "", err
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

// Revoking a voice consent (AGENTS(GH).md §2: revoking deletes the voice and all of its clips) happens in steps
// that each leave a safe state, so a crash or a model-service failure midway is finished by the next revoke:
//  1. RevokeVoiceConsents: from here on ActiveVoice ignores the voices, so nothing speaks in them, even after a
//     restart.
//  2. For each RevokedVoiceProfiles entry: delete the model service's copy, then the clips (VoiceClips, the
//     files, DeleteVoiceClips), then the profile (DeleteVoiceProfile). The profile goes last, and only once the
//     model service confirmed the delete, because it is the only record of which model voice to delete.

// VoiceProfile is a cloned voice: our id and the model service's voiceId ("" if it never got one).
type VoiceProfile struct {
	ID           string
	ModelVoiceID string
}

// RevokeVoiceConsents revokes every unrevoked voice_clone consent of personID and reports how many it revoked.
// The consent rows stay, with revoked_at set, as the record of what was agreed to and when it was withdrawn.
func (s *Store) RevokeVoiceConsents(ctx context.Context, personID string) (int64, error) {
	res, err := s.DB.ExecContext(ctx,
		`UPDATE consent SET revoked_at = ? WHERE person_id = ? AND kind = ? AND revoked_at IS NULL`,
		now(), personID, ConsentVoiceClone)
	if err != nil {
		return 0, fmt.Errorf("revoke voice consents: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("revoke voice consents: %w", err)
	}
	return n, nil
}

// RevokedVoiceProfiles lists personID's voices whose consent is revoked: the ones still to be deleted.
func (s *Store) RevokedVoiceProfiles(ctx context.Context, personID string) ([]VoiceProfile, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT v.id, COALESCE(v.model_voice_id, '') FROM voice_profile v JOIN consent c ON c.id = v.consent_id
		WHERE v.person_id = ? AND c.revoked_at IS NOT NULL ORDER BY v.created_at, v.rowid`, personID)
	if err != nil {
		return nil, fmt.Errorf("revoked voices: %w", err)
	}
	defer rows.Close()
	var out []VoiceProfile
	for rows.Next() {
		var p VoiceProfile
		if err := rows.Scan(&p.ID, &p.ModelVoiceID); err != nil {
			return nil, fmt.Errorf("revoked voices: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// VoiceClips lists the clip-cache ids for a model voiceId. Delete their files, then DeleteVoiceClips: in that
// order a crash leaves rows (found again next time), never files nobody can find.
func (s *Store) VoiceClips(ctx context.Context, modelVoiceID string) ([]string, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id FROM phrase_clip WHERE voice_id = ?`, modelVoiceID)
	if err != nil {
		return nil, fmt.Errorf("voice clips: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("voice clips: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// DeleteVoiceClips deletes the clip-cache rows with these ids for a model voiceId. Only the listed ids go, so
// a clip written after VoiceClips (whose file wasn't deleted) keeps its row and is found next time.
func (s *Store) DeleteVoiceClips(ctx context.Context, modelVoiceID string, ids []string) error {
	for _, id := range ids {
		if _, err := s.DB.ExecContext(ctx, `DELETE FROM phrase_clip WHERE id = ? AND voice_id = ?`, id, modelVoiceID); err != nil {
			return fmt.Errorf("delete voice clips: %w", err)
		}
	}
	return nil
}

// DeleteVoiceProfile deletes a voice profile row.
func (s *Store) DeleteVoiceProfile(ctx context.Context, personID, profileID string) error {
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM voice_profile WHERE id = ? AND person_id = ?`, profileID, personID); err != nil {
		return fmt.Errorf("delete voice profile: %w", err)
	}
	return nil
}
