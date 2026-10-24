# Dev 2 work log

Dev 2 on Cadence (GatorHacks '26): `apps/phone`, `apps/shared`, `mocks/mock-gateway`.
All dates 2026-10-24.

## 1. Planning

- Read `AGENTS(GH).md` and the existing scaffold; compared it with the Dev 2 done-list.
- Wrote the plan ([plan.md](plan.md)) (what exists vs. what's missing, PR order, open decisions).
- Drafted questions for the group chat: voice routes, where consent lives, phone tests, ESLint, Dev 1 adopting locale strings.

## 2. PR #5 — `[shared]` client fixes (merged)

- `hello` is sent before the client reports "open".
- New optional `onOpen` hook, run on every connect and reconnect (the phone uses it to re-send `phone.unlock`).
- Events from a replaced socket are ignored, so React StrictMode no longer leaks a second connection.
- A new turn clears the previous turn's suggestions.
- Added `apps/shared/locales/en.json` and `t()` at `@cadence/shared/i18n`.
- Tests: 8 passing, using a fake WebSocket.

## 3. PR #6 — `[shared]` mock gateway phrase groups (merged)

- `phrase.group.save` (create, rename, reorder) and `phrase.group.delete`.
- Saving into a missing group returns a recoverable `unknown_group` error.
- Starter groups match the spec: full Hospital group + Demo group ("Hi judges, I'll be demoing Cadence").
- David's review fixes on top: unlock starts the scenario only once, phrases go to both clients, id fixes.

## 4. PR #7 — `[phone]` reliability (merged)

- Clips play through a queue; `audio.done` per clip.
- `phone.unlock` re-sent on every reconnect and when the socket wasn't open at the Start tap.
- Screen wake lock after Start so the mic doesn't stop; audio resumes when the page comes back.
- Strings from the locale file; Start-screen hint; readable connection status.
- David's review fixes on top: clips before Start are held, fetch/playback timeouts, unsent `audio.done` re-sent, mic restart.

## 5. PR #8 — `[phone]` voice setup (merged)

- "Set up my voice" on the Start screen (before unlock, so the sample isn't streamed to STT).
- Consent step: whose voice + explicit permission checkbox, saved before any recording.
- Record up to 30 s (webm on Chrome, mp4 on Safari) with a reading passage, or pick an audio/video file; preview, then upload.
- Shared `voiceApi` client (`createConsent`, `uploadVoice`) with tests; dev servers proxy `/api`.
- Mock gateway implements `POST /api/consent` and `POST /api/voices`.
- Rebuilt on the new `main` after #5–#7 merged; resolved one conflict in `en.json`.

## 6. Voice-route proposal (kept local)

- Wrote the consent + voice upload route proposal for Dev 4: `DEV2-voice-upload-proposal.md`.
- Decided to discuss it in person instead of opening a docs PR.

## 7. Testing so far

- Headless Chromium against the mock gateway: 18/18 checks (captions, ring, playback + `audio.done`, back-to-back clips, reconnect after restart, voice setup).
- Not yet tested on real phones.

## 8. Gateway consent + voice routes (in progress, uncommitted)

Gateway code is Dev 4's area; the PR needs Dev 4's review.

- `POST /api/consent`: stores a `voice_clone` consent with whose voice it is and which consent text was shown.
- `POST /api/voices`: checks the consent, forwards the sample to the model service, saves a voice profile, switches live sessions to the new voice. Errors: 400, 403, 413, 502 as in the proposal.
- Sample stays in memory and goes only to the model service; nothing written to disk.
- Migration `003_voice_consent.sql`; store functions for consent and voices.
- Orchestrator: voice can change at runtime; connected headsets get their phrases re-synthesized in the new voice; the last voice is reloaded on restart.
- Tests: store, model client, handler, orchestrator voice switch; all gateway tests pass with `-race`, 5 repeat runs stable.
- End to end with the real gateway binary + mock models: consent 201, upload with transcript 201, bad consent 403, restart keeps the voice.
- Found: the model service requires `transcript`, so the phone's real upload fails with 502 until Dev 3 makes it optional.

## Housekeeping

- Turned off the Claude co-author line in `~/.claude/settings.json`.
- Local backup branch `phone/voice-setup-old` (safe to delete).
