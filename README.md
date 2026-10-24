# Cadence

Head-pointing communication for people who can't speak right now (intubated, post-surgery, post-stroke). Ray-Ban Meta Gen 2 glasses stream camera, motion and speech to an iPhone. The user points their head at an object, Gemma suggests phrases, a head tilt picks one, and it plays in the user's own cloned voice.

## Features

- **Saved phrases (bookmarks).** Users save phrases they say often, grouped by context, and play them in one action without waiting for suggestions. A patient in a hospital might keep "I need some water" and "I need to use the restroom" ready for when the nurse comes in. Phrases can be typed in or bookmarked right after they're spoken, and each one is synthesized once when it's saved so it plays instantly.
- **Saved conversations (stretch goal).** Users can save a conversation, such as a doctor's appointment, with a label and attach it to a later conversation. A summary of it is passed to Gemma, so suggestions on the next visit remember what was discussed. Saving is opt-in per conversation, needs chat-storage consent, and saved conversations can be deleted at any time.

See `AGENTS(GH).md` for the event contracts and who owns each piece.

## Layout

| Path | What lives there |
|---|---|
| `apps/ios/` | Swift app (XcodeGen project). The phone is the runtime: selection, Gemma, playback |
| `apps/ios/Cadence/Glasses/` | The only code that imports Meta's SDK; `PhoneStandIn/` replaces the glasses during development |
| `apps/ios/Cadence/Inference/` | `InferenceEngine` with on-device and remote (3090) implementations |
| `apps/ios/Cadence/Resources/` | `Config.json` (all runtime defaults), Gemma prompts, Core ML models, UI strings |
| `apps/server/` | FastAPI: voice clone and TTS with Qwen |
| `supabase/` | Migrations for users, voice profiles, phrases, bookmarks, audio clips, memories |
| `deploy/` | Docker Compose for the server, plus the optional Gemma server for the 3090 |

## Running

**iOS** (Mac, Xcode 26.4+):

```sh
brew install xcodegen
cd apps/ios && xcodegen && open Cadence.xcodeproj
```

Set your signing team in Xcode, fill in `Cadence/Resources/Config.json`, then enable Developer Mode in the Meta AI app (Settings → your glasses → Developer Mode).

**Server:**

```sh
cp .env.example .env
cd apps/server && uv sync && uv run uvicorn app.main:app --reload
uv run pytest
```

**Supabase:** `npx supabase start` runs it locally; `npx supabase db push` applies the migrations to a hosted project. The app signs in anonymously, so turn on anonymous sign-ins in the hosted project's Auth settings.

**3090 box:** put a Gemma GGUF in `deploy/models/`, set `GEMMA_MODEL` in `.env`, then run `docker compose -f deploy/docker-compose.yml --profile gemma up`.

## How the pieces talk

The phone calls `POST /tts` for every clip it needs. The server reuses a stored clip when it has already synthesized that voice, locale and text, so bookmarks and repeated phrases cost one synthesis each. The phone caches every clip locally under the same key. New accounts get starter bookmarks from a database trigger (`supabase/migrations/*_bookmarks.sql`).
