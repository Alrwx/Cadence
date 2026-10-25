# Dev 2 plan

Scope: Dev 2 items for the Quest 3S demo (`AGENTS(GH).md` §7). Last updated 2026-10-25, at main `cbdb40d`. Cross-team picture: `docs/progress.md`.
Full history of what was done: [log.md](log.md).

## Dev 2 done-list

| Item | Status |
|---|---|
| Start screen + `phone.unlock` | Done (#7), re-sent on every reconnect |
| Mic → PCM16 16 kHz, 20 ms frames | Done (scaffold), screen kept awake (#7) |
| Play `audio.play` clips, send `audio.done` | Done (#7 + David's review fixes) |
| Live captions + "I'm answering" ring | Done (scaffold), strings from locale file (#7) |
| Voice setup: consent → record or pick → upload | Done (#8 phone, #13 gateway routes) |
| Shared client: reconnect, parsing, store, `locales/en.json` | Done (#5) |
| Mock gateway: scenarios + phrase groups | Done (#6 + David's review fixes) |
| Saved-phrase management screen | Done (#20) |
| Desktop test bench | Done (#23, #26) |
| Tested on real phones (iOS Safari, Android Chrome) | **Not done** |

## Done since the first plan

- [x] **Consent + voice upload routes (PR #13)**: merged. `POST /api/consent`, `POST /api/voices`, migration 003, live voice switch, last voice reloaded on restart.
- [x] **Dev 3's `transcript` fix**: `/voices` takes an optional transcript (PR #18), so real uploads work.
- [x] **Saved-phrase management (PR #20)**: `PhraseManager.tsx`; the gateway now sends `phrases` to the phone too.
- [x] **Desktop test bench (PRs #23, #26)**: `apps/phone/test.html`, phone plus a clickable stand-in headset, type-for-the-listener, self-clearing errors.
- [x] **Camera spike page (PR #29)**: `apps/phone/camera-spike.html`, phase 0 of pointing at objects.

## Left for Dev 2

- [ ] **Robot voice toggle and "Delete my voice"** on the phone, per `docs/proposals/2026-10-24-robot-voice-toggle.md`. The gateway side (`voice.use`, `voice`, `DELETE /api/voices`) is done; this is demo step 6.
- [ ] Real-phone test: install mkcert, `make certs`, `make dev-mock`; iOS Safari + Android Chrome: captions, ring, clip after Start, reconnect after restart, voice recording, phrase management
- [ ] Full voice setup against the real gateway + model service on the demo hardware
- [x] Run the camera spike on the Quest 3S (steps in `docs/proposals/2026-10-25-pointing-at-objects.md`) and record the result in `docs/decisions.md`
- [ ] If the spike passes: test-bench "Look at" card, mock `POST /api/look`, `lookApi.ts` with tests
- [ ] `voiceApi.ts` points to `docs/proposals/2026-10-24-voice-upload-endpoints.md`, which isn't in the repo; commit it or fix the comment
- [ ] Group chat: phone tests (no `make test-phone`), who sets up ESLint, Dev 1 moving headset strings to `@cadence/shared/i18n`

## Notes

- pnpm isn't installed: use `npx --yes pnpm@9.15.9 ...`. uv isn't installed either.
- Shared tests: `npx --yes pnpm@9.15.9 --filter @cadence/shared test`
- Gateway tests: `cd services/gateway && go test -race ./...`
- Local-only file (git-ignored): `DEV2-voice-upload-proposal.md` in the repo root
