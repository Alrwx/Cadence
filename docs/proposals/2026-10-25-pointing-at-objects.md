# Pointing at objects: plan

**From:** Dev 2 · **For:** Dev 1 (headset), Dev 3 (models), Dev 4 (gateway + protocol) · **Date:** 2026-10-25 · **Status:** proposed

The user holds the reticle on something in the room, and the reply options become requests about it: look at a glass of water, get "Can you hand me the water?". This is the stretch goal in `AGENTS(GH).md` §1, blocked on getting camera frames out of Quest Browser. This plan starts with a spike that settles that question, then splits the work by owner.

## Why this looks possible now

- **The model can already see.** `gemma4:e4b` on the 3080 lists `vision` in its capabilities (Ollama 0.40.2, checked 2026-10-25). The model that writes suggestions can also name what's in a photo. No new model to load or fit into VRAM.
- **Quest Browser seems to expose the cameras to web pages.** Reports say that from Quest OS v77, the color passthrough cameras show up as ordinary video inputs: `navigator.mediaDevices.enumerateDevices()`, then `getUserMedia({ video: { deviceId } })`. One developer did this on a Quest 3 with Quest Browser 39 and sent frames to an image model. This isn't the WebXR `camera-access` feature, which is why requesting that feature fails (`AGENTS(GH).md` §1).
- **Still unknown for us:** whether it works on the Quest 3S on our OS and browser versions, and whether the stream keeps delivering frames *during* an `immersive-ar` session.

## Phase 0: camera spike (go/no-go, about 2 hours)

Owner: Dev 1 or Dev 2. Nothing else starts until this passes.

The spike page is `apps/phone/camera-spike.html` with `apps/phone/src/spike/cameraSpike.ts`. It's served by the phone dev server only, not built. Its four buttons:

1. **List cameras:** asks for camera access once, then lists every `videoinput` by label (`enumerateDevices()`).
2. **Open camera:** opens the chosen camera with `getUserMedia({ video: { deviceId, width: 1280, height: 960 } })` and reports the size and frame rate it actually got.
3. **Test in AR (8 s):** enters `immersive-ar`, counts new camera frames while inside the session, and crops one frame 3 s in. **This is the check that matters.**
4. **Upload crop:** sends the crop (center 40%, 512 px JPEG, quality 0.8) and the whole report to the mock gateway's `POST /api/spike/frame`. The mock prints the report in its terminal and keeps nothing.

Every result, including failures, goes into one report shown on the page and printed by the mock.

### How to run it

1. On the laptop: `git checkout spike/camera`, then `make dev-mock`. The spike route is only in the mock gateway, so don't use `make dev`.
2. Put the laptop and the Quest on the same Wi-Fi, and open the dev server's port: `sudo firewall-cmd --add-port=5174/tcp`. Campus or venue Wi-Fi often blocks devices from reaching each other. If so, put both on a phone hotspot and rerun `make certs` for the new address (`hostname -I` shows it).
3. In Quest Browser, open `https://<laptop-ip>:5174/phone/camera-spike.html` and accept the certificate warning.
4. Press **1** and allow camera access. In the list, pick a camera whose name mentions back, left or right (the color passthrough cameras), not the front one.
5. Press **2**, then **3**. The headset goes into AR for 8 seconds and comes back on its own.
6. Press **4**, then read the report in the `make dev-mock` terminal.

**Pass:** `inAR.newCameraFrames` is above 0 and `crop.source` is "inside AR". **Fail:** an `arError`, 0 frames in AR, or a crop that only works outside AR.

