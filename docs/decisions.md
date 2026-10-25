# Decisions

Append-only. One entry per decision: date, decision, why, who.

---

### 2026-10-24 – Quest 3S scaffold replaces the glasses scaffold
**Decision:** Removed the Ray-Ban Meta glasses scaffold (`apps/ios`, `apps/server`, `supabase`, `deploy`) and scaffolded the layout in `AGENTS(GH).md` §5: WebXR headset app, phone web app, Go gateway, Python model service, protocol package, mocks.
**Why:** The project moved to a Meta Quest 3S in passthrough; everything runs locally on the demo laptop.
**Who:** Alvin

### 2026-10-24 – Dev servers proxy to the gateway
**Decision:** The headset and phone Vite dev servers proxy `/ws` and `/clips` to the gateway (or the mock gateway via `GATEWAY_TARGET`), so the apps only use same-origin URLs in dev and in the built version the gateway serves.
**Why:** Avoids CORS and per-device URL config; the Quest and phone each accept one certificate.
**Who:** Alvin

### 2026-10-24 – Protocol codegen is a small in-repo script
**Decision:** `packages/protocol/scripts/generate.mjs` generates `ts/index.ts` and `go/events.go` from `schema/*.schema.json` (subset: objects, strings/enums, booleans, integers, arrays).
**Why:** No extra toolchain to install, and the schemas stay simple. Swap for a full generator if the schemas outgrow it.
**Who:** Alvin

### 2026-10-24 – Carry features over from the glasses design
**Decision:** Added to `AGENTS(GH).md` and the README: hands-free head-dwell selection and voice-sample recording on the phone (core, M3); starter saved-phrase groups, including the demo greeting; a clip cache keyed by voice, locale, and text; `locale` plumbing through the model service; quick memories and pointing at objects (stretch, M5). Contract changes are additive optional fields.
**Why:** These came out of the earlier glasses design and still fit the Quest 3S version. Head selection covers users who can't pinch; pointing at objects stays blocked until a spike gets camera frames out of Quest Browser.
**Who:** David

### 2026-10-24 – store_chat consent is set from the headset over the WebSocket
**Decision:** Added `consent.set { kind: "store_chat", granted }` (headset → gw) and `consent { storeChat }` (gw → headset, on connect and after any change). The headset asks for it the first time "Remember this" is pressed, and Settings can turn it off (which deletes every memory). Voice consent stays on the phone's `POST /api/consent`.
**Why:** `store_chat` is a setting the headset needs to read back to decide whether to prompt; the voice consent is a one-off signed statement tied to an upload.
**Who:** David

### 2026-10-24 – Saved phrases: edit before speaking, manage on the phone
**Decision:** A saved phrase can be spoken as-is or opened in "Type my own" prefilled, edited, and spoken as a typed reply (no new event; it goes out as `compose.submit`). Adding, editing, deleting, and reordering phrases and groups moves from the headset to the phone web app, so the phone also sends the `phrase.*` events and receives `phrases`.
**Why:** Small edits ("I need some water" → "I need some ice water") shouldn't mean typing from scratch, and managing lists is easier on a touchscreen than in XR.
**Who:** David

### 2026-10-24 – Suggestions run in Ollama on both machines
**Decision:** `/suggest` and `/summarize` call Gemma 4 (`gemma4:e4b`) through a local Ollama on `127.0.0.1:11434`, on the Mac and on the 3080 alike, instead of mlx-lm in-process. Requests use Ollama's JSON-schema `format`, `think: false`, and `keep_alive: -1`.
**Why:** One code path to test. Ollama runs Gemma 4 on MLX on the Mac and on CUDA on Linux. On the 3080, Gemma 4 can't load in the model service's own process anyway: it needs transformers 5, and qwen-tts pins transformers 4.57.3. Schema-constrained decoding makes parse failures rare. §4 already allowed "MLX or Ollama".
**Who:** PaoloAJ (Dev 3)

### 2026-10-24 – The "default" voice is a committed synthetic reference clip
**Decision:** The gateway's `voiceId: "default"` (used before anyone records a sample, and for the robot-voice contrast in demo step 6) clones `services/models/assets/default_voice.wav`. That clip was rendered once by `scripts/make_default_voice.py` with Qwen3-TTS CustomVoice's preset speaker "ryan".
**Why:** The Base model can only clone; it has no built-in voice. A committed clip keeps one code path (clone) on both backends and avoids loading a second TTS model. It's synthetic (Apache-2.0 model, no real person), so it needs no consent record. `DELETE /voices/default` is a no-op.
**Who:** PaoloAJ (Dev 3)

