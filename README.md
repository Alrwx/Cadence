# Cadence

Assistive communication for people who can't speak or struggle to speak (stroke/aphasia, laryngectomy, vocal-cord paralysis). The user wears a **Meta Quest 3S** in passthrough, so they still see the room and the person they're talking to. A phone between them picks up what the other person says, an on-device model suggests three short replies, the user picks one with their hands, and the phone speaks it **in the user's own cloned voice**.

Reply options float beside the listener, so the user keeps eye contact instead of looking down at a screen. The phone shows an "I'm answering" indicator so silence isn't mistaken for "done."

## Features

- **Suggested replies.** Three short replies that fit the conversation and the user's style, picked with a pinch or poke.
- **Instant gestures.** Thumbs-up says "Yes", thumbs-down says "No", open palm says "Give me a second", all in under a second.
- **Type my own.** A large word board or keyboard in XR, always one action away.
- **Voice cloning with consent.** The voice is cloned from a few seconds of old audio (a voicemail or home video) only after a consent record is stored. Revoking consent deletes the voice.
- **Saved phrases (bookmarks).** Users save phrases they say often, grouped by context, and play them in one action without waiting for suggestions. A patient in a hospital might keep "I need some water" and "I need to use the restroom" ready for when the nurse comes in. Phrases can be typed in or bookmarked right after they're spoken, and each one is synthesized once when it's saved so it plays instantly.
- **Saved conversations (stretch goal).** Users can save a conversation, such as a doctor's appointment, with a label and attach it to a later conversation. A summary of it is passed to the suggestion model, so suggestions on the next visit remember what was discussed. Saving is opt-in per conversation, needs chat-storage consent, and saved conversations can be deleted at any time.

Everything runs locally on the demo laptop. Conversations, transcripts, and voices never leave it by default.

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

## Layout (planned)

| Path | What lives there |
|---|---|
| `apps/headset/` | Quest 3S XR app: reply bubbles, hand input, gestures, saved-phrases panel |
| `apps/phone/` | Listener-facing phone page: mic capture, captions, audio playback |
| `apps/shared/` | Shared TS client: WebSocket connection, reconnect, store |
| `services/gateway/` | Go gateway: TLS, WebSocket hub, state machine, SQLite, `/clips` |
| `services/models/` | Python FastAPI model service: STT, suggestions, TTS |
| `packages/protocol/` | Event schemas and generated TS + Go types |
| `mocks/` | Mock gateway and mock model service for working without the backend |
| `docs/` | Decisions, measured latency, demo script |

The repo still contains the scaffold from the earlier glasses-based idea (`apps/ios/`, `apps/server/`, `supabase/`, `deploy/`); it will be replaced by the layout above.

## Running locally

| Service | Address |
|---|---|
| Gateway (HTTPS + WSS) | `https://<laptop-ip>:8443` |
| Model service | `http://127.0.0.1:8000` (never exposed) |
| Headset dev server | `https://<laptop-ip>:5173` |
| Phone dev server | `https://<laptop-ip>:5174` |

Copy `.env.example` to `.env`, then `make dev` starts everything (with mock toggles). TLS in development uses a `mkcert` local CA, so the Quest and phone each show a one-time certificate warning to accept.

**On the Quest:** join the same Wi-Fi as the laptop, open the HTTPS URL in Quest Browser, accept the certificate, and tap "Enter". Over USB: `adb reverse tcp:5173 tcp:5173` and open `https://localhost:5173`.

**Demo hardware:** MacBook Pro M4 Pro (24 GB), Quest 3S, a phone, and our own hotspot (don't rely on venue Wi-Fi).

See `AGENTS(GH).md` for the full architecture, event contracts, roles, and milestones.
