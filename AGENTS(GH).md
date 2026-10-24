# AGENTS.md

Instructions for the four developers on this project **and the AI coding agents (subagents) each of them runs**. Read the whole file once, then work from your role section.

> **Project codename:** TBD (candidates: Timbre, Cadence, Still Me). Replace `<app>` below once chosen.
> **Event:** GatorHacks '26

---

## 1. What we're building

An assistive communication app for people who **can't speak or struggle to speak** (stroke/aphasia, laryngectomy, vocal-cord paralysis, and similar).

1. Someone talks to the user. A **phone** placed between them picks up the speech.
2. The speech is transcribed, and an on-device language model suggests **three short replies** that fit the conversation and the user's personal style.
3. The user, wearing a **Meta Quest 3S** in passthrough (they still see the room and the person), picks a reply with their **hands** (pinch, poke, or a quick gesture).
4. The reply is spoken from the phone **in the user's own voice**, cloned from a few seconds of old audio (a voicemail or home video) or a ~30-second sample recorded on the phone, or in a consented voice they choose.

### Hands-free selection (core accessibility)
Some users can't pinch reliably (one-sided weakness after a stroke, tremor, limited hand control). Everything selectable (replies, instant phrases, saved phrases, the word board) can also be picked **with head movement alone**:
- A small reticle sits at the center of the user's view. Holding it on a target for a dwell time (default ~800 ms, shown as a filling ring) selects it.
- Looking away before the ring fills cancels, and nothing selects while the head is moving quickly.
- Dwell time, reticle size, and movement tolerance live in the same config file as the hand-gesture thresholds.
- Input mode (hands, head, or both) is a per-user setting stored on the headset.

### Saved phrases (core feature)
Users can **bookmark phrases** they say often, grouped by context, so they're one pinch away without waiting for suggestions. Example: a patient in a hospital keeps a "Hospital" group with "I need some water", "I need to use the restroom", "I'm in pain", "Can you call my family?" and uses it when the nurse comes in.
- Phrases can be added by typing, or by bookmarking a suggestion or typed reply right after it's spoken.
- Each saved phrase is **pre-synthesized in the user's voice when it's saved**, so it plays as fast as the instant tier.
- Groups (e.g. "Hospital", "Home", "Doctor") can be reordered, renamed, and deleted; phrases can be edited or removed.
- Saved phrases are user-authored, not conversation content, so they don't need `store_chat` consent. They are still local-only.

### Saved conversations (stretch goal)
Users can **save a conversation** (e.g. a doctor's appointment) and reference it in later conversations, so the next visit's suggestions know what was discussed ("Did the new medication help?" → a reply that remembers which medication).
- **Opt-in per conversation:** requires `store_chat` consent *and* an explicit "Save this conversation" action with a label (e.g. "Dr. Lee – Oct 24"). Nothing is saved by default.
- Saved conversations are browsable (transcript + optional short summary) and **deletable at any time**; deletion removes transcript, summary, and any derived context.
- At the start of a conversation the user can attach one or more saved conversations as context; the gateway passes a summary of them to `/suggest`.
- Local-only like everything else; never sent to a remote API.

### Quick memories (stretch goal)
A lighter version of saved conversations. At any moment the user can pick **"Remember this"**, and the gateway summarizes the last ~60 seconds of the conversation into a short memory ("The nurse said the doctor visits at 3 pm."). The most recent memories go to `/suggest` automatically, so later suggestions can use them without attaching anything.
- Requires `store_chat` consent. Only the summary is stored; the rolling 60-second transcript lives in gateway memory and is never written to disk.
- Summaries keep names, numbers, times, and instructions exactly as said.
- Memories are listed in a panel and deletable one by one; revoking `store_chat` deletes all of them.

### Pointing at objects (stretch goal, blocked on camera access)
The user holds the reticle on an object in the room (a cup, the TV remote, a blanket); the app recognizes it and the suggestions become requests about it ("Can you hand me the water?"). This needs frames from the Quest's passthrough cameras, and Quest Browser's WebXR doesn't expose them today (requesting the `camera-access` feature fails as of early 2026). Candidates to spike: `getUserMedia` in Quest Browser (reported to work, but frames aren't aligned with head pose), or the phone camera. **Don't start until a spike gets frames to the gateway.**

