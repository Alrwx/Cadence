"""Pick engines by MODELS_BACKEND. Engines are cheap to construct; the models load later, in a background thread."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np

from app.backends.base import SttEngine, SuggestBackend
from app.backends.ollama import OllamaSuggest
from app.config import Settings
from app.tts import TtsService


class OnOneThread:
    """Runs every STT call on one dedicated thread.

    That serializes access to the one GPU across WebSockets and /voices, and MLX expects arrays to be used on the
    thread that created them.
    """

    def __init__(self, engine: SttEngine) -> None:
        self.engine = engine
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt")

    def load(self) -> None:
        self.pool.submit(self.engine.load).result()

    def transcribe(self, audio: np.ndarray, locale: str) -> str:
        return self.pool.submit(self.engine.transcribe, audio, locale).result()


@dataclass
class Models:
    stt: SttEngine
    suggest: SuggestBackend
    tts: TtsService


def build(s: Settings) -> Models:
    if s.backend == "mlx":
        from app.backends.mlx import MlxStt as Stt
        from app.backends.mlx import MlxTts as Tts
    elif s.backend == "cuda":
        from app.backends.cuda import CudaStt as Stt
        from app.backends.cuda import CudaTts as Tts
    else:
        raise ValueError(f"MODELS_BACKEND must be mlx or cuda, not {s.backend!r}")
    tts = TtsService(
        Tts(s.tts_model),
        voices_dir=s.data_dir / "voices",
        default_audio=s.default_voice_audio,
        default_text=s.default_voice_text,
        max_batch=s.tts_max_batch,
        batch_window_ms=s.tts_batch_window_ms,
    )
    return Models(stt=OnOneThread(Stt(s.stt_model)), suggest=OllamaSuggest(s.suggest_model, s.ollama_url), tts=tts)
