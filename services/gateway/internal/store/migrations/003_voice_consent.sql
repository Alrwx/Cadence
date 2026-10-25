-- Voice-clone consent from the phone's voice setup (AGENTS(GH).md §2: no voice without a stored consent record).

-- Whose voice is being cloned, as typed on the phone, and the locale key of the consent text that was shown.
ALTER TABLE consent ADD COLUMN voice_owner TEXT;
ALTER TABLE consent ADD COLUMN statement TEXT;

CREATE INDEX voice_profile_person ON voice_profile (person_id, created_at);