### Languages
English only for the demo, but nothing hard-codes it. Each person has a `locale` that is passed to `/stt`, `/suggest`, and `/tts`; saved phrases store their locale; UI strings in both apps come from locale-keyed files (`apps/shared/locales/en.json`). Adding a language later should be translation work, not plumbing.

**Why AR and not a tablet:** reply options float beside the listener's face, so the user keeps eye contact instead of looking down at a screen. The listener sees an "I'm answering" indicator on the phone so silence isn't mistaken for "done."

### Demo goal (the one flow that must always work)
1. Play a 10-second clip of a teammate's voice and create the clone (with the consent step).
2. The patient opens Saved phrases → Demo → "Hi judges, I'll be demoing Cadence"; the phone greets the judges in the cloned voice.
3. A judge asks the "patient" a question.
4. The patient pinches a suggested reply; the phone speaks it in the cloned voice within a few seconds.
5. The patient gives an instant thumbs-up; the phone says "Yes" in under a second.
6. Replay the same exchange with a generic robot voice for contrast.

---

## 2. Non-negotiables (every agent must respect these)

- **Local-first.** Conversations, transcripts, and voices never leave the demo laptop by default. No third-party API calls unless a fallback flag is explicitly enabled.
- **Consent before cloning.** No voice profile is created without a stored consent record. Revoking consent deletes the voice and all of its clips.
- **"Type my own" is always one action away.** Suggestions must never be the only way to speak.
- **No silent speaking.** Audio plays only after an explicit user selection. Nothing auto-speaks.
- **Spoken-audio audit log.** Every utterance played is logged (text, time, source: suggestion / instant / typed).
- **Don't store conversation text unless the `store_chat` consent is granted.** Metrics (latency, selection type) may always be stored; content may not.
- **No secrets in the repo.** Use `.env` files (git-ignored) and `.env.example`.

---

## 3. Architecture

```
            ┌──────────────────────── demo LAN / hotspot (HTTPS + WSS) ──────────────────────┐
            │                                                                                 │
 ┌──────────┴───────────┐          ┌──────────────────────────────┐          ┌───────────────┴──────┐
 │  Quest 3S (browser)   │  WSS     │   Go gateway  (services/gateway)  WSS   │  Phone (browser)      │
 │  apps/headset         │◄────────►│   • TLS, static hosting       │◄────────►│  apps/phone           │
 │  React Three Fiber +  │  events  │   • session state machine     │  events  │  • mic → PCM16 16 kHz │
 │  WebXR immersive-ar   │          │   • event hub (WebSocket)     │  + audio │  • plays reply clips  │
 │  • hand input/gestures│          │   • orchestration/speculation │   frames │  • captions + "I'm    │
 │  • reply bubbles      │          │   • SQLite (consent, profiles,│          │    answering" ring    │
 └───────────────────────┘          │     audit log, metrics)       │          └──────────────────────┘
                                    │   • clip cache  /clips/{id}   │
                                    └──────────────┬───────────────┘
                                                   │ HTTP + WS on 127.0.0.1 only
                                    ┌──────────────┴───────────────┐
                                    │  Python model service         │
                                    │  (services/models, FastAPI)   │
                                    │  • STT     mlx-whisper        │
                                    │  • Suggest Gemma 4 (MLX/Ollama)│
                                    │  • TTS     Qwen3-TTS (mlx-audio)│
                                    │  • voice prompt cache         │
                                    └──────────────────────────────┘
```

**Rules of the architecture**
- The **gateway is the only process reachable from the network.** The model service binds to `127.0.0.1` only.
- Clients (headset, phone) talk **only** to the gateway, using the event protocol in `packages/protocol`.
- The **gateway orchestrates**; the model service is stateless apart from loaded models and the voice prompt cache. It never decides *when* to do something.
- Every model sits behind an interface in the model service, so a backend can be swapped (MLX on the Mac ↔ CUDA on the RTX 3080 server ↔ hosted fallback) with config only.

