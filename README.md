# Cadence

Assistive communication for people who can't speak or struggle to speak (stroke/aphasia, laryngectomy, vocal-cord paralysis). The user wears a **Meta Quest 3S** in passthrough, so they still see the room and the person they're talking to. A phone between them picks up what the other person says, an on-device model suggests three short replies, the user picks one with their hands or just their head, and the phone speaks it **in the user's own cloned voice**.

Reply options float beside the listener, so the user keeps eye contact instead of looking down at a screen. The phone shows an "I'm answering" indicator so silence isn't mistaken for "done."

## Features

- **Suggested replies.** Three short replies that fit the conversation and the user's style, picked with a pinch or poke.
- **Hands-free selection.** For users who can't pinch reliably, holding a center-of-view reticle on any reply or button for a moment selects it, with no hands needed.
- **Instant gestures.** Thumbs-up says "Yes", thumbs-down says "No", open palm says "Give me a second", all in under a second.
- **Type my own.** A large word board or keyboard in XR, always one action away.
- **Voice cloning with consent.** The voice is cloned from a few seconds of old audio (a voicemail or home video) or a ~30-second sample recorded on the phone, only after a consent record is stored. Revoking consent deletes the voice.
- **Saved phrases (bookmarks).** Users save phrases they say often, grouped by context, and play them in one action without waiting for suggestions. New users start with a "Hospital" group ("I need some water", "I need to use the restroom", ...) ready for when the nurse comes in. Phrases can be typed in or bookmarked right after they're spoken, and each one is synthesized once when it's saved so it plays instantly. A saved phrase can be said as-is or edited first. Phrases and groups are managed from the phone.
- **Saved conversations (stretch goal).** Users can save a conversation, such as a doctor's appointment, with a label and attach it to a later conversation. A summary of it is passed to the suggestion model, so suggestions on the next visit remember what was discussed. Saving is opt-in per conversation, needs chat-storage consent, and saved conversations can be deleted at any time.
- **Quick memories (stretch goal).** "Remember this" summarizes the last minute of conversation into a short note that later suggestions use automatically. Needs chat-storage consent; memories can be deleted at any time.
- **Pointing at objects (stretch goal).** Look at an object in the room and get suggestions about it ("Can you hand me the water?"). Blocked until we can get camera frames in Quest Browser.

Everything runs locally on the demo laptop. Conversations, transcripts, and voices never leave it by default. The demo is English-only, but language is a setting passed through speech-to-text, suggestions, and TTS, so other languages can be added later.

## How it works

```
Quest 3S (browser, WebXR)  ◄── WSS ──►  Go gateway  ◄── WSS ──►  Phone (browser)
  reply bubbles, hand input              session state,            mic, captions,
  gestures, saved phrases                SQLite, clip cache        plays reply audio
                                              │
                                              │ HTTP on 127.0.0.1 only
                                              ▼
                                       Python model service
                                       STT: mlx-whisper
                                       Suggestions: Gemma 4
                                       TTS / cloning: Qwen3-TTS
```

- The **headset** and **phone** are web apps (Vite + React + TypeScript; the headset uses React Three Fiber and WebXR `immersive-ar`). No app install on either device.
- The **gateway** is the only process on the network. It serves both web apps, runs the session state machine, and stores consent, profiles, saved phrases, and the audit log in SQLite.
- The **model service** binds to localhost only. To keep latency low, the gateway asks for suggestions and synthesizes their audio while the other person is still talking, so a selected reply is usually ready to play immediately.

## Layout

| Path | What lives there |
|---|---|
| `apps/headset/` | Quest 3S WebXR app (React Three Fiber): reply bubbles, hand gestures, saved-phrases panel, word board |
| `apps/phone/` | Listener-facing phone page: Start/unlock, mic → PCM16 16 kHz, captions, "I'm answering" ring, clip playback |
| `apps/shared/` | Shared TS client: WebSocket connection with reconnect, Zustand store, Vite dev-server config |
| `services/gateway/` | Go gateway: TLS, `/ws` hub, session state machine, orchestration, SQLite, `/clips` |
| `services/models/` | Python FastAPI model service: STT, suggestions, TTS behind swappable backends |
| `packages/protocol/` | Event JSON Schemas, one example per event, generated TS + Go types, contract tests |
| `mocks/mock-gateway/` | Scripted gateway (`happy-path`, `slow-tts`, `disconnect`) for frontend work |
| `mocks/mock-models/` | Same endpoints as the model service with canned responses and delays |
| `docs/` | Decisions, measured latency, demo script |

## Running locally

Needs Node 22+ (with `corepack enable` for pnpm), Go 1.26+, [uv](https://docs.astral.sh/uv/), and [mkcert](https://github.com/FiloSottile/mkcert).

```sh
cp .env.example .env
make setup        # install JS, Python, and Go dependencies
make certs        # local HTTPS cert for this laptop's LAN IP
make dev-mock     # headset + phone against the scripted mock gateway (no backend needed)
make dev          # model service (mock when USE_MOCK_MODELS=1) + gateway + headset + phone
make test         # contract, gateway, model-service, and client tests
```

| Service | Address |
|---|---|
| Gateway (HTTPS + WSS, serves built apps at `/headset/` and `/phone/`) | `https://<laptop-ip>:8443` |
| Model service | `http://127.0.0.1:8000` (never exposed) |
| Headset dev server | `https://<laptop-ip>:5173/headset/` |
| Phone dev server | `https://<laptop-ip>:5174/phone/` |
| Mock gateway | `https://<laptop-ip>:8444` |

The dev servers proxy `/ws` and `/clips` to the gateway, so add `?session=<id>` to both URLs to pair a headset with a phone (default `demo`). After editing `packages/protocol/schema/`, run `make protocol` to regenerate the TS and Go types.

**On the Quest:** join the same Wi-Fi as the laptop, open the HTTPS URL in Quest Browser, accept the certificate, and tap "Enter". Over USB: `adb reverse tcp:5173 tcp:5173` and open `https://localhost:5173/headset/`. On a desktop, Meta's Immersive Web Emulator works for layout (not passthrough or hand gestures).

**Demo hardware:** MacBook Pro M4 Pro (24 GB), Quest 3S, a phone, and our own hotspot (don't rely on venue Wi-Fi).

See `AGENTS(GH).md` for the full architecture, event contracts, roles, and milestones.
