"""Render the built-in "default" voice: the generic, non-cloned voice the gateway uses until someone records a sample.

The Base model can only clone, so the default voice is a clone of a reference clip. This script renders that clip
once with a preset speaker from the CustomVoice model and writes it to assets/, where it's committed. At runtime
both backends clone it like any other voice, so no second TTS model stays loaded. The clip is synthetic (no real
person's voice), so it needs no consent record.

Run from services/models:
    uv run --extra cuda python scripts/make_default_voice.py
"""

import argparse
import importlib.util
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

ASSETS = Path(__file__).resolve().parent.parent / "assets"
TEXT = (
    "Hello. This is the standard voice of the Cadence app. "
    "It reads every reply clearly and steadily, in the same even tone."
)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    p.add_argument("--speaker", default="ryan")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    kwargs = {"device_map": "cuda:0", "dtype": torch.bfloat16}
    if importlib.util.find_spec("flash_attn"):
        kwargs["attn_implementation"] = "flash_attention_2"
    model = Qwen3TTSModel.from_pretrained(args.model, **kwargs)
    torch.manual_seed(args.seed)
    wavs, sr = model.generate_custom_voice(text=TEXT, speaker=args.speaker, language="English")
    wav = wavs[0].astype(np.float32)
    wav *= 0.9 / max(float(np.abs(wav).max()), 1e-6)

    ASSETS.mkdir(exist_ok=True)
    sf.write(ASSETS / "default_voice.wav", wav, sr, subtype="PCM_16")
    (ASSETS / "default_voice.txt").write_text(TEXT + "\n", encoding="utf-8")
    print(f"wrote {ASSETS / 'default_voice.wav'} ({len(wav) / sr:.1f} s @ {sr} Hz, speaker {args.speaker})")


if __name__ == "__main__":
    main()
