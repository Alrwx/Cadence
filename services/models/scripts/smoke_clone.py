"""Smoke test: clone a voice from a reference clip and speak one line with Qwen3-TTS on CUDA.

Run from services/models:
    uv run --extra cuda python scripts/smoke_clone.py \
        --ref-audio ../../data/ref/sample.wav --ref-text "$(cat ../../data/ref/sample.txt)" \
        --text "Yes, that sounds great."
"""

import argparse
import importlib.util
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

REPO_ROOT = Path(__file__).resolve().parents[3]


def load_mono(path: Path) -> tuple[np.ndarray, int]:
    """Read audio ourselves and pass (waveform, sr): qwen_tts treats str inputs as paths, URLs, or base64."""
    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    return wav.mean(axis=1), sr


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-Base")
    p.add_argument("--ref-audio", type=Path, required=True)
    p.add_argument("--ref-text", required=True, help="exact transcript of the reference clip")
    p.add_argument("--text", required=True)
    p.add_argument("--out-dir", type=Path, default=REPO_ROOT / "data" / "out")
    args = p.parse_args()

    kwargs = {"device_map": "cuda:0", "dtype": torch.bfloat16}
    if importlib.util.find_spec("flash_attn"):
        kwargs["attn_implementation"] = "flash_attention_2"
    print(f"GPU: {torch.cuda.get_device_name(0)}  attention: {kwargs.get('attn_implementation', 'default')}")

    t0 = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(args.model, **kwargs)
    t1 = time.perf_counter()
    prompt = model.create_voice_clone_prompt(ref_audio=load_mono(args.ref_audio), ref_text=args.ref_text)
    t2 = time.perf_counter()
    wavs, sr = model.generate_voice_clone(text=args.text, language="English", voice_clone_prompt=prompt)
    torch.cuda.synchronize()
    t3 = time.perf_counter()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"smoke_{args.model.split('/')[-1]}.wav"
    sf.write(out, wavs[0], sr)
    dur = len(wavs[0]) / sr
    print(f"load {t1 - t0:.1f}s  prompt {t2 - t1:.2f}s  generate {t3 - t2:.2f}s  audio {dur:.2f}s @ {sr} Hz")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
