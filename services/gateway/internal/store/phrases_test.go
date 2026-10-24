package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestEnsurePersonSeedsStarterGroupsOnce(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for i, wantCreated := range []bool{true, false} {
		created, err := s.EnsurePerson(ctx, "p1", "Pat", DefaultLocale)
		if err != nil || created != wantCreated {
			t.Fatalf("call %d: created = %v, err = %v", i, created, err)
		}
	}
	groups, err := s.PhraseGroups(ctx, "p1", "v1")
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 2 || groups[0].Name != "Hospital" || groups[1].Name != "Demo" {
		t.Fatalf("groups = %+v", groups)
	}
	if got := groups[0].Phrases[0].Text; got != "I need some water" {
		t.Fatalf("first phrase = %q", got)
	}
	if groups[1].Phrases[0].Text != "Hi judges, I'll be demoing Cadence" {
		t.Fatalf("demo phrase = %q", groups[1].Phrases[0].Text)
	}
}

func TestPhraseCRUD(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.EnsurePerson(ctx, "p1", "Pat", DefaultLocale); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EnsurePerson(ctx, "p2", "Sam", DefaultLocale); err != nil {
		t.Fatal(err)
	}

	groupID, err := s.SaveGroup(ctx, "p1", "", "  Doctor  ", nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.SavePhrase(ctx, "p1", groupID, "  Is it   serious? ", DefaultLocale)
	if err != nil {
		t.Fatal(err)
	}
	if p.Text != "Is it serious?" {
		t.Fatalf("text not normalized: %q", p.Text)
	}
	dup, err := s.SavePhrase(ctx, "p1", groupID, "Is it serious?", DefaultLocale)
	if err != nil || dup.ID != p.ID {
		t.Fatalf("duplicate save: id %s vs %s, err %v", dup.ID, p.ID, err)
	}

	groups, _ := s.PhraseGroups(ctx, "p1", "v1")
	if len(groups) != 3 || groups[2].Name != "Doctor" || len(groups[2].Phrases) != 1 {
		t.Fatalf("groups after save = %+v", groups)
	}

	// Another person can't see, use, or delete p1's phrases and groups.
	if _, err := s.SavePhrase(ctx, "p2", groupID, "hi", DefaultLocale); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-person save err = %v", err)
	}
	if _, err := s.Phrase(ctx, "p2", p.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-person read err = %v", err)
	}
	if err := s.DeletePhrase(ctx, "p2", p.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-person delete err = %v", err)
	}

	if _, err := s.SavePhrase(ctx, "p1", groupID, "   ", DefaultLocale); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty phrase err = %v", err)
	}
	order := int64(0)
	if _, err := s.SaveGroup(ctx, "p1", groupID, "Dr. Lee", &order); err != nil {
		t.Fatal(err)
	}
	groups, _ = s.PhraseGroups(ctx, "p1", "v1")
	if groups[0].Name != "Dr. Lee" {
		t.Fatalf("rename/reorder: first group = %q", groups[0].Name)
	}

	if err := s.DeletePhrase(ctx, "p1", p.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeletePhrase(ctx, "p1", p.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete err = %v", err)
	}
	if err := s.DeleteGroup(ctx, "p1", groupID); err != nil {
		t.Fatal(err)
	}
	if groups, _ = s.PhraseGroups(ctx, "p1", "v1"); len(groups) != 2 {
		t.Fatalf("groups after delete = %d", len(groups))
	}
}

func TestClipCacheMarksAudioReady(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.EnsurePerson(ctx, "p1", "Pat", DefaultLocale); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.ClipID(ctx, "v1", "en", "I need some water"); ok {
		t.Fatal("clip exists before synthesis")
	}
	id, err := s.PutClip(ctx, "c1", "v1", "en", "I need some water")
	if err != nil || id != "c1" {
		t.Fatalf("put = %q, %v", id, err)
	}
	// A second synthesis of the same key keeps the first clip.
	if id, _ := s.PutClip(ctx, "c2", "v1", "en", "I need some water"); id != "c1" {
		t.Fatalf("duplicate put returned %q", id)
	}

	groups, _ := s.PhraseGroups(ctx, "p1", "v1")
	if !groups[0].Phrases[0].AudioReady || groups[0].Phrases[1].AudioReady {
		t.Fatalf("audioReady = %v, %v", groups[0].Phrases[0].AudioReady, groups[0].Phrases[1].AudioReady)
	}
	// A different voice has no clips yet.
	if groups, _ = s.PhraseGroups(ctx, "p1", "v2"); groups[0].Phrases[0].AudioReady {
		t.Fatal("clip leaked across voices")
	}
}