Record the result in `docs/decisions.md`: Quest OS version (Settings → System → Software update), Quest Browser version (in the report's `userAgent`), camera labels, the size and fps from step 2, frames and fps inside AR, and the JPEG size.

**Go:** a crop taken inside AR reaches the gateway. **No-go:** go to [Fallbacks](#fallbacks).

## Phase 1: contracts (Dev 4 owns; everyone reviews)

Additive only, so no `v` bump.

### Headset → gateway: `POST /api/look` (HTTPS, like the voice routes)

A JPEG is too big to put inside the JSON events, so this uses plain HTTPS like `/api/voices`. It has the same origin check as `/api/consent` and `/api/voices`.

| Field (multipart) | Notes |
|---|---|
| `image` | JPEG, ≤ 512 px on the long side, ≤ 300 KB |
| `sessionId` | which session's suggestions to steer |

Response `202 { lookId }`. The result arrives over the WebSocket, so the headset doesn't block on the model. Errors: `400 bad_request`, `413 too_large`, `403 bad_origin`, `409 not_listening` (before Start or while a reply plays).

### Gateway → headset events

| Event | Direction | `data` |
|---|---|---|
| `look.result` | gw → headset | `{ lookId, object: string \| null }` (`null`: nothing clear in view) |

The suggestions that follow are the ordinary `suggestions` event under a new `turnId`.

### Gateway → model service

| Endpoint | Request | Response |
|---|---|---|
| `POST /look` | multipart `image`, `locale?` | `{ object: string \| null, ms }` |
| `POST /suggest` | existing body + `target?: string` | unchanged |

### State machine

New input `Looked`: `LISTENING → SUGGESTING` and `CHOOSING → SUGGESTING` (a new look replaces the current choices). Ignored in `IDLE`, `COMPOSING`, `SPEAKING`.

## Phase 2: build (in parallel, each against mocks)

### Dev 3: model service

- `POST /look`: one Gemma call with the image and a short prompt: *"Name the single object at the center of this photo in 1–4 words (for example 'glass of water', 'TV remote'). If nothing is clear, answer NONE."* Then normalize the answer (lowercase, strip punctuation, NONE → `null`).
- `/suggest` with `target`: add one line to the prompt, *"The user is looking at: {target}. Most replies should be requests or comments about it."* Keep the prompt short so latency holds.
- `mocks/mock-models`: `/look` returns a canned object after a configurable delay.
- **Measure:** `/look` p50 and p95 on the 3080 for a 512 px JPEG, with Gemma warm; write to `docs/latency.md`.

### Dev 4: gateway

- `POST /api/look`: validate, answer 202, then call `/look` in a goroutine with a 4 s timeout. Never write the image to disk.
- Per session, keep `target` with a 30 s lifetime. Pass it to `/suggest` (both speech turns and look turns) while it's fresh.
- On a non-null object: apply `Looked`, start a turn whose history is the recent turns plus no new speech, send `look.result`, then suggest and speculatively synthesize as usual.
- On `null` or a timeout: send `look.result` with `null` (the headset shows "Couldn't tell what that is") and leave the state alone.
- Metrics: `look_ms` and `look_to_suggestions_ms`. No content stored.
- Tests: look turn from LISTENING and from CHOOSING, ignored in SPEAKING, target expiry, model timeout.

### Dev 1: headset

- **Trigger:** dwell the reticle on empty space (not on a UI target) for 1.2 s. That fills a different ring from the selection dwell. Also a "What's this?" button for hand users. Never capture continuously.
- **Capture:** reuse the spike code: crop, 512 px JPEG, POST. Show a small "Looking…" ring at the reticle.
- **Result:** a label such as "Glass of water" near the reticle for 3 s, then the usual reply bubbles. On `null`, "Couldn't tell what that is."
- Settings: an on/off toggle for "Look to suggest", stored with the other input settings. Strings in `apps/shared/locales/en.json`.

### Dev 2: test bench, mock gateway, shared client

- **Test bench "Look at" card:** pick an image file or take a laptop webcam snapshot, crop and encode it with the same code as the headset, and POST to `/api/look`. Show `look.result` and the suggestions. This lets everyone build and demo without a Quest.
- **Mock gateway:** `POST /api/look` → `look.result` with a canned object chosen from the file name (`water.jpg` → "glass of water"), then three canned requests about it.
- **Shared client:** a `lookApi.ts` (like `voiceApi.ts`) and store handling for `look.result`, both with tests.

## Phase 3: integration and demo

1. Test bench → real gateway → 3080, with a photo of a glass of water: label and three requests within the latency target.
2. Quest 3S end to end on the hotspot, against three real objects (cup, remote, blanket).
3. Add a demo step to `docs/demo-script.md`: *"The patient looks at the water glass on the table; 'Can you hand me the water?' appears; they pinch it; the phone says it in their voice."*

**Latency target (design, not measured):** dwell complete → suggestions shown in under 3 s. Budget: capture and encode 100 ms, upload 100 ms, `/look` ≤ 1.2 s, `/suggest` 0.4 s, first suggestion clip ≤ 1.2 s.

## Privacy (§2)

- Frames are used once and dropped: never written to disk, never logged, and never sent anywhere but the model service on the team's machine.
- Only the object's name travels on to `/suggest`. It's treated like transcript text: stored only with `store_chat` consent.
- Capture only on an explicit dwell or button, never in the background. The browser's camera permission prompt stays the only consent screen for the camera itself. The settings toggle turns the feature off completely.

## Fallbacks

If the spike fails on the Quest 3S:

1. **Outside AR only:** if `getUserMedia` works in Quest Browser but stops inside `immersive-ar`, offer "What's this?" as a quick 2D camera view outside AR. That's clunkier, but it shows the feature.
2. **Phone camera:** the listener points the phone at the object, and the phone app sends the frame. It loses "where I'm looking", but keeps "suggestions about an object".
3. **Demo with the test bench:** show the feature from the laptop with a photo, and say plainly that headset capture is pending.

## Risks

| Risk | Mitigation |
|---|---|
| Camera stream stops inside an AR session | Spike checks this first; fallback 1 |
| Camera image is offset from the user's gaze | Crop generously (center 40%); the label tells the user what was recognized |
| Gemma names the wrong object | Show the label so the user can see the guess; looking again replaces it |
| VRAM on the 3080 (Gemma + STT + TTS is about 250 MB from full) | Vision runs in the same Gemma process; measure peak VRAM during `/look` before the demo |
| `/look` too slow | Smaller crop (384 px); keep Gemma warm; show the label before suggestions |

## Open questions

- The trigger: dwell on empty space, a button, or both? (Proposed: both.)
- Should a look also work while the user is choosing, or only while listening? (Proposed: both, replacing the current replies.)
- Does `target` stay for the next spoken turn (30 s), or only for the look turn? (Proposed: 30 s.)
