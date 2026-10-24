-- Saved phrases, locale plumbing, and a clip cache keyed by (voice, locale, text) (AGENTS(GH).md §7, Dev 4).

ALTER TABLE person ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
ALTER TABLE voice_profile ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
ALTER TABLE saved_phrase ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';

-- Rebuilt: voice_id is now the model service's voiceId, with no foreign key, so clips work before voice
-- profiles exist (the "default" voice). Revoking a voice deletes its clips in code. Files live at <clips>/<id>.wav.
DROP TABLE phrase_clip;
CREATE TABLE phrase_clip (
    id          TEXT PRIMARY KEY,
    voice_id    TEXT NOT NULL,
    locale      TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (voice_id, locale, text)
);

CREATE INDEX phrase_group_person ON phrase_group (person_id, sort_order);
CREATE INDEX saved_phrase_group ON saved_phrase (group_id, sort_order);