### The key latency trick: speculation
Don't wait for the speaker to finish.
1. While `transcript.partial` events stream in, the gateway debounces (~400 ms of no new words, tunable) and calls `/suggest` on the partial transcript.
2. For the returned top 3 replies, the gateway immediately calls `/tts` in the background and caches the clips.
3. When the user selects, the gateway sends `audio.play` with a clip that is usually **already synthesized**.
4. Every request carries a `turnId`. New speech for the same turn cancels or ignores stale suggestions and clips.

### Three response tiers
| Tier | Example | Target | How |
|---|---|---|---|
| Instant | "Yes", "No", laugh, "Give me a second" | < 1 s | Pre-synthesized at voice-creation time, triggered by gestures |
| Saved | "I need some water", "I need to use the restroom" | < 1 s | User-bookmarked phrases, pre-synthesized when saved, picked from the saved-phrases panel |
| Quick | The 3 suggested replies | 2–3 s after the speaker stops | Speculation (above) |
| Composed | "Type my own" | User-paced | Virtual keyboard / word board in XR, TTS on submit |

These latency numbers are **design targets, not measurements.** Measure them (see §9).

### Session state machine (owned by the gateway)
```
IDLE → LISTENING ──(speech ends)──► SUGGESTING ──(suggestions ready)──► CHOOSING
                ▲                                                        │  │
                │                                         select/instant │  │ compose.start
                │                                                        ▼  ▼
                └──────────────(clip finished)────────── SPEAKING ◄── COMPOSING
```
`state` events are broadcast to both clients on every transition. The phone shows the "I'm answering" ring during `CHOOSING` and `COMPOSING`.

---

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm workspaces (JS/TS) + Go module + uv (Python) | One repo, one `Makefile` / `justfile` at the root |
| Headset UI | Vite + React + TypeScript + **React Three Fiber** + `@react-three/xr` + `@react-three/drei` | WebXR `immersive-ar` (passthrough) in Quest Browser |
| Phone UI | Vite + React + TypeScript | Plain web page, no app install |
| Client state | Zustand | Shared store shape across both apps |
| Protocol | JSON Schema in `packages/protocol` → generated TS types + Go structs | Single source of truth for events |
| Gateway | **Go** (1.22+ `net/http` routing), `github.com/coder/websocket`, `modernc.org/sqlite` (pure Go, no cgo) | Serves built frontends + WSS + `/clips` |
| Model service | **Python 3.12**, FastAPI, uvicorn, managed with **uv**, `ffmpeg` | Binds to 127.0.0.1:8000; ffmpeg pulls the audio out of uploaded voice-sample videos |
| STT (Mac) | `mlx-whisper` (large-v3-turbo; smaller model if memory is tight) | Fallback backend: `faster-whisper` on the CUDA server |
| Suggestions | **Gemma 4 E4B, 4-bit** via MLX (`mlx-lm`) or Ollama | Try E2B if quality is equal; 12B fits in 24 GB but is slower |
| TTS / cloning | **Qwen3-TTS 0.6B Base** via `mlx-audio` (community MLX port) | 1.7B Base for quality if fast enough. Fallback: official Qwen3-TTS on the RTX 3080 |
| Storage | SQLite (gateway) + files in `data/` | Encryption at rest = FileVault for the hackathon; SQLCipher is a stretch goal |
| TLS (dev) | `mkcert` local CA | Quest and phone show a one-time certificate warning to accept |
| TLS (remote fallback) | Cloudflare Tunnel + Cloudflare Access → home server | Only if the 3080 server is used |
| Demo hardware | MacBook Pro M4 Pro, 24 GB + Quest 3S + phone + own hotspot | Do not rely on venue Wi-Fi |

