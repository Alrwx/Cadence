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
