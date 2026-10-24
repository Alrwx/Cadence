# Dev 2 plan

Scope: required Dev 2 items for the Quest 3S demo (`AGENTS(GH).md` §7). No stretch goals.
Full history of what was done: [log.md](log.md).

## Dev 2 done-list

| Item | Status |
|---|---|
| Start screen + `phone.unlock` | Done (#7), re-sent on every reconnect |
| Mic → PCM16 16 kHz, 20 ms frames | Done (scaffold), screen kept awake (#7) |
| Play `audio.play` clips, send `audio.done` | Done (#7 + David's review fixes) |
| Live captions + "I'm answering" ring | Done (scaffold), strings from locale file (#7) |
| Voice setup: consent → record or pick → upload | Done on the phone (#8); gateway routes in progress (below) |
| Shared client: reconnect, parsing, store, `locales/en.json` | Done (#5) |
| Mock gateway: scenarios + phrase groups | Done (#6 + David's review fixes) |
| Tested on real phones (iOS Safari, Android Chrome) | **Not done** |

## In progress

- [ ] **[gateway] Consent + voice upload routes**: uncommitted on `main`; move to branch `gateway/voice-routes`, commit, PR, tag Dev 4 (gateway owner).
  - `POST /api/consent`, `POST /api/voices`, migration 003, live voice switch, last voice reloaded on restart.
  - Tests pass (`go test -race ./...` in `services/gateway`); checked end to end with the real gateway binary + mock models.

## Blocked on others

- [ ] **Dev 3:** model service `/voices` requires `transcript`; the phone never sends one, so real uploads get 502 `model_error`. Fix in `services/models/app/main.py` and `mocks/mock-models/mock_models.py`:
  `transcript: Annotated[str | None, Form()] = None,`
- [ ] **Dev 4:** review the gateway routes PR; revoke-consent-deletes-voice is still theirs.

## Left for Dev 2

- [ ] Open the gateway voice-routes PR (branch `gateway/voice-routes`)
- [ ] Real-phone test: install mkcert, `make certs`, `make dev-mock`; iOS Safari + Android Chrome: captions, ring, clip after Start, reconnect after restart, voice recording
- [ ] After Dev 3's fix lands: full voice setup against the real gateway + model service
- [ ] Group chat: consent on phone vs. headset, phone tests (no `make test-phone`), who sets up ESLint, Dev 1 moving headset strings to `@cadence/shared/i18n`

## Notes

- pnpm isn't installed: use `npx --yes pnpm@9.15.9 ...`. uv isn't installed either.
- Shared tests: `npx --yes pnpm@9.15.9 --filter @cadence/shared test`
- Gateway tests: `cd services/gateway && go test -race ./...`
- Local-only file (git-ignored): `DEV2-voice-upload-proposal.md` in the repo root
- Old local branch `phone/voice-setup-old` is a backup; safe to delete (`git branch -D phone/voice-setup-old`).
