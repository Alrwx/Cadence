-- Private: only the server (service role) uses these; the phone gets audio through POST /tts.
insert into storage.buckets (id, name, public)
values
  ('voice-samples', 'voice-samples', false),
  ('audio-clips', 'audio-clips', false);
