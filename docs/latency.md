# Latency

Measured numbers only (AGENTS(GH).md §9). Targets: instant < 1 s, suggested reply 2–3 s after the speaker stops.

| Date | Hardware | Step | Cold (ms) | Warm (ms) | Notes |
|---|---|---|---|---|---|
| | M4 Pro 24 GB | STT final | | | |
| | M4 Pro 24 GB | `/suggest` | | | |
| | M4 Pro 24 GB | `/tts` (40-char reply) | | | |
| | Hotspot | select → sound (end to end) | | | |

<!-- bench_tts:start -->
## RTX 3080 server: Qwen3-TTS voice cloning (CUDA)

Measured 2026-10-24 by `services/models/scripts/bench_tts.py` on NVIDIA GeForce RTX 3080 (10240 MiB), driver 550.163.01 (CUDA 12.4), torch 2.8.0+cu126 (cu12.6), qwen-tts 0.1.1, transformers 4.57.3, bf16, FlashAttention 2: **on** (flash_attention_2). Reference clip 13.6 s. Sampling uses the model's `generate_config.json` defaults (seed 0), so audio length varies from run to run.

| Model | Cold load | Voice prompt (first / warm median) | Gen p50 | Gen p95 | Gen max | RTF p50 | Batch of 3, one call (median) | Same 3 one by one (median) | Peak VRAM: torch alloc / reserved | Peak VRAM: nvidia-smi (process) |
|---|---|---|---|---|---|---|---|---|---|---|
| `Qwen3-TTS-12Hz-0.6B-Base` | 2.65 s | 0.79 s / 0.03 s | 3.36 s | 5.25 s | 5.28 s | 1.26 | 3.75 s | 8.02 s | 3.58 / 5.81 GiB | 6.08 GiB |
| `Qwen3-TTS-12Hz-1.7B-Base` | 2.81 s | 0.81 s / 0.04 s | 2.82 s | 4.31 s | 4.80 s | 1.26 | 2.78 s | 7.42 s | 5.33 / 7.50 GiB | 7.76 GiB |

How to read this:
- **Gen** is one `generate_voice_clone` call for one reply of 20–60 characters (n = 20, after 2 warm-up calls that are excluded), with the voice prompt already cached. With n = 20, p95 is interpolated between the two slowest calls.
- **RTF** (real-time factor) = generation time ÷ audio duration; below 1 is faster than real time.
- **Cold load** is `from_pretrained` onto the GPU in a fresh process, after Python imports and CUDA init (2.6 s for Qwen3-TTS-12Hz-0.6B-Base, 2.6 s for Qwen3-TTS-12Hz-1.7B-Base). Share of weights already in the OS page cache beforehand: Qwen3-TTS-12Hz-0.6B-Base 100%, Qwen3-TTS-12Hz-1.7B-Base 100%. A load right after a reboot reads from NVMe and can be slower.
- **Batch of 3** is one call with three texts and the same voice prompt (5 runs after 1 warm-up); the next column runs the same three texts as three separate calls.
- **nvidia-smi** includes the CUDA context and allocator cache, so it's what other jobs on this GPU actually lose; it was polled every 0.2 s.

<details><summary>Per-reply timings: Qwen3-TTS-12Hz-0.6B-Base</summary>

| # | Chars | Gen | Audio | RTF | Text |
|---|---|---|---|---|---|
| 1 | 23 | 3.32 s | 2.64 s | 1.26 | Yes, that sounds great. |
| 2 | 40 | 4.22 s | 3.36 s | 1.26 | Can you bring the photo albums tomorrow? |
| 3 | 33 | 2.74 s | 2.16 s | 1.27 | I'm feeling a little tired today. |
| 4 | 34 | 3.40 s | 2.72 s | 1.25 | Could you open the window, please? |
| 5 | 31 | 3.91 s | 3.12 s | 1.25 | Thank you for coming to see me. |
| 6 | 28 | 2.84 s | 2.24 s | 1.27 | I'd like some water, please. |
| 7 | 27 | 3.14 s | 2.48 s | 1.27 | Not right now, maybe later. |
| 8 | 31 | 2.83 s | 2.24 s | 1.27 | How was your trip to the coast? |
| 9 | 34 | 2.82 s | 2.24 s | 1.26 | Please tell the nurse I'm in pain. |
| 10 | 31 | 3.91 s | 3.12 s | 1.25 | I slept much better last night. |
| 11 | 41 | 3.40 s | 2.72 s | 1.25 | Can we watch the game together on Sunday? |
| 12 | 35 | 2.97 s | 2.32 s | 1.28 | I miss cooking dinner for everyone. |
| 13 | 39 | 3.81 s | 3.04 s | 1.25 | That's wonderful news, congratulations! |
| 14 | 36 | 3.11 s | 2.48 s | 1.25 | Could you turn the music down a bit? |
| 15 | 38 | 5.28 s | 4.24 s | 1.24 | I want to call my sister this evening. |
| 16 | 37 | 2.84 s | 2.24 s | 1.27 | What did the doctor say this morning? |
| 17 | 24 | 2.92 s | 2.32 s | 1.26 | Sure, that works for me. |
| 18 | 46 | 3.59 s | 2.88 s | 1.25 | Let's go for a walk in the garden after lunch. |
| 19 | 58 | 5.25 s | 4.24 s | 1.24 | I'd love to hear about the grandkids and their new school. |
| 20 | 47 | 5.05 s | 4.08 s | 1.24 | Remind me to take my medicine at eight o'clock. |

</details>

