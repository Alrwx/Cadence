-- Quick memories and saved conversations (AGENTS(GH).md §1, Dev 4 stretch). Both hold only an AI summary,
-- never transcript text, and both are deleted when store_chat consent is revoked.

CREATE TABLE memory (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    summary     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX memory_person ON memory (person_id, created_at);

-- Rebuilt to belong to the person rather than a session row: the gateway doesn't write session rows, session
-- ids are chosen by the client and reused ("demo"), and a saved conversation is attached in later sessions.
DROP TABLE saved_conversation;
CREATE TABLE saved_conversation (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX saved_conversation_person ON saved_conversation (person_id, started_at);
