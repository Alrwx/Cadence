-- The model service's "default" voice can be rebuilt from another recording under the same voiceId. This is
-- the version (models /health defaultVoice) the cached default-voice clips were made in.
CREATE TABLE default_voice (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL
);
