"""Apple Silicon backends: mlx-whisper, Gemma 4 via mlx-lm, Qwen3-TTS via mlx-audio.

Each class loads its model once in __init__. The method bodies are the M1 spikes: fill them in and record
timings in docs/latency.md. Until then they raise NotImplementedError, which the routes turn into 501.
"""

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Literal

from app.parsing import parse_replies
from app.schemas import ContextItem, Reply, Style, Turn

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"


class MlxStt:
    def __init__(self, model: str) -> None:
        self.model = model  # TODO(Dev 3): load mlx-whisper; VAD-based chunking

    async def transcribe(self, frames: AsyncIterator[bytes]) -> AsyncIterator[tuple[Literal["partial", "final"], str]]:
        raise NotImplementedError("mlx-whisper streaming STT")
        yield  # pragma: no cover  (makes this an async generator)


class MlxSuggest:
    def __init__(self, model: str) -> None:
        self.model = model  # TODO(Dev 3): load Gemma 4 E4B 4-bit with mlx-lm
        self.prompt = (PROMPTS / "suggest.md").read_text(encoding="utf-8")
        self.summary_prompt = (PROMPTS / "summarize.md").read_text(encoding="utf-8")

    def suggest(self, history: list[Turn], style: Style, context: list[ContextItem], n: int) -> list[Reply]:
        raw = self._generate(self._render(history, style, context, n))
        try:
            return parse_replies(raw, n)
        except ValueError:
            return parse_replies(self._generate(self._render(history, style, context, n)), n)  # retry once

    def summarize(self, turns: list[Turn]) -> str:
        transcript = "\n".join(f"{t.speaker}: {t.text}" for t in turns)
        return self._generate(self.summary_prompt.format(transcript=transcript)).strip()

    def _render(self, history: list[Turn], style: Style, context: list[ContextItem], n: int) -> str:
        return self.prompt.format(
            n=n,
            history="\n".join(f"{t.speaker}: {t.text}" for t in history[-8:]),
            tone=style.tone or "plain and friendly",
            phrases="\n".join(f"- {p}" for p in style.phrases) or "(none)",
            context="\n".join(f"- {c.label}: {c.summary}" for c in context) or "(none)",
        )

    def _generate(self, prompt: str) -> str:
        raise NotImplementedError("Gemma 4 generation via mlx-lm")


class MlxTts:
    def __init__(self, model: str) -> None:
        self.model = model  # TODO(Dev 3): load Qwen3-TTS Base via mlx-audio
        self.voices: dict[str, object] = {}  # voiceId -> cached voice prompt

    def create_voice(self, audio: bytes, transcript: str) -> str:
        raise NotImplementedError("Qwen3-TTS voice cloning")

    def delete_voice(self, voice_id: str) -> None:
        self.voices.pop(voice_id, None)

    def synthesize(self, voice_id: str, text: str) -> bytes:
        raise NotImplementedError("Qwen3-TTS synthesis")
