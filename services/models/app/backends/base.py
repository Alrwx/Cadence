"""Backend interfaces. Swapping MLX (Mac) for CUDA (3080 server) is a config change, never a code change.

The engines are deliberately small. Streaming, VAD, voice storage, batching and WAV encoding are shared code
(stt_stream.py, tts.py), so a new backend only has to load a model and run it.
"""

from typing import Any, Protocol

import numpy as np

from app.schemas import ContextItem, Reply, Style, Turn


class SttEngine(Protocol):
    def load(self) -> None:
        """Load the model and run one warm-up pass. Called once, off the event loop."""
        ...

    def transcribe(self, audio: np.ndarray, locale: str) -> str:
        """Transcribe one utterance: mono float32 at 16 kHz, at most 30 s. Always called from the same thread."""
        ...


class SuggestBackend(Protocol):
    def load(self) -> None: ...

    def suggest(
        self, history: list[Turn], style: Style, context: list[ContextItem], memories: list[str], locale: str, n: int
    ) -> list[Reply]: ...

    def summarize(self, turns: list[Turn], locale: str) -> str: ...


class TtsEngine(Protocol):
    sample_rate: int

    def load(self) -> None:
        """Called on the TTS worker thread, like make_prompt and generate."""
        ...

    def make_prompt(self, ref_audio: np.ndarray, ref_text: str) -> Any:
        """Build a reusable voice prompt from a reference clip (mono float32 at sample_rate) and its transcript."""
        ...

    def generate(self, prompt: Any, texts: list[str], language: str, max_tokens: int) -> list[np.ndarray]:
        """Speak each text in the prompt's voice; one mono float32 array per text, in order.

        language is a Qwen3-TTS language name ("English") or "Auto".
        """
        ...