**Unverified assumptions (verify early, record results in `docs/decisions.md`):**
- mlx-audio's Qwen3-TTS port supports cloning with the 0.6B Base model at usable speed on the M4 Pro.
- Gemma 4 E4B at 4-bit produces good 3-reply suggestions in < 1.5 s for short prompts.
- `@react-three/xr` exposes hand joints and pinch "select" in Quest Browser's `immersive-ar` session.
- Memory: all three models resident together use roughly 8–10 GB (rough estimate).
- *(Pointing at objects only)* Gemma 4 E4B accepts image input well enough to name an object in a cropped camera frame.

---

## 5. Repo layout & ownership

```
/
├── AGENTS.md                  ← this file (owner: Dev 4)
├── Makefile                   ← dev/run/test targets (Dev 4)
├── .env.example
├── docs/
│   ├── decisions.md           ← decision log, append-only (everyone)
│   ├── latency.md             ← measured numbers (Dev 3 + Dev 4)
│   └── demo-script.md         ← (everyone; Dev 4 edits)
├── packages/
│   └── protocol/              ← event schemas + generated types (owner: Dev 4, reviewers: all)
│       ├── schema/*.schema.json
│       ├── examples/*.json    ← one valid example per event, used in tests
│       ├── ts/                ← generated, do not hand-edit
│       └── go/                ← generated, do not hand-edit
├── apps/
│   ├── headset/               ← owner: Dev 1
│   ├── phone/                 ← owner: Dev 2
│   └── shared/                ← TS client lib: WS connection, reconnect, store (owner: Dev 2)
├── services/
│   ├── gateway/               ← owner: Dev 4 (Go)
│   └── models/                ← owner: Dev 3 (Python)
├── mocks/
│   ├── mock-gateway/          ← scripted events for frontend work (owner: Dev 2)
│   └── mock-models/           ← canned STT/suggest/TTS responses (owner: Dev 3)
└── data/                      ← git-ignored: db, voices, clips, model cache
```

**Ownership rule:** you (and your agents) edit only your owned paths. To change another area, open a PR and tag its owner. Changes to `packages/protocol` need approval from **every** developer whose code consumes the changed event.

---

## 6. Contracts

### 6.1 Client ↔ gateway events (`packages/protocol`)
Transport: one WebSocket per client at `wss://<host>:8443/ws?role=headset|phone&session=<id>`.
JSON text frames for events; **binary frames only for phone mic audio** (PCM16 mono, 16 kHz, 20 ms chunks).

Every JSON event has this envelope:
```json
{ "type": "suggestions", "v": 1, "sessionId": "s_123", "turnId": "t_7", "ts": 1729740000000, "data": { } }
```

| Event | Direction | `data` |
|---|---|---|
| `hello` | client → gw | `{ role, clientVersion }` |
| `state` | gw → all | `{ state: "IDLE"\|"LISTENING"\|"SUGGESTING"\|"CHOOSING"\|"COMPOSING"\|"SPEAKING" }` |
| `transcript.partial` | gw → all | `{ text, speaker: "other" }` |
| `transcript.final` | gw → all | `{ text, speaker: "other" }` |
| `suggestions` | gw → headset | `{ items: [{ id, text, kind: "statement"\|"question"\|"yes_no", icon?, audioReady: bool }] }` |
| `suggestion.audioReady` | gw → headset | `{ id }` |
| `select` | headset → gw | `{ suggestionId }` |
| `instant` | headset → gw | `{ phraseId }` (e.g. `yes`, `no`, `laugh`, `wait`, `hello`) |
| `compose.start` | headset → gw | `{}` |
| `compose.submit` | headset → gw | `{ text }` |
| `cancel` | headset → gw | `{}` (back out of choosing/composing) |
| `phrases` | gw → headset | `{ groups: [{ id, name, items: [{ id, text, icon?, audioReady: bool }] }] }` (sent on connect and after any change) |
| `phrase.speak` | headset → gw | `{ phraseId }` |
| `phrase.save` | headset → gw | `{ text, groupId, fromClipId? }` (`fromClipId` bookmarks a reply that was just spoken) |
| `phrase.delete` | headset → gw | `{ phraseId }` |
| `phrase.group.save` | headset → gw | `{ groupId?, name, order? }` (create or rename) |
| `phrase.group.delete` | headset → gw | `{ groupId }` |
| `audio.play` | gw → phone | `{ clipId, url: "/clips/<id>.wav", text, source: "suggestion"\|"instant"\|"saved"\|"typed" }` |
| `audio.done` | phone → gw | `{ clipId }` |
| `phone.unlock` | phone → gw | `{}` (user tapped "Start"; audio autoplay is now allowed) |
| `error` | gw → client | `{ code, message, recoverable: bool }` |

