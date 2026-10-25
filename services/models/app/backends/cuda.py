"""NVIDIA backends for the RTX 3080 server: Whisper via transformers, Qwen3-TTS via qwen-tts. Needs `--extra cuda`.

torch is imported inside load(), so the module imports (and the tests run) without the extra installed.
"""

import importlib.util
import logging
from typing import Any

import numpy as np

from app.locale import language_code

log = logging.getLogger("models.cuda")


class CudaStt:
    def __init__(self, model: str) -> None:
        self.model_id = model

    def load(self) -> None:
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        self.torch = torch
        self.processor = WhisperProcessor.from_pretrained(self.model_id)
        self.model = WhisperForConditionalGeneration.from_pretrained(
            self.model_id, torch_dtype=torch.float16, attn_implementation="sdpa"
        ).to("cuda:0")
        self.model.eval()
        self.transcribe(np.zeros(16000, dtype=np.float32), "en")

    def transcribe(self, audio: np.ndarray, locale: str) -> str:
        features = self.processor(audio, sampling_rate=16000, return_tensors="pt").input_features
        with self.torch.inference_mode():
            ids = self.model.generate(
                features.to("cuda:0", self.torch.float16),
                language=language_code(locale),
                task="transcribe",
                max_new_tokens=200,
            )
        return self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip()


class CudaTts:
    sample_rate = 24000

    def __init__(self, model: str) -> None:
        self.model_id = model

    def load(self) -> None:
        import torch
        from qwen_tts import Qwen3TTSModel

        kwargs: dict[str, Any] = {"device_map": "cuda:0", "dtype": torch.bfloat16}
        if importlib.util.find_spec("flash_attn"):
            kwargs["attn_implementation"] = "flash_attention_2"
        log.info("loading %s (attention: %s)", self.model_id, kwargs.get("attn_implementation", "default"))
        self.model = Qwen3TTSModel.from_pretrained(self.model_id, **kwargs)

    def make_prompt(self, ref_audio: np.ndarray, ref_text: str) -> Any:
        return self.model.create_voice_clone_prompt(ref_audio=(ref_audio, self.sample_rate), ref_text=ref_text)

    def generate(self, prompt: Any, texts: list[str], language: str, max_tokens: int) -> list[np.ndarray]:
        wavs, sr = self.model.generate_voice_clone(
            text=texts, language=language, voice_clone_prompt=prompt, max_new_tokens=max_tokens
        )
        if sr != self.sample_rate:
            raise RuntimeError(f"model returned {sr} Hz, expected {self.sample_rate}")
        return [np.asarray(w, dtype=np.float32) for w in wavs]
