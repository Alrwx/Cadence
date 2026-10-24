-- Tables from AGENTS(GH).md §7 (Dev 4). Conversation text lives only in `turn`, and only with store_chat consent.

CREATE TABLE person (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE consent (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('voice_clone', 'store_chat')),
    granted_at  INTEGER NOT NULL,
    revoked_at  INTEGER
);

CREATE TABLE voice_profile (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    consent_id  TEXT NOT NULL REFERENCES consent(id) ON DELETE CASCADE,
    model_voice_id TEXT,              -- voiceId returned by the model service
    created_at  INTEGER NOT NULL
);

-- Pre-synthesized clips for instant phrases and saved phrases.
CREATE TABLE phrase_clip (
    id          TEXT PRIMARY KEY,
    voice_id    TEXT NOT NULL REFERENCES voice_profile(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    path        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (voice_id, text)
);

CREATE TABLE phrase_group (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE saved_phrase (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES phrase_group(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    icon        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE TABLE contact (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    relation    TEXT
);

CREATE TABLE session (
    id          TEXT PRIMARY KEY,
    person_id   TEXT REFERENCES person(id) ON DELETE CASCADE,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER
);

CREATE TABLE turn (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    speaker     TEXT NOT NULL CHECK (speaker IN ('other', 'user')),
    text        TEXT,                 -- NULL unless store_chat consent is granted
    ts          INTEGER NOT NULL
);

-- Every utterance played (§2). Kept even without store_chat; it's the safety record.
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    clip_id     TEXT NOT NULL,
    text        TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('suggestion', 'instant', 'saved', 'typed')),
    ts          INTEGER NOT NULL
);

-- Latency and selection metrics; never conversation content.
CREATE TABLE metric (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT,
    name        TEXT NOT NULL,
    value_ms    INTEGER,
    detail      TEXT,
    ts          INTEGER NOT NULL
);

-- Stretch: saved conversations (requires store_chat).
CREATE TABLE saved_conversation (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    summary     TEXT,
    created_at  INTEGER NOT NULL
);
