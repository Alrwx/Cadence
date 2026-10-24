"""Backend interfaces. Swapping MLX (Mac) for CUDA (3080 server) is a config change, never a code change."""

from collections.abc import AsyncIterator
from typing import Literal, Protocol

from app.schemas import ContextItem, Reply, Style, Turn


class SttBackend(Protocol):
    def transcribe(self, frames: AsyncIterator[bytes]) -> AsyncIterator[tuple[Literal["partial", "final"], str]]:
        """Consume PCM16 16 kHz mono frames; yield (kind, text) as speech is recognized."""
        ...


class SuggestBackend(Protocol):
    def suggest(self, history: list[Turn], style: Style, context: list[ContextItem], n: int) -> list[Reply]: ...

    def summarize(self, turns: list[Turn]) -> str: ...


class TtsBackend(Protocol):
    def create_voice(self, audio: bytes, transcript: str) -> str:
        """Build and cache a voice prompt from a reference clip; return its voiceId."""
        ...

    def delete_voice(self, voice_id: str) -> None: ...

    def synthesize(self, voice_id: str, text: str) -> bytes:
        """Return WAV bytes."""
        ...
