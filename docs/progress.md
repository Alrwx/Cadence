# Progress catalog

What has landed on `main` (PRs #1–#29, 2026-10-24 to 2026-10-25), what's still open, and where to look. Snapshot at main `cbdb40d`. The spec stays in `AGENTS(GH).md`; per-dev detail is in `docs/dev2/`, `docs/dev3.md` and `docs/dev4.md`; decisions are in `docs/decisions.md`. Update this file when a PR changes the picture.

---

## 1. Where we are against the milestones

| Milestone | State |
|---|---|
| M0 Skeleton | Done (#1–#4): monorepo, protocol schemas + examples + codegen, mocks, Makefile. |
| M1 Spikes | Done on the RTX 3080 (TTS cloning, Gemma suggestions, STT). **Not done on the M4 Pro** (MLX backends never run). Hand pinch in `immersive-ar` is covered by IWER emulator tests, not yet re-verified on a physical Quest in this log. |
| M2 Vertical slice | Done: phone mic → STT → `/suggest` → headset → `audio.play` (#10, #18). |
| M3 Fast path | Mostly done: speculation, instant gestures, saved phrases, head dwell, voice sample recording, consent, "I'm answering" ring. Open: phone voice toggle and "Delete my voice" UI (see §4). |
| M4 Demo-ready | Not started: needs the demo Mac, hotspot rehearsal 3×, backup video. |
| M5 Stretch | Saved conversations and quick memories are done end to end. Pointing at objects passed Phase 0 (camera spike on a Quest 3S, 2026-10-25); Phase 1 contracts are next. |

---

## 2. What was built, by area

### Headset (`apps/headset`, Dev 1)
- **Gestures and input** (#1–#5 era): gesture classifier using palm direction and hand-size ratios, e2e tests in the IWER emulator, build tooling that works without a Quest, head-dwell hands-free selection, UI recentered on the head, slow-pinch fix.
- **Panel views:** saved phrases, "Type my own", bookmarking (#5); saved conversations panel (#14); quick memories with `store_chat` consent, review fixes for late saves, Undo timing and long summaries (#11).
- **Listener replies** (#12): reply bubbles beside the listener once the user has shown where they are, with pitch offset, status colour and cancel placement fixes. Also: stop presses nobody chose (dwell, stale pinches, lost hands).
- **Liquid-glass buttons** (#25): one glass shader for all buttons; head dwell fills the glass from the bottom so a hands-free user sees the time left; presses squish; the hit mesh never moves. Settings has Buttons: Glass / Solid for users who need opaque buttons.
- **Main menu button** (#28): a menu button in the top bar of every view, because Back sat below the field of view in the headset.
- **Reset conversation** (#28): button beside "Remember this" (two presses, like Delete). Clears captions, replies and attachments locally and sends `conversation.reset`.

### Phone and shared client (`apps/phone`, `apps/shared`, `mocks/mock-gateway`, Dev 2)
- **Shared client** (#5): `hello` sent first, `onOpen` hook on every reconnect, events from replaced sockets ignored (fixes the StrictMode leak), new turn clears old suggestions, `locales/en.json` + `t()`.
- **Playback reliability** (#7): clip queue with `audio.done`, `phone.unlock` re-sent on reconnect, wake lock, held clips before Start, timeouts.
- **Voice setup** (#8): consent step, record up to 30 s or pick a file, preview, upload through `voiceApi`.
- **Mock gateway** (#6): phrase groups, spec starter groups (Hospital, Demo), consent and voice routes, scripted scenarios.
- **Saved-phrase management** (#20): `PhraseManager.tsx` for add, edit, delete and reorder phrases and groups. The proposal `2026-10-24-phone-phrase-management.md` lists the gateway gaps it needed.
- **Desktop test bench** (#23, #26): `apps/phone/test.html` runs the phone plus a clickable stand-in headset in one browser tab, so nobody needs a Quest to exercise the flow. It can also type what the listener said (uses `listener.say`), and its errors clear themselves.
- **Camera spike** (#29): `apps/phone/camera-spike.html` + `src/spike/cameraSpike.ts`, with a mock `POST /api/spike/frame`. Phase 0 of pointing at objects.

### Gateway (`services/gateway`, Dev 4)
- **Core:** hub (one socket per role), state machine, TLS, static hosting, `/clips`, `/healthz`, SQLite with migrations 001–004, audit log of every utterance.
- **Saved phrases** (#9): CRUD, clip cache keyed `(voice, locale, text)` with shared in-flight synthesis, warm-up on connect.
- **Suggestion pipeline** (#10): phone audio → STT, rate-limited partials, per-turn `/suggest`, all three replies pre-synthesized, stale `turnId` results dropped, failures degrade to instant phrases and typing.
- **Consent and voice upload** (#13): `POST /api/consent`, `POST /api/voices` (403/413/502/503 as specified), live voice switch, re-warm in the new voice, last voice reloaded on restart, origin check on `/api` routes.
- **Voice features:** robot-voice switch (`voice.use` / `voice` events, lost-voice fallback to `default`), revoking consent deletes the voice, its clips and its profile in a retry-safe order.
- **Speculation** (#20-era): `/suggest` on a 400 ms debounced partial, reused only when the final has the same words (rule in `decisions.md`). Metrics and `session`/`turn` rows (no text), readable at `GET /api/metrics/summary`.
- **`store_chat`, quick memories, saved conversations** (#22): `consent.set`/`consent`, `memory.*`, `conversation.*`, summaries only, migration 004, revoking deletes both. Review fixes: conversation boundary (last save or 10-minute silence), one summary at a time, saves tied to the consent active at tap time, `/summarize` timeout 12 s.
- **Dev tooling:** `listener.say` event to type what the listener said (#21), `make demo` override fix. `conversation.reset` also detaches attached saved conversations (#28).
- **Integration** (#21): gateway verified against the phone's reconnect behavior and the real model service.

### Model service (`services/models`, Dev 3)
- All §6.2 routes are real (#18): `/health`, `WS /stt`, `/suggest`, `/summarize`, `/tts`, `/voices` (transcript optional, any container), `DELETE /voices/{id}`.
- **Backends:** CUDA for the RTX 3080 (verified), Ollama for Gemma 4 E4B on both machines (verified on the 3080), MLX for the Mac (written, **never run**).
- TTS batches concurrent requests for one voice (up to 4 within 30 ms). Gemma shares the 3080 with STT and TTS using `expandable_segments`; peak 9,994 of 10,240 MiB.
- Measured on the 3080 (`docs/latency.md`): STT final 620 ms p50 after the speaker stops, `/suggest` 389 ms p50, three suggestion clips 2.2–3.2 s p50.
- **Topic switch** (#24): the prompt repeats the last line as the thing every reply answers. Stale replies went from about 6/150 to 1/150, p50 +30 ms.
- Mock models mirror the contract (optional transcript, 400 without `consentId`).

### Protocol (`packages/protocol`)
Added since the core set: quick memories and `store_chat` events, saved conversations, `conversation.reset`, `listener.say`, `voice.use` / `voice`. All additive; each has an example and is parsed in TS and Go.

### Docs
Dev 2 plan/log, Dev 3 and Dev 4 status + handoff, `latency.md`, decision log (17 entries), proposals for phrase management, robot-voice toggle, shared-connection stale socket, and pointing at objects.

---

## 3. Decisions worth knowing (full text in `decisions.md`)
- Suggestions run through Ollama on both machines; `default` voice is a committed synthetic clip.
- `turn.text` is never stored, even with `store_chat`; only summaries reach SQLite.
- Saved conversations belong to the person, not a session; revoking `store_chat` deletes them and all memories.
- Speculative `/suggest` is reused only when the final has the same normalized words.
- Revoking voice consent deletes everything under it, ordered so a retry can finish.

---

## 4. Remaining work

### P0: blocks the demo
- [ ] **Run the MLX backends on the M4 Pro** (`MODELS_BACKEND=mlx make models`, then `scripts/bench_pipeline.py`). Likely fixes are in `app/backends/mlx.py`. Owner: Dev 3.
- [ ] **Check `/suggest` quality and latency on the Mac** (budget < 1.5 s, clear yes/no reply). Owner: Dev 3.
- [ ] **Phone voice toggle and "Delete my voice"** (robot-voice contrast, demo step 6). Gateway side is done; the phone/headset UI is only a proposal (`2026-10-24-robot-voice-toggle.md`). Owner: Dev 2.
- [ ] **Clear old `.env` values** for `STT_MODEL` / `TTS_MODEL` on every machine.
- [ ] **Real-phone test** (iOS Safari, Android Chrome): captions, ring, clip after Start, reconnect, voice recording. Owner: Dev 2.
- [ ] **Full demo flow on the hotspot with real models**, 3× in a row, plus a backup video (M4). Owner: Dev 4.

### P1: polish and risk
- [ ] `warmClips` sends `/tts` one phrase at a time (about 18 s for 10 phrases after a voice switch); send up to 4 at once to use batching. Owner: Dev 4.
- [ ] Pass the model service's `400 detail` (for example "needs at least 3 seconds of speech") through to the phone instead of a generic `502`. Owner: Dev 4.
- [ ] `sendError` always targets the headset; route by origin. Owner: Dev 4.
- [ ] 3080 VRAM margin is about 250 MB; test a batch of 4 beside Gemma and a cold start of the whole stack. Fallback order: faster-whisper int8, then `gemma4:e2b`. Owner: Dev 3.
- [ ] STT hallucination guard for room noise (only no-letter output is dropped). Owner: Dev 3.
- [ ] Missing doc: `apps/shared/src/voiceApi.ts` points to `docs/proposals/2026-10-24-voice-upload-endpoints.md`, which isn't in the repo. Commit it or fix the comment. Owner: Dev 2.
- [ ] `make test-phone`, ESLint setup, and the headset moving its strings to `@cadence/shared/i18n`: still open from the Dev 2 questions.
- [ ] On-device checklist in `docs/demo-script.md` has not been ticked on a Quest. Owner: Dev 1.
- [ ] Update `docs/dev4.md` (last updated at `187274d`; the P0 consent/voice items there are now done) and `docs/dev2/plan.md` so they don't contradict this file.

### P2: pointing at objects (stretch, plan in `docs/proposals/2026-10-25-pointing-at-objects.md`)
- [x] **Phase 0: run the camera spike on the Quest 3S** and record the result in `decisions.md` (Quest OS, browser version, camera labels, frames inside AR). Go/no-go for everything below. Owner: Dev 1 or Dev 2. Passed 2026-10-25.
- [ ] Phase 1 contracts: `POST /api/look`, `look.result`, model-service `POST /look`, `target` on `/suggest`, `Looked` state-machine input. Owner: Dev 4.
- [ ] Phase 2 builds: `/look` and `target` prompt + mock + latency numbers (Dev 3); `/api/look`, target lifetime, metrics (Dev 4); dwell-on-empty-space trigger, "What's this?" button, label and settings toggle (Dev 1); test-bench "Look at" card, mock `/api/look`, `lookApi.ts` (Dev 2).
- [ ] Phase 3: integration on the hotspot and a new step in `demo-script.md`.
- [ ] Fallbacks if the spike fails: 2D camera outside AR, phone camera, or a test-bench demo.

### Open questions (from §11 of the spec, still unresolved)
Final app name; primary user group for the pitch; face-anchored bubbles (same camera question); head gestures in hands-free mode; Gemma audio input replacing Whisper; whether the 3080 server is used at all.

---

## 5. Quick pointers
- Run without a Quest: `make dev-mock`, then open `apps/phone/test.html` through the phone dev server.
- Gateway tests: `cd services/gateway && go vet ./... && go test ./...`. Models: `cd services/models && uv run pytest`. TS: `make typecheck`, `make test-shared`, `make test-protocol`.
- Protocol changes start in `packages/protocol/schema`, then `pnpm protocol:gen`, then add an example.
