"""Apple Silicon backends: mlx-whisper for STT, Qwen3-TTS via mlx-audio. Needs `--extra mlx` on macOS.

Written against the mlx-whisper 0.4.3 and mlx-audio 0.5.8 sources, but NOT YET RUN: there's no Mac in CI. The
first run on the M4 Pro is the check (docs/dev3.md). mlx is imported inside load(), so this module imports anywhere.
"""

from typing import Any

import numpy as np

from app.locale import language_code


class MlxStt:
    def __init__(self, model: str) -> None:
        self.model_id = model

    def load(self) -> None:
        import mlx_whisper

        self.mlx_whisper = mlx_whisper
        self.transcribe(np.zeros(16000, dtype=np.float32), "en")  # downloads and caches the model

    def transcribe(self, audio: np.ndarray, locale: str) -> str:
        result = self.mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.model_id,
            language=language_code(locale),
            temperature=0.0,
            condition_on_previous_text=False,
            verbose=None,
        )
        return str(result["text"]).strip()


class MlxTts:
    sample_rate = 24000

    def __init__(self, model: str) -> None:
        self.model_id = model

    def load(self) -> None:
        import mlx.core as mx
        from mlx_audio.tts.utils import load

        self.mx = mx
        self.model = load(self.model_id)
        self.sample_rate = self.model.sample_rate

    def make_prompt(self, ref_audio: np.ndarray, ref_text: str) -> Any:
        # mlx-audio caches the encoded reference itself (keyed by the clip), so the prompt is just the inputs.
        return self.mx.array(ref_audio), ref_text

    def generate(self, prompt: Any, texts: list[str], language: str, max_tokens: int) -> list[np.ndarray]:
        ref_audio, ref_text = prompt
        lang = language.lower()
        if len(texts) == 1:
            results = self.model.generate(
                text=texts[0], ref_audio=ref_audio, ref_text=ref_text, lang_code=lang, max_tokens=max_tokens
            )
            return [np.concatenate([np.array(r.audio, dtype=np.float32) for r in results])]
        out: list[np.ndarray | None] = [None] * len(texts)
        for r in self.model.batch_generate(
            texts=texts, ref_audio=ref_audio, ref_text=ref_text, lang_code=lang, max_tokens=max_tokens, stream=False
        ):
            out[r.sequence_idx] = np.array(r.audio, dtype=np.float32)
        if any(o is None for o in out):
            raise RuntimeError("mlx-audio batch returned fewer clips than texts")
        return out  # type: ignore[return-value]