<details><summary>Per-reply timings: Qwen3-TTS-12Hz-1.7B-Base</summary>

| # | Chars | Gen | Audio | RTF | Text |
|---|---|---|---|---|---|
| 1 | 23 | 2.33 s | 1.84 s | 1.27 | Yes, that sounds great. |
| 2 | 40 | 3.01 s | 2.40 s | 1.25 | Can you bring the photo albums tomorrow? |
| 3 | 33 | 2.44 s | 1.92 s | 1.27 | I'm feeling a little tired today. |
| 4 | 34 | 2.13 s | 1.68 s | 1.27 | Could you open the window, please? |
| 5 | 31 | 2.33 s | 1.84 s | 1.26 | Thank you for coming to see me. |
| 6 | 28 | 2.34 s | 1.84 s | 1.27 | I'd like some water, please. |
| 7 | 27 | 2.60 s | 2.00 s | 1.30 | Not right now, maybe later. |
| 8 | 31 | 3.16 s | 2.48 s | 1.27 | How was your trip to the coast? |
| 9 | 34 | 2.81 s | 2.24 s | 1.26 | Please tell the nurse I'm in pain. |
| 10 | 31 | 2.51 s | 2.00 s | 1.26 | I slept much better last night. |
| 11 | 41 | 3.98 s | 3.20 s | 1.24 | Can we watch the game together on Sunday? |
| 12 | 35 | 2.83 s | 2.24 s | 1.26 | I miss cooking dinner for everyone. |
| 13 | 39 | 3.59 s | 2.88 s | 1.25 | That's wonderful news, congratulations! |
| 14 | 36 | 2.23 s | 1.76 s | 1.27 | Could you turn the music down a bit? |
| 15 | 38 | 3.47 s | 2.64 s | 1.31 | I want to call my sister this evening. |
| 16 | 37 | 2.96 s | 2.24 s | 1.32 | What did the doctor say this morning? |
| 17 | 24 | 2.53 s | 1.92 s | 1.32 | Sure, that works for me. |
| 18 | 46 | 3.79 s | 3.04 s | 1.25 | Let's go for a walk in the garden after lunch. |
| 19 | 58 | 4.80 s | 3.84 s | 1.25 | I'd love to hear about the grandkids and their new school. |
| 20 | 47 | 4.28 s | 3.44 s | 1.25 | Remind me to take my medicine at eight o'clock. |

</details>

<!-- bench_tts:end -->

<!-- bench_pipeline:start -->
## Pipeline: RTX 3080 server

Measured 2026-10-24 on **RTX 3080 server** (Linux x86_64), backend `cuda`, by `services/models/scripts/bench_pipeline.py` over HTTP/WebSocket (20 turns, warm). Values are p50 / p95 / max in ms.

| Step | p50 / p95 / max (ms) | Notes |
|---|---|---|
| STT final after the speaker stops | 713 / 771 / 773 | from the end of the clip, so the clip's own trailing silence counts toward the VAD's 700 ms end-of-speech wait; 20/20 transcripts had ≥ 80% of the words |
| `/suggest` | 389 / 436 / 459 | Gemma 4 via Ollama |
| `/tts`, 3 suggestions at once | 3184 / 3785 / 3857 | until the last of the 3 clips is back; batched |
| `/tts`, one reply | 2902 / 3798 / 3826 | alone; in the batches, wall time ÷ audio length per clip was 1.42 (p50) |
| `/tts`, instant phrase | 1475 / 1981 / 2297 | the gateway's clip cache serves repeats without this |
<!-- bench_pipeline:end -->

## RTX 3080 server: Gemma, Whisper and Qwen3-TTS on one GPU

Measured 2026-10-24 with Ollama v0.40.2 serving `gemma4:e4b` (Q4_K_M, context 4096, `keep_alive: -1`) next to the model service (`MODELS_BACKEND=cuda`, Whisper large-v3-turbo + Qwen3-TTS 0.6B Base). GPU memory is nvidia-smi, polled every 0.2 s during `bench_pipeline.py`.

| | GPU memory |
|---|---|
| Gemma in Ollama | 4.8 GB |
| Model service at rest / after TTS | 4.2 GB / 5.0–5.2 GB |
| Peak, whole GPU | 9,994 of 10,240 MiB |

- **Without `expandable_segments`, TTS ran out of memory.** One of two 20-turn runs got `torch.OutOfMemoryError` on `/tts` (needed 184 MiB, 161 MiB free, ~400 MiB reserved by PyTorch but unusable). With `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`, now the CUDA backend's default, two runs (40 turns) had no errors. The pipeline table above is the second of those runs.
- **The margin is about 250 MB.** The benchmark sends 3 clips per batch; the service allows up to 4 (`TTS_MAX_BATCH`), and a batch of 4 with long phrases hasn't been tested beside Gemma.
- **Load order matters.** If Gemma loads after the TTS allocator has grown, only 33 of 43 layers go on the GPU and `/suggest` slows from ~380 ms to ~850 ms. `ollama ps` still says "100% GPU"; check `offloaded N/43` in Ollama's log. In these runs Gemma was loaded before the model service started. The service's own startup loads TTS and warms Gemma in parallel, which should also give 43/43 but hasn't been tested from a cold start; `keep_alive: -1` keeps Gemma resident, so this only bites if Ollama restarts mid-session. Then restart the model service after Gemma is back.
- **Why TTS is slower than in the run without Gemma** (3.2 s against 2.2 s for 3 clips): the clips are longer. Speed per second of audio is unchanged (1.42 against 1.42 earlier). The earlier run had no `/suggest`, so it voiced different replies.