**Stretch (saved conversations), add once the core is stable:**

| Event | Direction | `data` |
|---|---|---|
| `conversation.save` | headset → gw | `{ label }` (rejected with `error` unless `store_chat` consent exists) |
| `conversations` | gw → headset | `{ items: [{ id, label, startedAt, summary? }] }` |
| `conversation.attach` | headset → gw | `{ conversationIds: [] }` (use as context for this session) |
| `conversation.delete` | headset → gw | `{ conversationId }` |

**Stretch (quick memories):**

| Event | Direction | `data` |
|---|---|---|
| `memory.save` | headset → gw | `{}` (summarize the last ~60 s; rejected with `error` unless `store_chat` consent exists) |
| `memories` | gw → headset | `{ items: [{ id, summary, createdAt }] }` (sent on connect and after any change) |
| `memory.delete` | headset → gw | `{ memoryId }` |
| `consent.set` | headset → gw | `{ kind: "store_chat", granted }` (revoking deletes every memory) |
| `consent` | gw → headset | `{ storeChat }` (sent on connect and after any change) |

Hands-free selection needs no new events: a dwell selection sends the same `select` / `instant` / `phrase.speak` as a pinch. Events for pointing at objects get defined after the camera spike.

Rules:
- Unknown event types are **ignored and logged**, never crashes.
- Breaking changes bump `v`. Additive fields don't.
- Every event in the table has an example in `packages/protocol/examples/` and a test on both sides that parses it.

### 6.2 Gateway ↔ model service (HTTP on 127.0.0.1:8000)
| Endpoint | Request | Response |
|---|---|---|
| `GET /health` | – | `{ stt, suggest, tts: "ready"\|"loading"\|"error", backend }` |
| `WS /stt?locale=en` | binary PCM16 16 kHz frames | JSON `{ kind: "partial"\|"final", text }` |
| `POST /suggest` | `{ turnId, history: [{speaker, text}], style: {phrases[], tone}, context?: [{ label, summary }], memories?: [string], locale?: "en", n: 3 }` | `{ turnId, items: [{ text, kind }] , ms }` (`context` = attached saved conversations, `memories` = recent quick memories; both stretch) |
| `POST /summarize` *(stretch)* | `{ turns: [{speaker, text}], locale?: "en" }` | `{ summary, ms }` (used for saved conversations and quick memories) |
| `POST /tts` | `{ voiceId, text, locale?: "en" }` | `audio/wav` body, header `X-Gen-Ms` |
| `POST /voices` | multipart: `audio` (audio file, or video with an audio track), `transcript?`, `consentId` | `{ voiceId }` (no `transcript` → the service transcribes the sample with STT) |
| `DELETE /voices/{voiceId}` | – | `204` (deletes cached voice prompt) |

New fields are optional with an `"en"` default, so they're additive. The gateway owns timeouts: `/suggest` 3 s, `/tts` 6 s. On timeout, it sends the headset an `error` with `recoverable: true` and still allows instant phrases and typing.

---

## 7. Roles

Each role lists **scope**, **owned paths**, **done means**, and **notes for your subagents**.

