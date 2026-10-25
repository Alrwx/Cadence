"""Settings from the environment (see .env.example). Model IDs are pinned here, not in code."""

import os
from dataclasses import dataclass, field
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"

# Per-backend defaults; STT_MODEL / TTS_MODEL override them. An empty env var counts as unset.
DEFAULT_MODELS = {
    "mlx": {"stt": "mlx-community/whisper-large-v3-turbo", "tts": "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"},
    "cuda": {"stt": "openai/whisper-large-v3-turbo", "tts": "Qwen/Qwen3-TTS-12Hz-0.6B-Base"},
}


def _env(name: str, default: str) -> str:
    return os.getenv(name) or default


def _backend() -> str:
    return _env("MODELS_BACKEND", "mlx")


@dataclass(frozen=True)
class Settings:
    backend: str = field(default_factory=_backend)  # "mlx" on the Mac; "cuda" on the 3080 server
    stt_model: str = field(default_factory=lambda: _env("STT_MODEL", DEFAULT_MODELS.get(_backend(), {}).get("stt", "")))
    tts_model: str = field(default_factory=lambda: _env("TTS_MODEL", DEFAULT_MODELS.get(_backend(), {}).get("tts", "")))
    # Suggestions run in Ollama on both backends (docs/decisions.md). gemma4:e4b uses Ollama's MLX engine on the Mac.
    suggest_model: str = field(default_factory=lambda: _env("SUGGEST_MODEL", "gemma4:e4b"))
    ollama_url: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://127.0.0.1:11434"))
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", "./data")))
    default_voice_audio: Path = ASSETS / "default_voice.wav"
    default_voice_text: Path = ASSETS / "default_voice.txt"
    # Up to this many /tts requests for the same voice that arrive together are synthesized in one batch.
    tts_max_batch: int = field(default_factory=lambda: int(_env("TTS_MAX_BATCH", "4")))
    tts_batch_window_ms: int = field(default_factory=lambda: int(_env("TTS_BATCH_WINDOW_MS", "30")))
    allow_remote_fallback: bool = field(default_factory=lambda: os.getenv("ALLOW_REMOTE_FALLBACK", "0") == "1")


settings = Settings()
