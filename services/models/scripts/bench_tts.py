"""Benchmark Qwen3-TTS voice cloning on CUDA: cold load, voice-prompt creation, warm generation, batch of 3.

Each model runs in its own subprocess, so its cold start and peak VRAM aren't affected by the model before it.
Per-model results go to data/out/bench/results-<model>.json, every clip to data/out/bench/<model>/, and a summary
to docs/latency.md between the bench_tts markers (the rest of that file is left alone).

Run from services/models:
    uv run --extra cuda python scripts/bench_tts.py \
        --ref-audio ../../data/ref/sample.wav --ref-text-file ../../data/ref/sample.txt
"""

import argparse
import datetime as dt
import importlib.metadata
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODELS = ["Qwen/Qwen3-TTS-12Hz-0.6B-Base", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"]
SEED = 0

WARMUP = ["Hello, this is a warm-up sentence.", "One more warm-up before we start."]
REPLIES = [
    "Yes, that sounds great.",
    "Can you bring the photo albums tomorrow?",
    "I'm feeling a little tired today.",
    "Could you open the window, please?",
    "Thank you for coming to see me.",
    "I'd like some water, please.",
    "Not right now, maybe later.",
    "How was your trip to the coast?",
    "Please tell the nurse I'm in pain.",
    "I slept much better last night.",
    "Can we watch the game together on Sunday?",
    "I miss cooking dinner for everyone.",
    "That's wonderful news, congratulations!",
    "Could you turn the music down a bit?",
    "I want to call my sister this evening.",
    "What did the doctor say this morning?",
    "Sure, that works for me.",
    "Let's go for a walk in the garden after lunch.",
    "I'd love to hear about the grandkids and their new school.",
    "Remind me to take my medicine at eight o'clock.",
]
BATCH = ["Better than yesterday, thanks.", "A little tired.", "Is the doctor coming today?"]  # mock /suggest replies
BATCH_RUNS = 5
assert len(REPLIES) == 20 and all(20 <= len(r) <= 60 for r in REPLIES)

MARK_START, MARK_END = "<!-- bench_tts:start -->", "<!-- bench_tts:end -->"


def nvidia_smi(query: str, kind: str = "gpu") -> list[list[str]]:
    flag = "--query-gpu" if kind == "gpu" else "--query-compute-apps"
    out = subprocess.run(
        ["nvidia-smi", f"{flag}={query}", "--format=csv,noheader,nounits"], capture_output=True, text=True, check=True
    ).stdout
    return [[c.strip() for c in line.split(",")] for line in out.strip().splitlines() if line.strip()]


class VramSampler(threading.Thread):
    """Polls nvidia-smi for this process's GPU memory (MiB), since it includes the CUDA context torch doesn't count."""

    def __init__(self, interval: float = 0.2) -> None:
        super().__init__(daemon=True)
        self.interval, self.peak_mib, self._halt = interval, 0, threading.Event()

    def run(self) -> None:
        pid = str(os.getpid())
        while not self._halt.is_set():
            for row in nvidia_smi("pid,used_memory", kind="apps"):
                if row[0] == pid and row[1].isdigit():
                    self.peak_mib = max(self.peak_mib, int(row[1]))
            self._halt.wait(self.interval)

    def stop(self) -> int:
        self._halt.set()
        self.join()
        return self.peak_mib


def page_cache_fraction(model_id: str) -> float | None:
    """Fraction of the model's files already in the OS page cache, so 'cold load' can be read honestly."""
    from huggingface_hub import snapshot_download

    files = [str(p) for p in Path(snapshot_download(model_id, local_files_only=True)).rglob("*") if p.is_file()]
    try:
        out = subprocess.run(
            ["fincore", "--bytes", "--noheadings", "--raw", "--output", "RES,SIZE", *files],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    res = size = 0
    for line in out.splitlines():
        r, s = line.split()
        res, size = res + int(r), size + int(s)
    return res / size if size else None


def load_mono(path: Path) -> tuple[np.ndarray, int]:
    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    return wav.mean(axis=1), sr


def run_child(model_id: str, ref_audio: Path, ref_text: str, out_dir: Path, attn: str) -> dict:
    cached = page_cache_fraction(model_id)
    t_import = time.perf_counter()
    import torch
    from qwen_tts import Qwen3TTSModel

    torch.cuda.init()
    import_s = time.perf_counter() - t_import

    torch.manual_seed(SEED)
    torch.cuda.reset_peak_memory_stats()
    sampler = VramSampler()
    sampler.start()

    kwargs = {"device_map": "cuda:0", "dtype": torch.bfloat16}
    if attn == "auto" and importlib.util.find_spec("flash_attn"):
        attn = "flash_attention_2"
    if attn != "auto":
        kwargs["attn_implementation"] = attn

    def timed(fn):
        torch.cuda.synchronize()
        t = time.perf_counter()
        result = fn()
        torch.cuda.synchronize()
        return result, time.perf_counter() - t

    model, load_s = timed(lambda: Qwen3TTSModel.from_pretrained(model_id, **kwargs))
    ref = load_mono(ref_audio)
    make_prompt = lambda: model.create_voice_clone_prompt(ref_audio=ref, ref_text=ref_text)  # noqa: E731
    prompt, prompt_first_s = timed(make_prompt)
    prompt_warm_s = [timed(make_prompt)[1] for _ in range(3)]

    clip_dir = out_dir / model_id.split("/")[-1]
    clip_dir.mkdir(parents=True, exist_ok=True)

    def say(texts: list[str], names: list[str]) -> tuple[list[float], float]:
        (wavs, sr), secs = timed(
            lambda: model.generate_voice_clone(text=texts, language="English", voice_clone_prompt=prompt)
        )
        for wav, name in zip(wavs, names, strict=True):
            sf.write(clip_dir / f"{name}.wav", wav, sr)
        return [len(w) / sr for w in wavs], secs

    warmup = []
    for i, text in enumerate(WARMUP, 1):
        durs, secs = say([text], [f"warmup_{i}"])
        warmup.append({"text": text, "gen_s": secs, "audio_s": durs[0]})

    replies = []
    for i, text in enumerate(REPLIES, 1):
        durs, secs = say([text], [f"reply_{i:02d}"])
        replies.append({"text": text, "chars": len(text), "gen_s": secs, "audio_s": durs[0], "rtf": secs / durs[0]})
        print(f"  reply {i:2d}  {len(text):2d} chars  gen {secs:5.2f}s  audio {durs[0]:5.2f}s", flush=True)

    batch: dict = {"texts": BATCH}
    try:
        say(BATCH, [f"batch_warmup_{j}" for j in range(3)])
        runs, singles = [], []
        for r in range(1, BATCH_RUNS + 1):
            durs, secs = say(BATCH, [f"batch_r{r}_{j}" for j in range(3)])
            runs.append({"gen_s": secs, "audio_s": durs})
            singles.append(sum(say([t], [f"batch_r{r}_single_{j}"])[1] for j, t in enumerate(BATCH)))
        batch |= {"ok": True, "runs": runs, "singles_sum_s": singles}
    except Exception as e:  # batching is optional; record why it failed instead of aborting the benchmark
        batch |= {"ok": False, "error": f"{type(e).__name__}: {e}"}

    nvsmi_peak = sampler.stop()
    return {
        "model": model_id,
        "attn": kwargs.get("attn_implementation", "default"),
        "page_cache_before_load": cached,
        "import_cuda_init_s": import_s,
        "load_s": load_s,
        "ref_audio_s": len(ref[0]) / ref[1],
        "prompt_first_s": prompt_first_s,
        "prompt_warm_s": prompt_warm_s,
        "warmup": warmup,
        "replies": replies,
        "batch": batch,
        "torch_peak_alloc_mib": torch.cuda.max_memory_allocated() / 2**20,
        "torch_peak_reserved_mib": torch.cuda.max_memory_reserved() / 2**20,
        "nvidia_smi_process_peak_mib": nvsmi_peak,
        "env": {
            "gpu": torch.cuda.get_device_name(0),
            "torch": torch.__version__,
            "torch_cuda": torch.version.cuda,
            **{p: importlib.metadata.version(p) for p in ("qwen-tts", "transformers")},
            "flash_attn": importlib.metadata.version("flash-attn") if importlib.util.find_spec("flash_attn") else None,
        },
    }


def check_gpu(min_free_mib: int) -> None:
    used, total, free = (int(x) for x in nvidia_smi("memory.used,memory.total,memory.free")[0])
    apps = nvidia_smi("pid,process_name,used_memory", kind="apps")
    print(f"GPU before run: {used}/{total} MiB used, {free} MiB free; processes: {apps or 'none'}")
    if free < min_free_mib:
        sys.exit(f"Only {free} MiB free (need {min_free_mib}). Someone else is using the GPU; not starting.")


def fmt_s(x: float) -> str:
    return f"{x:.2f} s"


def render(results: list[dict]) -> str:
    env = results[0]["env"]
    driver = nvidia_smi("driver_version")[0][0]
    banner = subprocess.run(["nvidia-smi"], capture_output=True, text=True).stdout
    cuda = banner.split("CUDA Version:")[1].split()[0] if "CUDA Version:" in banner else "?"
    total = nvidia_smi("memory.total")[0][0]
    lines = [
        MARK_START,
        "## RTX 3080 server: Qwen3-TTS voice cloning (CUDA)",
        "",
        f"Measured {dt.date.today().isoformat()} by `services/models/scripts/bench_tts.py` on {env['gpu']} "
        f"({total} MiB), driver {driver} (CUDA {cuda}), torch {env['torch']} (cu{env['torch_cuda']}), "
        f"qwen-tts {env['qwen-tts']}, transformers {env['transformers']}, bf16, "
        f"FlashAttention 2: **{'on' if results[0]['attn'] == 'flash_attention_2' else 'off'}** "
        f"({results[0]['attn']}). Reference clip {results[0]['ref_audio_s']:.1f} s. Sampling uses the model's "
        f"`generate_config.json` defaults (seed {SEED}), so audio length varies from run to run.",
        "",
        "| Model | Cold load | Voice prompt (first / warm median) | Gen p50 | Gen p95 | Gen max | RTF p50 "
        "| Batch of 3, one call (median) | Same 3 one by one (median) | Peak VRAM: torch alloc / reserved "
        "| Peak VRAM: nvidia-smi (process) |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        gen = np.array([x["gen_s"] for x in r["replies"]])
        rtf = np.array([x["rtf"] for x in r["replies"]])
        b = r["batch"]
        if b["ok"]:
            batch = fmt_s(float(np.median([x["gen_s"] for x in b["runs"]])))
            singles = fmt_s(float(np.median(b["singles_sum_s"])))
        else:
            batch, singles = f"failed: {b['error'][:80]}", "–"
        lines.append(
            f"| `{r['model'].split('/')[-1]}` | {fmt_s(r['load_s'])} | {fmt_s(r['prompt_first_s'])} / "
            f"{fmt_s(float(np.median(r['prompt_warm_s'])))} | {fmt_s(float(np.percentile(gen, 50)))} "
            f"| {fmt_s(float(np.percentile(gen, 95)))} | {fmt_s(float(gen.max()))} | {np.percentile(rtf, 50):.2f} "
            f"| {batch} | {singles} | {r['torch_peak_alloc_mib'] / 1024:.2f} / "
            f"{r['torch_peak_reserved_mib'] / 1024:.2f} GiB | {r['nvidia_smi_process_peak_mib'] / 1024:.2f} GiB |"
        )
    lines += [
        "",
        "How to read this:",
        "- **Gen** is one `generate_voice_clone` call for one reply of 20–60 characters (n = 20, after 2 warm-up "
        "calls that are excluded), with the voice prompt already cached. With n = 20, p95 is interpolated between "
        "the two slowest calls.",
        "- **RTF** (real-time factor) = generation time ÷ audio duration; below 1 is faster than real time.",
        "- **Cold load** is `from_pretrained` onto the GPU in a fresh process, after Python imports and CUDA init "
        "(" + ", ".join(f"{r['import_cuda_init_s']:.1f} s for {r['model'].split('/')[-1]}" for r in results) + "). "
        "Share of weights already in the OS page cache beforehand: "
        + ", ".join(
            f"{r['model'].split('/')[-1]} "
            + ("unknown" if r["page_cache_before_load"] is None else f"{r['page_cache_before_load']:.0%}")
            for r in results
        )
        + ". A load right after a reboot reads from NVMe and can be slower.",
        "- **Batch of 3** is one call with three texts and the same voice prompt "
        f"({BATCH_RUNS} runs after 1 warm-up); the next column runs the same three texts as three separate calls.",
        "- **nvidia-smi** includes the CUDA context and allocator cache, so it's what other jobs on this GPU "
        "actually lose; it was polled every 0.2 s.",
        "",
    ]
    for r in results:
        lines += [
            f"<details><summary>Per-reply timings: {r['model'].split('/')[-1]}</summary>",
            "",
            "| # | Chars | Gen | Audio | RTF | Text |",
            "|---|---|---|---|---|---|",
        ]
        lines += [
            f"| {i} | {x['chars']} | {fmt_s(x['gen_s'])} | {fmt_s(x['audio_s'])} | {x['rtf']:.2f} | {x['text']} |"
            for i, x in enumerate(r["replies"], 1)
        ]
        lines += ["", "</details>", ""]
    lines.append(MARK_END)
    return "\n".join(lines)


def write_doc(block: str, doc: Path) -> None:
    text = doc.read_text(encoding="utf-8") if doc.exists() else "# Latency\n"
    if MARK_START in text and MARK_END in text:
        head, rest = text.split(MARK_START, 1)
        text = head + block + rest.split(MARK_END, 1)[1]
    else:
        text = text.rstrip("\n") + "\n\n" + block + "\n"
    doc.write_text(text, encoding="utf-8")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", action="append", help="repeatable; default: the 0.6B and 1.7B Base models")
    p.add_argument("--ref-audio", type=Path, required=True)
    p.add_argument("--ref-text-file", type=Path, required=True)
    p.add_argument("--attn", default="auto", help="auto (flash_attention_2 if installed), sdpa, eager, ...")
    p.add_argument("--out-dir", type=Path, default=REPO_ROOT / "data" / "out" / "bench")
    p.add_argument("--doc", type=Path, default=REPO_ROOT / "docs" / "latency.md")
    p.add_argument("--min-free-mib", type=int, default=7000)
    p.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = p.parse_args()
    models = args.model or DEFAULT_MODELS
    args.out_dir.mkdir(parents=True, exist_ok=True)

    def results_path(m: str) -> Path:
        return args.out_dir / f"results-{m.split('/')[-1]}-{args.attn}.json"

    if args.child:
        ref_text = args.ref_text_file.read_text(encoding="utf-8").strip()
        result = run_child(models[0], args.ref_audio, ref_text, args.out_dir, args.attn)
        results_path(models[0]).write_text(json.dumps(result, indent=2), encoding="utf-8")
        return

    for m in models:
        check_gpu(args.min_free_mib)
        print(f"== {m}", flush=True)
        cmd = [sys.executable, __file__, "--child", "--model", m, "--ref-audio", str(args.ref_audio)]
        cmd += ["--ref-text-file", str(args.ref_text_file), "--attn", args.attn, "--out-dir", str(args.out_dir)]
        subprocess.run(cmd, check=True)

    results = [json.loads(results_path(m).read_text(encoding="utf-8")) for m in models]
    write_doc(render(results), args.doc)
    print(f"wrote {args.doc} and {len(results)} result files in {args.out_dir}")


if __name__ == "__main__":
    main()
