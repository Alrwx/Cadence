"""NVIDIA backends for the RTX 3080 server: Whisper via transformers, Qwen3-TTS via qwen-tts. Needs `--extra cuda`.

torch is imported inside load(), so the module imports (and the tests run) without the extra installed.
"""

import gc
import importlib.util
import logging
import os
from typing import Any

import numpy as np

from app.locale import language_code

# With Gemma in Ollama on the same 10 GB GPU, TTS ran out of memory while ~400 MB sat reserved but unusable.
# Expandable segments let PyTorch reuse that memory (docs/latency.md). Must be set before torch touches CUDA.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

log = logging.getLogger("models.cuda")


def _free(torch: Any) -> None:
    """After an out-of-memory error, drop what the failed call still holds (its traceback keeps the activations
    alive until the next full GC) and return it to the driver, so the next call, or Whisper, has room again."""
    gc.collect()
    torch.cuda.empty_cache()


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
        try:
            return self._transcribe(audio, locale)
        except self.torch.OutOfMemoryError:
            pass
        log.warning("stt out of GPU memory; freeing and retrying once")
        _free(self.torch)
        return self._transcribe(audio, locale)

    def _transcribe(self, audio: np.ndarray, locale: str) -> str:
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
        self.torch = torch
        self.model = Qwen3TTSModel.from_pretrained(self.model_id, **kwargs)

    def make_prompt(self, ref_audio: np.ndarray, ref_text: str) -> Any:
        return self.model.create_voice_clone_prompt(ref_audio=(ref_audio, self.sample_rate), ref_text=ref_text)

    def generate(self, prompt: Any, texts: list[str], language: str, max_tokens: int) -> list[np.ndarray]:
        """A batch needs more memory than one clip (more so with a long reference clip), so a batch that runs out
        is retried one clip at a time instead of failing every request in it."""
        try:
            return self._generate(prompt, texts, language, max_tokens)
        except self.torch.OutOfMemoryError:
            pass  # free outside the except block, where the error and its traceback are already gone
        _free(self.torch)
        if len(texts) == 1:
            raise RuntimeError("TTS ran out of GPU memory")
        log.warning("tts batch=%d out of GPU memory; retrying one at a time", len(texts))
        return [wav for text in texts for wav in self._generate(prompt, [text], language, max_tokens)]

    def _generate(self, prompt: Any, texts: list[str], language: str, max_tokens: int) -> list[np.ndarray]:
        wavs, sr = self.model.generate_voice_clone(
            text=texts, language=language, voice_clone_prompt=prompt, max_new_tokens=max_tokens
        )
        if sr != self.sample_rate:
            raise RuntimeError(f"model returned {sr} Hz, expected {self.sample_rate}")
        return [np.asarray(w, dtype=np.float32) for w in wavs]
