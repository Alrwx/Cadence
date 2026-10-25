"""Smoke tests with the real CUDA models (AGENTS(GH).md §8: one per backend, marked slow).

Run on the 3080 from services/models: uv run --extra cuda pytest -m slow
"""

import importlib.util

import pytest

from app.audio import decode, resample
from app.config import ASSETS
from tests.conftest import make_tts

pytestmark = pytest.mark.slow

if importlib.util.find_spec("torch") is None or importlib.util.find_spec("qwen_tts") is None:
    pytest.skip("needs `uv run --extra cuda`", allow_module_level=True)

import torch  # noqa: E402

if not torch.cuda.is_available():
    pytest.skip("needs an NVIDIA GPU", allow_module_level=True)

from app.backends.cuda import CudaStt, CudaTts  # noqa: E402
from app.config import DEFAULT_MODELS  # noqa: E402


@pytest.fixture(scope="module")
def stt():
    engine = CudaStt(DEFAULT_MODELS["cuda"]["stt"])
    engine.load()
    return engine


@pytest.fixture(scope="module")
def tts(tmp_path_factory):
    service = make_tts(tmp_path_factory.mktemp("voices"), CudaTts(DEFAULT_MODELS["cuda"]["tts"]))
    service.load()
    return service


def words(text: str) -> set[str]:
    return {w.strip(".,!?").lower() for w in text.split()}


def test_stt_transcribes_the_default_voice_clip(stt):
    audio = decode((ASSETS / "default_voice.wav").read_bytes(), 16000)
    heard = words(stt.transcribe(audio, "en"))
    expected = words((ASSETS / "default_voice.txt").read_text())
    assert len(heard & expected) / len(expected) > 0.8


def test_tts_round_trips_through_stt(tts, stt):
    wav = tts.synthesize("default", "Could you open the window, please?", "en")
    audio = decode(wav, 16000)
    assert 1.0 < len(audio) / 16000 < 6.0
    assert {"open", "window"} <= words(stt.transcribe(audio, "en"))


def test_cloned_voice_from_an_untranscribed_sample(tts, stt):
    sample = (ASSETS / "default_voice.wav").read_bytes()
    voice_id = tts.create_voice(sample, None, "consent_test", "en", stt.transcribe)
    wav = tts.synthesize(voice_id, "I need some water.", "en")
    assert "water" in words(stt.transcribe(decode(wav, 16000), "en"))
    tts.delete_voice(voice_id)


def test_a_batch_of_three(tts, stt):
    import threading

    texts = ["Yes, please.", "Not right now.", "Can you ask me later?"]
    out: dict[str, bytes] = {}
    threads = [
        threading.Thread(target=lambda t=t: out.__setitem__(t, tts.synthesize("default", t, "en"))) for t in texts
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert set(out) == set(texts)
    heard = words(stt.transcribe(resample(decode(out["Not right now."], 24000), 24000, 16000), "en"))
    assert {"not", "now"} <= heard