### Dev 1 — Headset XR experience (`apps/headset`)
**Scope:** everything the user sees and touches in the Quest.
- WebXR `immersive-ar` session with passthrough; "Enter" button; re-entry in one tap.
- Reply bubbles placed beside the listener's head position (start with a fixed anchor in front of the user; head/face anchoring is a stretch).
- Hand input: pinch-to-select and poke buttons; controllers supported too.
- Gestures for the instant tier, detected from the 25 hand joints: thumbs-up = `yes`, thumbs-down = `no`, open palm = `wait`. **Avoid palm-pinch**, which the system reserves (it exits the app or opens the Quest menu).
- Accessibility: large targets, a hold-to-confirm or debounce option, a snap-to-nearest assist, one-handed use, UI at chest/lap height to reduce arm fatigue, icon next to each reply.
- Hands-free selection (§1): center reticle from the viewer pose, dwell-to-select with a filling ring, input-mode setting (hands / head / both).
- "Type my own": a large word board or keyboard in XR.
- Saved-phrases panel: one action to open, tabs per group, big phrase buttons; a "bookmark" button on the last spoken reply; add/edit/delete phrases and groups.
- UI strings from `apps/shared/locales/`, never inline.
- *(Stretch)* Saved conversations: a "Save this conversation" action with a label, a list of saved conversations, and a picker to attach them as context.
- *(Stretch)* Quick memories: a "Remember this" action and a memories panel with delete.

**Done means:** against `mocks/mock-gateway`, a user can enter AR, see 3 replies, select one by pinch and by head dwell, fire each instant gesture, speak and bookmark a saved phrase, and compose a typed reply, with no console errors on Quest Browser.
**Agent notes:** test on desktop first with Meta's Immersive Web Emulator (it doesn't emulate passthrough or, likely, hand gestures). Keep gesture thresholds in one config file. Keep draw calls low; profile on the device weekly.

### Dev 2 — Phone experience + shared client (`apps/phone`, `apps/shared`, `mocks/mock-gateway`)
**Scope:** the listener-facing device and the shared TS connection layer.
- "Start" screen with a big tap target (unlocks audio playback) → sends `phone.unlock`.
- Mic capture via `getUserMedia` + an AudioWorklet that downsamples to PCM16 16 kHz and sends 20 ms binary frames.
- Plays `audio.play` clips through Web Audio, then sends `audio.done`.
- Live captions of what the listener said, and the large "I'm answering" ring during `CHOOSING`/`COMPOSING`.
- Voice setup: after the consent step, record a ~30-second sample with `MediaRecorder` (audio, or video with audio) or pick an existing file, and upload it to the gateway.
- `apps/shared`: WebSocket client with reconnect + backoff, typed event parsing from `packages/protocol`, Zustand store shared by both apps, and the locale-keyed UI string files (`locales/en.json`).
- `mocks/mock-gateway`: a tiny server that replays scripted event sequences (`happy-path`, `slow-tts`, `disconnect`) so Dev 1 never waits on the backend.

**Done means:** against the mock gateway, the phone shows captions, shows the ring, plays a clip after the unlock tap, and reconnects after the server restarts.
**Agent notes:** `getUserMedia` requires a secure (HTTPS) origin. Test on iOS Safari and Android Chrome. Never play audio without a prior user tap.

### Dev 3 — AI pipeline (`services/models`, `mocks/mock-models`)
**Scope:** the three models behind the HTTP contract in §6.2.
- STT: streaming partial/final transcripts with `mlx-whisper`; VAD-based chunking.
- Suggestions: a prompt for Gemma 4 that returns exactly 3 short replies (aim for ≤ 12 words each) as JSON, conditioned on recent turns and a style profile. Include at least one yes/no-style reply when the last utterance is a yes/no question.
- TTS: Qwen3-TTS cloning via `mlx-audio`; a voice prompt cache keyed by `voiceId`; a `/voices` endpoint that pre-synthesizes the instant phrases, accepts video (audio extracted with ffmpeg), and transcribes the sample itself when no transcript is sent.
- Pass `locale` through to STT, the prompts, and TTS.
- Backend interface per model (`SttBackend`, `SuggestBackend`, `TtsBackend`) with MLX implementations, plus CUDA ones for the RTX 3080 server as a stretch.
- `mocks/mock-models`: same endpoints, canned responses, configurable delays.
- *(Stretch)* `/summarize` for saved conversations and quick memories (keep names, numbers, times, and instructions verbatim), and use of `context` and `memories` in the `/suggest` prompt (keep the added prompt short so latency holds).
- *(Stretch, after the camera spike)* An endpoint that names the object in a camera frame, and a `target` field on `/suggest`.

