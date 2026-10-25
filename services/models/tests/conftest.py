"""Fake engines, so the service's own logic (routes, VAD, voices, batching) runs without models or a GPU."""

import threading
import time

import numpy as np
import pytest

from app.audio import to_wav
from app.backends import Models
from app.config import ASSETS
from app.schemas import Reply
from app.tts import TtsService

RATE = 24000


def speech_like(seconds: float, rate: int = 16000, level: float = 0.1, seed: int = 0) -> np.ndarray:
    """Noise with a syllable-rate envelope: loud enough for the VAD, nothing like silence."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * rate)) / rate
    envelope = 0.6 + 0.4 * np.sin(2 * np.pi * 4 * t)
    return (rng.standard_normal(t.size) * level * envelope).astype(np.float32)


def silence(seconds: float, rate: int = 16000) -> np.ndarray:
    return np.zeros(int(seconds * rate), dtype=np.float32)


class FakeStt:
    def __init__(self, text: str = "hello there") -> None:
        self.text, self.calls = text, []

    def load(self) -> None:
        pass

    def transcribe(self, audio: np.ndarray, locale: str) -> str:
        self.calls.append((len(audio), locale))
        return self.text


class FakeSuggest:
    def __init__(self) -> None:
        self.calls = []

    def load(self) -> None:
        pass

    def suggest(self, history, style, context, memories, locale, n):
        self.calls.append({"history": history, "memories": memories, "locale": locale, "n": n})
        return [Reply(text=f"reply {i}", kind="statement") for i in range(n)]

    def summarize(self, turns, locale):
        return f"{len(turns)} turns"


class FakeTtsEngine:
    sample_rate = RATE

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.batches: list[list[str]] = []
        self.prompts: list[str] = []
        self.threads: set[str] = set()

    def load(self) -> None:
        self.threads.add(threading.current_thread().name)

    def make_prompt(self, ref_audio, ref_text):
        self.threads.add(threading.current_thread().name)
        self.prompts.append(ref_text)
        return ("prompt", ref_text)

    def generate(self, prompt, texts, language, max_tokens):
        self.threads.add(threading.current_thread().name)
        self.batches.append(list(texts))
        time.sleep(self.delay)
        return [np.full(RATE // 10 + len(t), 0.1, dtype=np.float32) for t in texts]


def make_tts(tmp_path, engine=None, **kw) -> TtsService:
    return TtsService(
        engine or FakeTtsEngine(),
        voices_dir=tmp_path / "voices",
        default_audio=ASSETS / "default_voice.wav",
        default_text=ASSETS / "default_voice.txt",
        **kw,
    )


@pytest.fixture
def models(tmp_path) -> Models:
    return Models(stt=FakeStt(), suggest=FakeSuggest(), tts=make_tts(tmp_path))


def sample_wav(seconds: float = 5.0, rate: int = 16000) -> bytes:
    return to_wav(np.concatenate([silence(0.5, rate), speech_like(seconds, rate), silence(0.5, rate)]), rate)
