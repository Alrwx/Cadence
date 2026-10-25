# A voice toggle and "Delete my voice" on the phone

**For:** Dev 2 (`apps/phone`, `apps/shared`, `mocks/mock-gateway`), optionally Dev 1 (`apps/headset` settings) · **From:** Dev 4 · **Date:** 2026-10-24

## Why
Demo step 6 replays the same exchange in a generic robot voice for contrast. The gateway can now switch between the cloned voice and the model service's built-in `"default"` voice without losing the cloned one. Nothing in the apps sends the switch yet.

## Contract (in `packages/protocol`; `ts/index.ts` already has `VoiceData` and `VoiceUseData`)

| Event | Direction | `data` |
|---|---|---|
| `voice.use` | phone or headset → gw | `{ voice: "cloned" \| "default" }` |
| `voice` | gw → headset, phone | `{ active: "cloned" \| "default", cloned: boolean }` |

- The gateway sends `voice` to each client **on connect** (right after `state`) and to both clients **after any change**: a `voice.use`, a new voice uploaded on the phone (that switches back to `"cloned"`), or the gateway finding the cloned voice missing on the model service (that switches to `"default"` and sets `cloned: false`).
- `cloned: false` means there's no recorded voice: show the toggle disabled, with a hint to record one.
- `voice.use { voice: "cloned" }` with no recorded voice gets an `error { code: "no_cloned_voice", recoverable: true }` back to the sender, followed by the unchanged `voice`.
- A `voice.use` that changes nothing is answered with `voice` to the sender only, so the toggle can always trust the last `voice` it got. Don't flip the toggle optimistically; wait for `voice`.
- After a switch, the headset gets a fresh `phrases` with `audioReady: false` until the gateway has re-made the clips in that voice (a few seconds on the 3080). Phrases still play while they're not ready; the first one just takes longer.
- The gateway sends the headset `error { code: "voice_missing" }` ("Your recorded voice is missing, so the generic voice is being used. Record it again on the phone.") if the model service lost the voice. No special handling is needed beyond showing errors as today.

## Proposed changes

### `apps/shared` (Dev 2)
- Store: keep `voice: { active, cloned } | null`, set from the `voice` event (add a `case "voice"` next to `case "phrases"` in `store.ts`).
- Export a helper, e.g. `useVoice(choice)`, that sends `voice.use`.

### `apps/phone` (Dev 2)
- A two-state switch near the voice-setup entry, "My voice" / "Robot voice", bound to `voice.active`, disabled when `voice.cloned` is false.
- The presenter flips it before step 6 and back after. It must be reachable without leaving the main screen (one tap), since it's used mid-demo.
- Locale keys in `apps/shared/locales/en.json`, e.g. `voice.toggle.cloned`, `voice.toggle.default`, `voice.toggle.noVoice`.

### `apps/headset` (Dev 1, optional)
- The same choice in Settings, sending the same `voice.use`. Not needed for the demo: the phone toggle is enough.

### `mocks/mock-gateway` (Dev 2)
- Keep `s.voice = { active: "default", cloned: false }` per session.
- On connect, send `voice` to the connecting role (next to the existing `consent` send).
- After a successful `POST /api/voices`, set `{ active: "cloned", cloned: true }` and send `voice` to both roles.
- On `voice.use`: `"default"` sets `active: "default"`; `"cloned"` sets `active: "cloned"` if `cloned`, else sends `error { code: "no_cloned_voice", ... }` to the sender. Then send `voice` to both roles.

## Related: upload errors (no change needed, FYI)
`POST /api/voices` now tells two failures apart, both as `{ code, message }`:
- `503 models_unavailable` ("The voice model is still starting. Try again in a minute."): the model service is down or still loading. The sample was fine; keep it and offer a retry.
- `502 model_error`: the model service rejected the sample. Suggest recording again.

`voiceApi.ts` already surfaces `code` and `message`, so showing `message` is enough. Keeping the recorded sample on a `models_unavailable` would save the user re-recording. The mock gateway could return a `503` once under a scripted scenario to exercise it.

## "Delete my voice" on the phone (§2: revoking consent deletes the voice)
The gateway has `DELETE /api/voices` (no body; same origin rule as the other `/api` routes). It withdraws every voice-clone consent of the person and deletes each of their cloned voices: the model service's copy, every cached clip, and the voice profile. Speaking switches to the generic voice right away, and both clients get `voice { active: "default", cloned: false }`.

| Answer | Meaning | What the phone shows |
|---|---|---|
| `204` | Done. Also the answer when there was nothing to delete. | "Your voice was deleted." |
| `502 model_error` | Consent withdrawn and everything on this laptop deleted, but the model service couldn't delete its copy. Nothing uses the voice any more. | `message`, plus a "Try again" button that repeats the `DELETE`; the retry finishes the model-side delete. |
| `500 storage_failed` | A database or file error partway. Consent is withdrawn if the step that failed came after it. | `message`, plus "Try again". |
| `403 bad_origin` | Cross-site request. | Not reachable from the phone app. |

Proposed (Dev 2):
- `apps/shared/src/voiceApi.ts`: `deleteVoice(fetchImpl = fetch): Promise<void>` that sends `DELETE /api/voices` and throws `VoiceApiError` on a non-2xx, like the other two (`readJson` needs to accept an empty `204` body).
- `apps/phone`: a "Delete my voice" action in the voice settings, with a confirm step ("This deletes your recorded voice and every clip made with it. Replies will use the generic voice."). Show it only when `voice.cloned` is true. Locale keys such as `voice.delete`, `voice.deleteConfirm`, `voice.deleted`.
- `mocks/mock-gateway`: `DELETE /api/voices` answers `204`, marks every consent revoked (an upload with one then gets `403 no_consent`), and sends `voice { active: "default", cloned: false }` to both roles.

One more upload answer, from the same work: a `POST /api/voices` whose consent was withdrawn while the model service was cloning now gets `403 no_consent`, and the half-made voice is deleted.

## Tests worth adding
- `shared.test.ts`: a `voice` event updates the store; the toggle helper sends `voice.use` with the right payload.
- Mock gateway: `voice.use { voice: "cloned" }` before an upload returns `no_cloned_voice`.
- `voiceApi.ts`: `deleteVoice` resolves on `204` and throws `VoiceApiError("model_error")` on a `502`.