**Done means:** `/health` reports all ready on the M4 Pro; a script times STT, `/suggest`, and `/tts` for 20 sample turns and writes results to `docs/latency.md`.
**Agent notes:** never send audio or text to a remote API unless `ALLOW_REMOTE_FALLBACK=1`. Pin model IDs in config. Log timings for every call. Strip anything that isn't JSON from model output and retry once on a parse failure.

### Dev 4 — Gateway, data, consent + integration lead (`services/gateway`, `packages/protocol`, root files)
**Scope:** the hub that ties everything together, plus the contracts and the demo.
- Go gateway: TLS (mkcert certs in dev), serves the built `apps/*` as static files, the `/ws` hub, `/clips/{id}.wav`, and the state machine in §3.
- Orchestration: forwards phone audio to `WS /stt`, debounces partials, calls `/suggest`, and speculatively calls `/tts` for the top 3; cancels stale work by `turnId`.
- Clip cache keyed by `(voiceId, locale, text)`: a phrase that comes up again (a repeated suggestion, a saved or instant phrase) is never synthesized twice.
- SQLite schema and migrations: `person` (with `locale`), `voice_profile` (with `locale`), `consent`, `phrase_clip`, `phrase_group`, `saved_phrase` (with `locale`), `contact`, `session`, `turn` (content only with `store_chat` consent), `audit_log`, `metric`. Stretch: `saved_conversation` (label, session ref, summary), `memory` (summary, created_at).
- Saved phrases: CRUD over the `phrase.*` events, synthesize a clip via `/tts` on save (and re-synthesize when the voice changes), serve them like instant clips. A new person starts with a "Hospital" group ("I need some water", "I need to use the restroom", "I'm in pain", "Can you call my family?") and a "Demo" group ("Hi judges, I'll be demoing Cadence").
- Voice upload: accept the phone's sample and forward it to `POST /voices` with the consent ID.
- *(Stretch)* Saved conversations: persist the session's turns on `conversation.save` (only with `store_chat`), call `/summarize`, pass attached summaries to `/suggest`; deleting a conversation or revoking `store_chat` deletes all of it.
- *(Stretch)* Quick memories: keep a rolling ~60 s transcript in memory, summarize it on `memory.save` (only with `store_chat`), pass memories to `/suggest` by keyword (at most 5 that share a content word with the last 3 turns, best match first, ties to the newer; none if nothing matches); revoking `store_chat` deletes them all.
- Consent flow endpoints and revoke-deletes-everything behavior.
- `packages/protocol`: schemas, generation scripts (TS + Go), examples, and contract tests.
- Root `Makefile`: `make dev` (all services with mocks toggles), `make demo`, `make test`.
- Owns `docs/demo-script.md`, runs integration tests, and makes the final call on merge conflicts.

**Done means:** with the real model service, the full demo flow in §1 runs end to end on the hotspot, and `make test` passes contract tests on both TS and Go sides.
**Agent notes:** the gateway must survive a model-service crash (report `error`, keep instant phrases working). No model-service port is ever exposed beyond localhost.

---

## 8. Rules for AI coding agents (subagents)

