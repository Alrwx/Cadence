# Dev 4 status and handoff

Owner: Dev 4 (gateway, data, consent, integration). Scope is in `AGENTS(GH).md` §7. Last updated 2026-10-24, at main `187274d` (PRs #8, #9, #10 merged).

Read this before working on `services/gateway`, `packages/protocol`, or the root `Makefile`. Agents: follow `AGENTS(GH).md` §8 too. This file only covers what's specific to the gateway right now.

---

## Done

### Gateway core
- [x] `cmd/gateway/main.go` serves:
  - TLS via mkcert, falling back to plain HTTP with a warning
  - `/ws` and `/clips/{file}`
  - `/healthz`, which proxies the model service's `/health`
  - the built apps at `/headset/` and `/phone/`
- [x] `internal/hub`: one session per `?session=`, one socket per role. A reconnect replaces the old socket. Binary frames from the phone go to `OnAudio`.
- [x] `internal/session`: the state machine from §3 (IDLE → LISTENING → SUGGESTING → CHOOSING / COMPOSING → SPEAKING). Inputs that aren't valid in the current state are ignored, never errors.
- [x] `internal/config`: env vars `GATEWAY_ADDR`, `MODELS_URL`, `DATA_DIR`, `TLS_CERT`, `TLS_KEY`, `WEB_ROOT`.
- [x] `internal/models`: HTTP client for `/health`, `/suggest` (3 s timeout) and `/tts` (6 s timeout), plus the `WS /stt` stream (`stt.go`).

### Data (`internal/store`)
- [x] Migration 001 creates every core table: `person`, `consent`, `voice_profile`, `phrase_clip`, `phrase_group`, `saved_phrase`, `contact`, `session`, `turn`, `audit_log`, `metric`, `saved_conversation`.
- [x] Migration 002:
  - adds `locale` to `person`, `voice_profile` and `saved_phrase`
  - rebuilds `phrase_clip` as a clip cache keyed by `(voice_id, locale, text)` with **no FK** to `voice_profile`
  - SQLite `busy_timeout(5000)`, so parallel clip writes wait for the lock instead of failing with "database is locked"
- [x] Single default person (`person_default`), seeded on first run with the **Hospital** and **Demo** starter groups.
- [x] Audit log: every utterance played is written to `audit_log` (`LogUtterance`) with source `suggestion` / `instant` / `saved` / `typed`.

### Saved phrases (PR #9)
- [x] CRUD over `phrase.speak/save/delete` and `phrase.group.save/delete`, scoped to the person (`ownsGroup`).
- [x] The headset gets a fresh `phrases` list on connect and after every change.
- [x] Clip cache (`orchestrator/clipcache.go`): a phrase is never synthesized twice. Concurrent requests for the same text share one `/tts` call.
- [x] Warm-up on headset connect pre-synthesizes instant and saved phrases (`warmClips`). A saved phrase is synthesized when it's saved.

### Suggestion pipeline (PR #10)
- [x] Phone mic frames go to `WS /stt`.
- [x] `transcript.partial` is broadcast, rate-limited to every 400 ms and muted while SPEAKING. `transcript.final` is broadcast too.
- [x] Each final starts a new turn: `turnId` `t_N`, LISTENING → SUGGESTING. Then `/suggest` with the last 20 turns, then `suggestions` and CHOOSING.
- [x] All three suggestions are synthesized ahead of time, and the headset gets `suggestion.audioReady` for each.
- [x] Results from a cancelled or superseded turn are dropped (`finishSuggesting`).
- [x] **Failures don't break the gateway.** A failed STT, `/suggest` or `/tts` call sends a recoverable `error`, and instant phrases and typing keep working. A failed STT dial backs off for 5 s; `phone.unlock` resets the backoff.

### Integration with main's clients (verified when PRs #9 and #10 merged)
- [x] Main's phone sends `hello` first and re-sends `phone.unlock` plus unsent `audio.done` after a reconnect. The gateway ignores the repeats and keeps the turn and the STT stream. Tests: `TestPhoneClientReconnects`, `TestPhoneReconnectKeepsTheTurn`.
- [x] `state` events carry `turnId`, so the shared store drops the previous turn's suggestions.

### Repo / protocol
- [x] `packages/protocol`: JSON schemas, examples, an in-repo codegen script for TS and Go (`pnpm protocol:gen`), and example tests on both sides.
- [x] `Makefile` targets: `setup`, `certs`, `dev`, `dev-mock`, `build`, `demo`, `test`, `typecheck`.
- [x] `docs/demo-script.md` exists, with the pre-demo checklist and the flow.

---

## Not done (priority order)

### P0: blocks the demo
- [ ] **`POST /api/consent` and `POST /api/voices` in the real gateway.**
  - The phone's voice-setup screen (PR #8, `apps/shared/src/voiceApi.ts`) calls them, and today only the mock gateway (`mocks/mock-gateway/src/server.ts`) has them.
  - This is demo step 1 (clone a voice). Spec: [Next task](#next-task-consent--voice-upload) below.
- [ ] **Use the person's current voice instead of the hard-coded one.**
  - `orchestrator.go` still uses the constant `defaultVoiceID = "default"` and a fixed `personID` (see its `TODO(Dev 4)`).
  - After a voice upload, `o.voiceID` must switch to the new voice. Each `voiceID` is a separate clip-cache key, so the new voice needs its own warm-up.
- [ ] **Re-synthesize saved and instant phrases when the voice changes.** This is mostly `warmClips` run against the new voice, followed by a fresh `phrases` list, since `audioReady` depends on the voice.
- [ ] **Robot-voice contrast (demo step 6).** Decide how the presenter switches back to a generic voice. Probably the model service's built-in voice, plus a control on the phone or headset. No protocol event exists for it yet.

### P1: M3/M4 polish
- [ ] **Revoking consent deletes everything (§2):**
  - the `voice_profile` row and the model service's copy (`DELETE /voices/{id}`)
  - the `phrase_clip` rows for that voice, plus their files in `<DATA_DIR>/clips`
  - Because the clip cache has no FK, this delete has to happen **in code**.
- [ ] **Speculation on partials (§3).** `/suggest` currently fires only on `final`. Plan:
  - debounce partials (~400 ms with no new words)
  - call `/suggest` on the partial transcript
  - cancel the call if the transcript changes
- [x] **Metrics** (`orchestrator/metrics.go`, `store/metrics.go`). Rows in `metric`, never content:
  - `suggest`: `/suggest` ms; detail `ok` / `error` / `timeout` / `cancelled` / `empty`
  - `tts`: `/tts` ms; detail is why the clip was made: `suggestion` / `instant` / `saved` / `typed` / `warm`, with `:error` on failure
  - `final_to_suggestions`: STT final → `suggestions` sent
  - `select_to_play`: selection → `audio.play` sent; detail `<source>:cached` or `<source>:synthesized` (the cache-hit flag)
  - `selection`: a count (no value); detail is the source
  - Read them with `GET /api/metrics/summary[?since=<unix ms>]`: count, p50, p95 and max per name (detail `*`) and per (name, detail).
- [x] **`session` / `turn` rows.** A `session` row is created (or reopened) on connect and gets `ended_at` when its last socket closes (`hub.DisconnectHandler`). A `turn` row is written for each final that starts a turn (`other`) and each reply sent to the phone (`user`). `store.AddTurn` checks `store_chat` consent itself, at write time, so `turn.text` is NULL without it.
- [ ] **Error routing.** `sendError` always targets the headset. That's fine for phrase and suggestion errors; voice-upload errors are HTTP responses, so they don't go through it.
- [ ] **Hotspot rehearsal 3× and a backup video (M4).** Both need the demo Mac.

### P2: stretch (M5)
- [ ] Saved conversations: `conversation.save/attach/delete` (schemas exist), `/summarize`, and attached summaries passed to `/suggest`. Needs `store_chat`. Store only the label and summary, never the transcript.
- [ ] Quick memories: a rolling 60 s transcript in memory, then `memory.save` → `/summarize` → passed to `/suggest`. No protocol schema yet.

### Cross-team items found while checking
- **Dev 3:** the model service's `/voices` has `transcript` as a **required** form field (`services/models/app/main.py`). The contract in §6.2 says `transcript?` is optional, and the phone doesn't send a transcript. Either Dev 3 makes it optional (the service then transcribes the sample with STT), or the gateway would have to send a transcript it doesn't have. **Option 1 is the right fix.**
- **Missing doc:** `apps/shared/src/voiceApi.ts` points to `docs/proposals/2026-10-24-voice-upload-endpoints.md`, which isn't in the repo. Whoever has it should commit it, or the comment should point here.

---

## Next task: consent + voice upload

**Contract.** The phone already implements this (`apps/shared/src/voiceApi.ts`) and the mock gateway is the reference behavior. Match the mock's status codes and JSON error shape `{ code, message }`.

| Route | Request | Success | Errors |
|---|---|---|---|
| `POST /api/consent` | JSON `{ sessionId, kind: "voice_clone", voiceOwner, statement }` (all non-empty strings) | `201 { consentId }` | `400 bad_request` |
| `POST /api/voices` | `multipart/form-data`: `audio` (file), `consentId`, `sessionId`; max 25 MB | `201 { voiceId }` | `400 bad_request`, `403 no_consent` (unknown or revoked consent), `413 too_large`, `502`/`503` if the model service fails |

**Implementation plan:**
1. **Migration `003_consent_details.sql`:** add `voice_owner TEXT` and `statement TEXT` to `consent`. `statement` is the locale key of the consent text that was shown. Never edit 001 or 002.
2. **Store functions:**
   - `CreateConsent(person, kind, owner, statement) (id)`
   - `ActiveConsent(id) error`
   - `CreateVoiceProfile(person, consentID, modelVoiceID, locale)`
   - `CurrentVoice(person) (modelVoiceID, ok)`, which returns the newest profile whose consent hasn't been revoked
3. **Model client:** add `CreateVoice(ctx, audio io.Reader, filename, consentID)` to `internal/models/client.go`. It sends multipart to `POST /voices`. Cloning takes longer than TTS, so give it a long timeout (~60 s).
4. **Handlers:** new `internal/api` package (or `cmd/gateway`), mounted on the mux as `POST /api/consent` and `POST /api/voices`. Wrap the upload in `http.MaxBytesReader`, so an oversized sample returns `413`.
5. **Orchestrator:**
   - After a voice is created, switch the voice: replace the `voiceID` field with a mutex-guarded getter, or read `CurrentVoice` from the store.
   - Kick off `warmClips` for the new voice, then send `phrases`.
   - On startup, load `CurrentVoice` and fall back to `"default"`.
6. **Tests:** reuse `fakeModels` in `orchestrator_test.go`; add a `/voices` case. Cover:
   - consent → upload → `voiceId`
   - an upload with no or unknown consent returns `403`
   - an oversized upload returns `413`
   - after an upload, `instant yes` makes a **new** `/tts` call with the new `voiceId`
7. **Vite proxies:** nothing to do. `apps/shared/vite.shared.ts` already proxies `/api` to `GATEWAY_TARGET`.

---

## Handoff guide for teammates and agents

### Map of the gateway
| File | What lives there |
|---|---|
| `cmd/gateway/main.go` | wiring, routes, TLS, default person |
| `internal/hub/hub.go` | WebSocket sessions; `Send` (one role) and `Broadcast` (both) |
| `internal/orchestrator/orchestrator.go` | event dispatch (`OnEvent`), `speak`, `apply` (state changes + broadcast), `sendError` |
| `internal/orchestrator/turns.go` | STT stream lifecycle, turns, `/suggest`, synthesizing suggestions ahead of time |
| `internal/orchestrator/phrases.go` | saved phrases, `sendPhrases`, `warmClips` |
| `internal/orchestrator/clipcache.go` | `clipFor`: cache lookup, shared synthesis of the same text |
| `internal/store/*.go` + `migrations/` | SQLite; migrations run in filename order and are applied once |
| `internal/models/` | the model-service client (HTTP + STT WebSocket) |

### Rules that are easy to break
- **Lock discipline.** `sessionState.mu` guards the machine, `turnID`, `suggestions` and `history`; methods named `...Locked` expect it held. `sttMu` guards only the STT stream; don't hold `mu` while dialing. Never call `s.Send` or `Broadcast` while holding `mu`.
- **Every state change goes through the machine:** `apply`, `beginTurn` or `finishSuggesting`. Async results must check that `turnID` is still current before acting (see `finishSuggesting` and `prepareSuggestion`).
- **Model-service failures** send a recoverable `error` and leave instant phrases and typing working. Never block a WebSocket read loop on a model call; use a goroutine, as `suggest` and `prepareClip` do.
- **No conversation text in SQLite without `store_chat` consent.** Metrics may always be stored; content may not. `audit_log` is the exception, since it's the safety record (§2).
- **Metric, session and turn writes go through `o.record` / `o.recordTurn`**, which queue them for one writer goroutine. Never write them inline on the event path. A full queue drops the row (logged) rather than blocking. Tests call `o.writer.flush()` before reading the tables.
- **The model service binds to 127.0.0.1.** Only the gateway is reachable from the network.
- **Protocol changes** start in `packages/protocol/schema/*.schema.json`. Then run `pnpm protocol:gen` and add an example. Fields are additive and optional; never rename.
- **Commits** say what changed and why, in plain words. No AI attribution trailers.

### Testing
- **Gateway:** `cd services/gateway && go vet ./... && go test ./...`. End-to-end tests run a real hub over `httptest` against `fakeModels`:
  - `pairedSession` connects a headset and a phone and unlocks.
  - `client.expect`, `expectState` and `expectStateTurn` read events.
  - Events sent on **one** socket are handled in order. To be sure earlier messages were processed, send `compose.start` from the same socket and wait for COMPOSING (see `TestSTTDownKeepsInstantPhrasesWorking`).
- **TS:** `make typecheck`, `make test-shared`, `make test-protocol`.
- **Before calling something done:** `make test`, then on the demo Mac `make build && USE_MOCK_MODELS=1 make dev`, then the phone + headset flow in Chrome or Quest.

### Windows dev machines
- `make`, `pnpm` and `uv` may not be installed. Run the package binaries directly, for example `cd apps/phone && node_modules/.bin/tsc --noEmit` and `cd apps/shared && node_modules/.bin/tsx --test src/*.test.ts`.
- `go test -race` may fail to start (exit `0xc0000139`, a missing race-runtime DLL). Run without `-race` there, and with it on the Mac.
- `gofmt -l` flags every file because of CRLF checkouts. Set `git config core.autocrlf input`, or ignore it; CI and the Mac see LF.

### Where things are decided
- `AGENTS(GH).md`: spec, contracts, roles.
- `docs/decisions.md`: append-only decision log; add an entry for any contract or architecture change.
- `docs/demo-script.md`: the flow that must always work.
- `docs/latency.md`: latency targets; needs the metrics above.