### 2026-10-24 – `/voices`: transcript optional, any container, voices kept on disk
**Decision:**
- `transcript` is optional. Without it, the service trims the sample to ≤ 15 s at a pause and transcribes it with Whisper. Samples need ≥ 3 s of speech.
- Uploads are decoded with PyAV (FFmpeg's libraries, bundled), so webm/opus, mp4/aac, and video files work without a system ffmpeg.
- Each voice is stored as `DATA_DIR/voices/<voiceId>/` (reference clip + transcript + consentId), so voiceIds survive a restart. `DELETE /voices/{id}` removes the folder.
- The service doesn't pre-synthesize instant phrases on `/voices`. The gateway's clip cache already warms them (`warmClips`), and the service never decides *when* to do work (§3).
**Why:** The phone never sends a transcript, so a required one returned 502 `model_error` on every real upload (`docs/dev4.md`, PR #13). Pre-synthesizing in two places would double the GPU work right after a voice switch.
**Who:** PaoloAJ (Dev 3)

### 2026-10-24 – The model service batches concurrent `/tts` calls
**Decision:** `/tts` requests for the same voice and language that arrive within 30 ms are synthesized as one batch (up to 4).
**Why:** On the 3080, 3 suggestions batched take 2.2 s, against about 1.8 s for one reply and 5–8 s for three in a row (`docs/latency.md`). Without batching, the third clip can exceed the gateway's 6 s `/tts` timeout. The gateway gets this for free when it requests the 3 suggestion clips concurrently.
**Who:** PaoloAJ (Dev 3)

### 2026-10-24 – Gemma 4 E4B shares the 3080 with STT and TTS, with expandable segments
**Decision:** On the 3080, Ollama serves `gemma4:e4b` on the same GPU as the model service, and the CUDA backend sets `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` by default.
**Why:** All three models fit in the 3080's 10 GB with about 250 MB to spare, and `/suggest` takes 389 ms p50, well under the 1.5 s budget (`docs/latency.md`). Without expandable segments, TTS ran out of memory in one of two benchmark runs. The margin is thin: if a batch of 4 or a longer context breaks it, switch Whisper to faster-whisper int8 (an estimated 1 GB less, not yet measured) before moving Gemma to another machine.
**Who:** PaoloAJ (Dev 3)

### 2026-10-24 – The robot voice is a `voice.use` switch; a lost cloned voice falls back to it
**Decision:**
- Added `voice.use { voice: "cloned" | "default" }` (phone or headset → gw) and `voice { active, cloned }` (gw → both, on connect and after any change). The gateway keeps the cloned voice and the "use the generic voice" choice apart, so switching for demo step 6 and back never loses the clone. Uploading a new voice switches back to it. The choice lives in memory only; a restart starts on the cloned voice.
- If `/tts` answers 404 for the cloned voice (the model service lost its files), the gateway makes that clip in `"default"`, stays on `"default"` until a new voice is recorded or the gateway restarts, tells the headset (`error voice_missing`), and broadcasts `voice` with `cloned: false`.
- `POST /api/voices` answers `503 models_unavailable` when the model service is unreachable or still loading, and keeps `502 model_error` for a sample the model service rejected.
**Why:** Demo step 6 needs a one-tap contrast. Without the fallback, a wiped voices folder made every clip fail until someone re-recorded. The phone should only ask for a new recording when the recording was the problem.
**Who:** Dev 4

### 2026-10-24 – `DELETE /api/voices` revokes voice consent and deletes the voice everywhere
**Decision:**
- `DELETE /api/voices` (phone, same origin rule as the other `/api` routes) revokes every unrevoked `voice_clone` consent of the person, then, for every voice under a revoked consent, deletes the model service's copy (`DELETE /voices/{id}`, 404 counts as done), the clip-cache rows and WAV files for that voiceId, and the `voice_profile` row. Sessions switch to `"default"`. Answers `204`, or `502 model_error` if the model service couldn't delete its copy.
- Order: revoke first (from then on `ActiveVoice` ignores the voice, even after a restart), then the model copy, then the clip files, then their rows, then the profile. The profile row is kept when the model delete fails, as the only record of which model voice to delete, so a repeated `DELETE` finishes the job. Consent rows stay, with `revoked_at` set, as the record of what was agreed and when it was withdrawn.
- The orchestrator remembers revoked voiceIds in memory: it never uses or caches a clip in one again, and a synthesis already running when the revoke lands deletes its own clip.
- `voice_profile` inserts check in the same statement that the consent is still active. An upload whose consent is withdrawn while the model service clones gets `403 no_consent`, and the gateway deletes the new model voice. It also deletes it if saving the profile fails for any other reason.
**Why:** §2: revoking consent deletes the voice and all of its clips. The clip cache has no FK to `voice_profile` (migration 002), so the delete happens in code, ordered so a crash at any step leaves no usable voice under a revoked consent.
**Who:** Dev 4

### 2026-10-24 – Speculative `/suggest` is reused when the final has the same words
**Decision:** The gateway calls `/suggest` on a partial transcript after 400 ms with no new words. When the final arrives, it reuses that answer only if (a) the final and the partial match after normalizing (lowercase, punctuation and symbols removed except apostrophes inside words, whitespace collapsed), and (b) the earlier turns sent with it are unchanged. Otherwise the speculative call is cancelled and `/suggest` runs on the final. A speculative answer is never shown before the final; it becomes the turn's suggestions through the usual final → SUGGESTING → CHOOSING path.
**Why:** Partials and finals from Whisper often differ only in case, commas, or a closing "?" or ".", and none of that changes which replies fit. Stripping all punctuation rather than only trailing punctuation catches the comma differences too. Any change in the words means the speaker said something else, so the answer is redone instead of guessing. The `speculation` metric (`hit`/`miss`/`none`/`failed`) shows how often this pays off.
**Who:** Alvin (Dev 4)
