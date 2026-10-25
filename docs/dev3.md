# Dev 3 status and handoff

Owner: Dev 3 (AI pipeline: `services/models`, `mocks/mock-models`). Scope is in `AGENTS(GH).md` §7. Last updated 2026-10-24. Everything below is on main (merged in PR #18, with review fixes).

Read this before working on `services/models` and before calling the model service from the gateway. Agents: follow `AGENTS(GH).md` §8 too.

---

## Done

### Contract (§6.2), all routes real
| Route | What it does now |
|---|---|
| `GET /health` | Per-model `loading` → `ready` / `error`. Models load in background threads, so the service answers immediately. Routes return `503 {detail}` until their model is ready. |
| `WS /stt?locale=en` | An energy VAD cuts the PCM16 stream into utterances. A partial goes out about every 600 ms while someone talks; the final comes after 700 ms of silence. Closes with 1013 while STT is loading. |
| `POST /suggest` | Gemma 4 via Ollama, constrained to a JSON schema of exactly `n` replies. Takes `context`, `memories`, `locale`. `502` if Ollama fails. |
| `POST /summarize` | Same model, plain text, keeps names/numbers/times verbatim (prompt in `app/prompts/summarize.md`). |
| `POST /tts` | Qwen3-TTS voice clone, WAV 24 kHz mono, `X-Gen-Ms`. `404` for an unknown voiceId. `"default"` is the built-in generic voice. Concurrent requests for one voice are batched. |
| `POST /voices` | Multipart `audio`, `consentId`, optional `transcript`, optional `locale`. Any audio or video container. No transcript → Whisper transcribes the sample. `400 {detail}` for no consent id, an undecodable file, < 3 s of speech, or no words heard. `413` over 25 MB. |
| `DELETE /voices/{id}` | Deletes the stored reference and the cached prompt. `default` can't be deleted. |

### Backends (`app/backends/`)
- **`cuda.py` (RTX 3080), verified on the 3080:** Whisper large-v3-turbo through transformers (fp16, SDPA), plus Qwen3-TTS 0.6B Base through qwen-tts (bf16, FlashAttention 2).
- **`mlx.py` (demo Mac), written but never run:** mlx-whisper and mlx-audio's Qwen3-TTS port. I wrote it against the mlx-whisper 0.4.3 and mlx-audio 0.5.8 sources, but there's no Mac here. **It needs its first run on the M4 Pro** (see [Not done](#not-done-priority-order)).
- **`ollama.py` (both machines):** suggestions and summaries. Verified on the 3080 against Ollama v0.40.2 with `gemma4:e4b`.
- Shared, backend-independent code:
  - `stt_stream.py`: VAD + partial/final scheduling.
  - `tts.py`: voice store on disk, the worker thread that owns the model, and batching.
  - `audio.py`: PyAV decode, reference trimming, WAV.

### Checked end to end on the 3080 (2026-10-24)
- `pytest -m slow` (4 tests):
  - Whisper transcribes the default voice clip.
  - TTS → STT round trip.
  - Clone from an untranscribed sample.
  - Batch of 3.
- `scripts/bench_pipeline.py`, 20 turns over HTTP/WS, results in `docs/latency.md`:
  - STT final 620 ms p50 after the speaker stops, with 20/20 transcripts correct.
  - 3 suggestion clips 2.2 s p50 (batched), one reply 1.8 s.
  - Rerun with Gemma on the same GPU: `/suggest` 389 ms p50, 3 suggestion clips 3.2 s p50 (Gemma's replies are longer; speed per second of audio is unchanged).
- **The gateway from PR #13 (`gateway/voice-routes`) against this service:**
  - `POST /api/consent` → `POST /api/voices` with a webm/opus sample (what Chrome's MediaRecorder sends) returned a voiceId in 355 ms.
  - The gateway switched voices and re-warmed its 10 phrases in the new voice. `instant yes` reached the phone as `audio.play` in 468 ms.
  - An unknown consent id gets `403 no_consent`.
- VRAM with STT and TTS loaded and warm: 8.2 GB of the 3080's 10 GB, as reported by nvidia-smi for the process. Most of that was PyTorch's cache: with Gemma loaded first, the same service peaks at 5.2 GB.
- **All three models on the 3080 (Ollama installed in `~/.local/opt/ollama-v0.40.2`, no sudo):** Gemma 4.8 GB + model service 5.2 GB, peak 9,994 of 10,240 MiB. Needs `expandable_segments` (now the CUDA default); without it TTS ran out of memory in one of two runs. Details and the load-order caveat are in `docs/latency.md`.

### Mock (`mocks/mock-models`)
- `/voices` takes an optional `transcript` and `locale`, and returns 400 without a `consentId`, same as the real service.

---

## Not done (priority order)

### P0: before the demo
- [ ] **First run of the MLX backends on the M4 Pro.** Steps:

  ```
  brew install ollama && ollama pull gemma4:e4b
  cd services/models && uv sync --extra mlx
  MODELS_BACKEND=mlx make models
  ```

  Then wait for `/health` to show all `ready`, and run `uv run --extra mlx python scripts/bench_pipeline.py --hardware "M4 Pro 24 GB"`. Likely fixes if it breaks, all in `app/backends/mlx.py`:
  - the mlx-audio loader name (`mlx_audio.tts.utils.load`)
  - `batch_generate` keyword names
  - the dtype of the returned audio
- [ ] **First real `/suggest` on the Mac.** Done on the 3080: 389 ms p50, and replies to yes/no questions included a yes/no option in spot checks. Still to check on the M4 Pro:
  - Latency stays well under the gateway's 3 s timeout. Budget: < 1.5 s (§4 assumption).
  - Reply quality, including a clear yes/no reply after yes/no questions.

  If `think: false` is rejected, the backend drops the flag by itself (`test_think_flag_is_dropped_if_the_server_rejects_it`).
- [ ] **Old `.env` files.** Clear `STT_MODEL` and `TTS_MODEL` (empty = the backend's default). The old values are the MLX Whisper repo and the PyTorch Qwen repo, and each one is wrong on one of the two backends.

### P1
- [ ] **3080 VRAM margin with Gemma (about 250 MB).** It fits with `expandable_segments` (see `docs/latency.md`), but a batch of 4 beside Gemma and a cold start of the whole stack are untested. If the margin breaks: faster-whisper int8 first, then `SUGGEST_MODEL=gemma4:e2b`.
- [ ] **Hallucination guard for STT.** Only no-letter outputs are dropped. If Whisper invents text on noise in the room (TV, hallway), add a no-speech check.

### P2: stretch
- [ ] Naming the object in a camera frame, plus `target` on `/suggest`. Blocked on the camera spike (§1).

---

## Needs from other devs

- **Dev 4 (gateway):**
  - **Revoking consent** must call `DELETE /voices/{modelVoiceId}`. The service keeps the reference clip under `DATA_DIR/voices/` until then (§2 non-negotiable).
  - **`warmClips` sends `/tts` one phrase at a time** (10 phrases ≈ 18 s on the 3080 after a voice switch). Sending up to 4 at once lets the service batch them, for about a 3× faster switch. Suggestions already go out together, so they get batched.
  - **`/suggest`** accepts `memories` (quick memories) and `locale` now. The Go `SuggestRequest` doesn't send either yet.
  - **Robot-voice contrast (demo step 6):** `voiceId: "default"` is a generic, non-cloned voice. Switching the session back to it is enough; no model-service change is needed.
  - **Root files touched in this PR, please review:**
    - `Makefile`: `make models` now runs `uv run --extra $(MODELS_BACKEND)`, and sets `DATA_DIR=../../data` so voices sit next to the gateway's data. Without the extra, the real service can't import its backend.
    - `.env.example`: `MODELS_BACKEND`, `OLLAMA_URL`, `SUGGEST_MODEL=gemma4:e4b`; `STT_MODEL` and `TTS_MODEL` are now empty by default.
- **Dev 2 (voice routes, PR #13):**
  - The `transcript` blocker is fixed: uploads without a transcript work against the real service.
  - The gateway turns every model-service failure into `502 model_error`. A model-service `400` carries a user-safe `detail` (for example "the sample needs at least 3 seconds of speech"), which could be passed to the phone as `400 bad_request`.

---

## Handoff guide

### Map of the service
| File | What lives there |
|---|---|
| `app/main.py` | routes, `Readiness` (`/health` + 503s), background loading (`load_all`) |
| `app/backends/__init__.py` | picks engines by `MODELS_BACKEND`; `OnOneThread` runs all STT on one thread |
| `app/backends/base.py` | the three interfaces: `SttEngine`, `SuggestBackend`, `TtsEngine` |
| `app/backends/{cuda,mlx,ollama}.py` | the engines; heavy imports happen inside `load()` |
| `app/stt_stream.py` | `Segmenter` (pure VAD state machine) and `SttSession` (one WebSocket) |
| `app/tts.py` | `TtsService`: voices on disk, prompt cache, worker thread, batching |
| `app/audio.py` | decode (PyAV), reference trimming, speech measurement, WAV |
| `app/prompts/*.md` | suggestion and summary prompts (`str.format` placeholders) |
| `assets/default_voice.*` | the built-in voice (`scripts/make_default_voice.py` regenerates it) |
| `scripts/bench_pipeline.py` | 20-turn latency run → `docs/latency.md` |
| `scripts/bench_tts.py`, `scripts/smoke_clone.py` | the earlier CUDA TTS spike |

### Rules that are easy to break
- **Only the TTS worker thread touches the TTS model**, and only the `OnOneThread` thread touches the STT model. That covers `load()` too: MLX expects arrays to be used on the thread that created them, and one GPU can't be shared between threads. `test_the_model_is_only_touched_from_the_worker_thread` checks the TTS side.
- **Never block the event loop.** The WebSocket reads frames while transcription runs in a thread; only the newest partial is kept.
- **No heavy imports at module level** in `app/`. `make test-models` runs `uv run` without extras, so torch, qwen-tts and mlx aren't installed there.
- **Model-service failures are HTTP errors, never crashes.** A load failure shows as `error` in `/health`, and the suggest loader retries every 10 s (Ollama may start later).
- **Local-first (§2):** no remote calls. Ollama is on `127.0.0.1`, and Hugging Face is only used to download weights.
- **Voice references are personal data.** They live only in `DATA_DIR/voices/` (git-ignored), and `DELETE /voices/{id}` removes them.

### Testing
- **Unit tests, any machine:** `cd services/models && uv run pytest`. Fakes are in `tests/conftest.py`; there are 54 tests, including WebSocket STT and `/voices` with real decoding.
- **3080:** `uv run --extra cuda pytest -m slow`, then `make models MODELS_BACKEND=cuda` and the bench script.
- **Mac:** `uv run --extra mlx pytest`. There are no MLX slow tests yet; adding them is part of the first Mac run.
- **Lint:** `uv run ruff check . && uv run ruff format --check .`
- On a machine where you use an extra, keep passing it (`uv run --extra cuda ...`). A plain `uv run` syncs the environment back to no extras and uninstalls torch.

### Review checklist for this PR (for teammates' agents)
1. `uv run pytest` and ruff pass in `services/models` with no extras installed.
2. The contract matches `AGENTS(GH).md` §6.2 and the gateway's `internal/models/client.go` and `voices.go`. Field names are unchanged; new fields are optional with defaults.
3. No route can reach the model from a request thread except through `TtsService` / `OnOneThread`.
4. `/voices` rejects a missing `consentId` before reading the upload, and never writes anything to disk for a rejected upload.
5. `voiceId` path safety: only `v_<hex>` ids touch the filesystem (`_safe_id`), so `../` ids are 404.
6. The Makefile and `.env.example` changes are acceptable to Dev 4.
