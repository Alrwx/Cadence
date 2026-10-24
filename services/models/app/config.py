"""Settings from the environment (see .env.example). Model IDs are pinned here, not in code."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    backend: str = os.getenv("MODELS_BACKEND", "mlx")  # "mlx" on the Mac; "cuda" on the 3080 server (stretch)
    stt_model: str = os.getenv("STT_MODEL", "")
    suggest_model: str = os.getenv("SUGGEST_MODEL", "")
    tts_model: str = os.getenv("TTS_MODEL", "")
    data_dir: str = os.getenv("DATA_DIR", "./data")
    allow_remote_fallback: bool = os.getenv("ALLOW_REMOTE_FALLBACK", "0") == "1"


settings = Settings()
