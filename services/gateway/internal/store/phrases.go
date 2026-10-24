package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	DefaultLocale = "en"
	// MaxPhraseLen keeps saved phrases short enough to speak and to fit on a button.
	MaxPhraseLen = 200
	maxGroupName = 40
)

var (
	ErrNotFound = errors.New("not found")
	ErrInvalid  = errors.New("invalid")
)

type Phrase struct {
	ID         string
	GroupID    string
	Text       string
	Icon       string
	Locale     string
	AudioReady bool // a clip exists for the voice passed to PhraseGroups
}

type Group struct {
	ID      string
	Name    string
	Order   int64
	Phrases []Phrase
}

// Every new person starts with these groups (AGENTS(GH).md §7).
var starterGroups = []struct {
	name    string
	phrases []string
}{
	{"Hospital", []string{"I need some water", "I need to use the restroom", "I'm in pain", "Can you call my family?"}},
	{"Demo", []string{"Hi judges, I'll be demoing Cadence"}},
}

// EnsurePerson creates the person if they don't exist, seeding the starter phrase groups. It reports whether it created them.
func (s *Store) EnsurePerson(ctx context.Context, id, name, locale string) (bool, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		"INSERT INTO person (id, name, locale, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
		id, name, locale, now())
	if err != nil {
		return false, fmt.Errorf("insert person: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, nil
	}
	for gi, g := range starterGroups {
		groupID := newID("pg")
		if _, err := tx.ExecContext(ctx, "INSERT INTO phrase_group (id, person_id, name, sort_order) VALUES (?, ?, ?, ?)",
			groupID, id, g.name, gi); err != nil {
			return false, fmt.Errorf("seed group %s: %w", g.name, err)
		}
		for pi, text := range g.phrases {
			if _, err := tx.ExecContext(ctx,
				"INSERT INTO saved_phrase (id, group_id, text, locale, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				newID("ph"), groupID, text, locale, pi, now()); err != nil {
				return false, fmt.Errorf("seed phrase: %w", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

func (s *Store) PersonLocale(ctx context.Context, personID string) (string, error) {
	var locale string
	err := s.DB.QueryRowContext(ctx, "SELECT locale FROM person WHERE id = ?", personID).Scan(&locale)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("person locale: %w", err)
	}
	return locale, nil
}

// PhraseGroups returns the person's groups and phrases in display order. AudioReady is set for phrases
// that already have a clip in voiceID.
func (s *Store) PhraseGroups(ctx context.Context, personID, voiceID string) ([]Group, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT g.id, g.name, g.sort_order, p.id, p.text, COALESCE(p.icon, ''), p.locale, c.id IS NOT NULL
		FROM phrase_group g
		LEFT JOIN saved_phrase p ON p.group_id = g.id
		LEFT JOIN phrase_clip c ON c.voice_id = ? AND c.locale = p.locale AND c.text = p.text
		WHERE g.person_id = ?
		ORDER BY g.sort_order, g.rowid, p.sort_order, p.created_at`, voiceID, personID)
	if err != nil {
		return nil, fmt.Errorf("phrase groups: %w", err)
	}
	defer rows.Close()

	groups := []Group{}
	for rows.Next() {
		var g Group
		var pID, pText, pIcon, pLocale sql.NullString
		var ready bool
		if err := rows.Scan(&g.ID, &g.Name, &g.Order, &pID, &pText, &pIcon, &pLocale, &ready); err != nil {
			return nil, fmt.Errorf("scan phrase: %w", err)
		}
		if len(groups) == 0 || groups[len(groups)-1].ID != g.ID {
			g.Phrases = []Phrase{}
			groups = append(groups, g)
		}
		if pID.Valid {
			last := &groups[len(groups)-1]
			last.Phrases = append(last.Phrases, Phrase{
				ID: pID.String, GroupID: g.ID, Text: pText.String, Icon: pIcon.String, Locale: pLocale.String, AudioReady: ready,
			})
		}
	}
	return groups, rows.Err()
}

// Phrase returns one of the person's saved phrases.
func (s *Store) Phrase(ctx context.Context, personID, phraseID string) (Phrase, error) {
	var p Phrase
	err := s.DB.QueryRowContext(ctx, `
		SELECT p.id, p.group_id, p.text, COALESCE(p.icon, ''), p.locale
		FROM saved_phrase p JOIN phrase_group g ON g.id = p.group_id
		WHERE p.id = ? AND g.person_id = ?`, phraseID, personID).
		Scan(&p.ID, &p.GroupID, &p.Text, &p.Icon, &p.Locale)
	if errors.Is(err, sql.ErrNoRows) {
		return Phrase{}, ErrNotFound
	}
	if err != nil {
		return Phrase{}, fmt.Errorf("phrase: %w", err)
	}
	return p, nil
}

// SavePhrase adds a phrase to the end of one of the person's groups. Saving text that is already in the group
// returns the existing phrase instead of a duplicate.
func (s *Store) SavePhrase(ctx context.Context, personID, groupID, text, locale string) (Phrase, error) {
	text, err := cleanText(text, MaxPhraseLen)
	if err != nil {
		return Phrase{}, err
	}
	if err := s.ownsGroup(ctx, personID, groupID); err != nil {
		return Phrase{}, err
	}
	var existing string
	err = s.DB.QueryRowContext(ctx, "SELECT id FROM saved_phrase WHERE group_id = ? AND text = ?", groupID, text).Scan(&existing)
	if err == nil {
		return s.Phrase(ctx, personID, existing)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Phrase{}, fmt.Errorf("find duplicate: %w", err)
	}
	p := Phrase{ID: newID("ph"), GroupID: groupID, Text: text, Locale: locale}
	_, err = s.DB.ExecContext(ctx, `
		INSERT INTO saved_phrase (id, group_id, text, locale, sort_order, created_at)
		VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM saved_phrase WHERE group_id = ?), ?)`,
		p.ID, groupID, text, locale, groupID, now())
	if err != nil {
		return Phrase{}, fmt.Errorf("insert phrase: %w", err)
	}
	return p, nil
}

func (s *Store) DeletePhrase(ctx context.Context, personID, phraseID string) error {
	res, err := s.DB.ExecContext(ctx, `
		DELETE FROM saved_phrase
		WHERE id = ? AND group_id IN (SELECT id FROM phrase_group WHERE person_id = ?)`, phraseID, personID)
	if err != nil {
		return fmt.Errorf("delete phrase: %w", err)
	}
	return requireOne(res)
}

// SaveGroup creates a group (at the end) when groupID is empty, otherwise renames it. order, when set,
// moves the group to that zero-based position and shifts the others.
func (s *Store) SaveGroup(ctx context.Context, personID, groupID, name string, order *int64) (string, error) {
	name, err := cleanText(name, maxGroupName)
	if err != nil {
		return "", err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()
	if groupID == "" {
		groupID = newID("pg")
		_, err = tx.ExecContext(ctx, `
			INSERT INTO phrase_group (id, person_id, name, sort_order)
			VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM phrase_group WHERE person_id = ?))`,
			groupID, personID, name, personID)
		if err != nil {
			return "", fmt.Errorf("insert group: %w", err)
		}
	} else {
		res, err := tx.ExecContext(ctx, "UPDATE phrase_group SET name = ? WHERE id = ? AND person_id = ?", name, groupID, personID)
		if err != nil {
			return "", fmt.Errorf("update group: %w", err)
		}
		if err := requireOne(res); err != nil {
			return "", err
		}
	}
	if order != nil {
		if err := moveGroup(ctx, tx, personID, groupID, *order); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return groupID, nil
}

// moveGroup renumbers the person's groups 0..n-1 with groupID at position (clamped to the ends).
func moveGroup(ctx context.Context, tx *sql.Tx, personID, groupID string, position int64) error {
	rows, err := tx.QueryContext(ctx,
		"SELECT id FROM phrase_group WHERE person_id = ? AND id != ? ORDER BY sort_order, rowid", personID, groupID)
	if err != nil {
		return fmt.Errorf("list groups: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("scan group: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	position = max(0, min(position, int64(len(ids))))
	ids = append(ids[:position], append([]string{groupID}, ids[position:]...)...)
	for i, id := range ids {
		if _, err := tx.ExecContext(ctx, "UPDATE phrase_group SET sort_order = ? WHERE id = ?", i, id); err != nil {
			return fmt.Errorf("reorder group: %w", err)
		}
	}
	return nil
}

// DeleteGroup deletes a group and, by cascade, its phrases.
func (s *Store) DeleteGroup(ctx context.Context, personID, groupID string) error {
	res, err := s.DB.ExecContext(ctx, "DELETE FROM phrase_group WHERE id = ? AND person_id = ?", groupID, personID)
	if err != nil {
		return fmt.Errorf("delete group: %w", err)
	}
	return requireOne(res)
}

// ClipID returns the cached clip for this voice, locale, and text, if one exists.
func (s *Store) ClipID(ctx context.Context, voiceID, locale, text string) (string, bool, error) {
	var id string
	err := s.DB.QueryRowContext(ctx, "SELECT id FROM phrase_clip WHERE voice_id = ? AND locale = ? AND text = ?",
		voiceID, locale, text).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("clip lookup: %w", err)
	}
	return id, true, nil
}

// PutClip records a synthesized clip. If one already exists for the key, it keeps and returns the existing id.
func (s *Store) PutClip(ctx context.Context, id, voiceID, locale, text string) (string, error) {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO phrase_clip (id, voice_id, locale, text, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (voice_id, locale, text) DO NOTHING`, id, voiceID, locale, text, now())
	if err != nil {
		return "", fmt.Errorf("insert clip: %w", err)
	}
	stored, _, err := s.ClipID(ctx, voiceID, locale, text)
	return stored, err
}

func (s *Store) ownsGroup(ctx context.Context, personID, groupID string) error {
	var one int
	err := s.DB.QueryRowContext(ctx, "SELECT 1 FROM phrase_group WHERE id = ? AND person_id = ?", groupID, personID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("find group: %w", err)
	}
	return nil
}

func cleanText(s string, max int) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", fmt.Errorf("%w: empty", ErrInvalid)
	}
	if utf8.RuneCountInString(s) > max {
		return "", fmt.Errorf("%w: longer than %d characters", ErrInvalid, max)
	}
	return s, nil
}

func requireOne(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func newID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func now() int64 { return time.Now().UnixMilli() }