1. **Read this file first**, then the `README` or `AGENTS.md` inside your owned directory if it exists.
2. **Stay inside your owner's paths.** If a task needs a change elsewhere, stop and write the proposed change into `docs/proposals/<date>-<topic>.md` for the human owner to review.
3. **Never edit generated code** in `packages/protocol/ts` or `packages/protocol/go`. Edit the schema and regenerate.
4. **Work against mocks** unless the task says integration. Don't block on another team.
5. **Before finishing a task:** run the tests for your area (`make test-<area>`), run the formatter and linter, and summarize what changed and what you couldn't verify.
6. **Respect §2 non-negotiables.** Don't add analytics, remote calls, or new storage of conversation content.
7. **Small PRs.** One concern per PR; title format `[area] short description` (areas: `headset`, `phone`, `shared`, `gateway`, `models`, `protocol`, `docs`).
8. **Record decisions** that affect others in `docs/decisions.md` (date, decision, why, who).
9. **Don't invent model capabilities.** If you're unsure whether a library supports something, write a quick spike and record the result.

### Code style
- **TypeScript:** strict mode, ESLint + Prettier, no `any` in shared code, function components and hooks.
- **Go:** `gofmt`, `go vet`, `staticcheck`; errors wrapped with context; no global mutable state outside `main`.
- **Python:** `ruff` (lint + format), type hints, `pytest`; heavy model loading happens once at startup.

### Testing
- Contract tests: every example in `packages/protocol/examples` must parse in TS and Go.
- Gateway: table-driven tests for the state machine and for stale-`turnId` cancellation.
- Models: a smoke test per backend using a 3-second fixture clip (marked slow).
- Frontends: component tests where cheap; on-device checks follow the checklist in `docs/demo-script.md`.

---

## 9. Ports, env, and running locally

| Service | Address |
|---|---|
| Gateway (HTTPS + WSS) | `https://<laptop-ip>:8443` |
| Model service | `http://127.0.0.1:8000` (never exposed) |
| Headset dev server (Vite, HTTPS) | `https://<laptop-ip>:5173` |
| Phone dev server (Vite, HTTPS) | `https://<laptop-ip>:5174` |
| Mock gateway | `wss://<laptop-ip>:8444` |

Key `.env` values: `MODELS_URL`, `USE_MOCK_MODELS`, `ALLOW_REMOTE_FALLBACK`, `STT_MODEL`, `SUGGEST_MODEL`, `TTS_MODEL`, `DATA_DIR`, `TLS_CERT`, `TLS_KEY`.

Quest testing: same Wi-Fi as the laptop → open the HTTPS URL in Quest Browser → accept the certificate → "Enter". USB fallback: `adb reverse tcp:5173 tcp:5173` and open `https://localhost:5173`.

**Measure first (week 1):** cold and warm times for STT final, `/suggest`, and `/tts` on a 40-character reply, and end-to-end "select → sound" on the hotspot. Record in `docs/latency.md`.

---

## 10. Milestones

| Milestone | Outcome |
|---|---|
| **M0 – Skeleton** | Repo, protocol v1 schemas + examples, mocks running, `make dev` starts everything |
| **M1 – Spikes** | Voice clone + TTS timing on the M4 Pro; Gemma suggestion quality check; hand pinch working in `immersive-ar` on the Quest |
| **M2 – Vertical slice** | Real phone mic → STT → suggestions → pinch → clip plays (no speculation yet) |
| **M3 – Fast path** | Speculative TTS, instant gestures, saved phrases (with starter groups), hands-free head selection, voice sample recording, "I'm answering" ring, consent flow |
| **M4 – Demo-ready** | Hotspot rehearsal 3× in a row, backup video recorded, metrics captured |
| **M5 – Stretch** | Saved conversations (save with label, summarize, attach as context); quick memories; pointing at objects if the camera spike succeeds |

---

## 11. Open questions (resolve and move to `docs/decisions.md`)
- Final app name.
- Primary user group for the pitch (stroke/aphasia vs. laryngectomy vs. broad).
- Whether to anchor reply bubbles to the listener's face (needs passthrough camera access, which may not be available in WebXR) or to a fixed spot. The same access decides whether pointing at objects is possible.
- Hands-free mode: dwell only, or also head gestures (nod = yes, shake = no, tilt toward a bubble) for faster picks.
- Whether Gemma 4's native audio input can replace Whisper (fewer models in memory).
- Whether the RTX 3080 home server is used at all, or only as a fallback.
