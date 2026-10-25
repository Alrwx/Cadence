import threading

import pytest

from app.tts import DEFAULT_VOICE, UnknownVoice, max_tokens
from tests.conftest import FakeStt, FakeTtsEngine, make_tts, sample_wav


def test_concurrent_requests_for_one_voice_share_a_batch(tmp_path):
    engine = FakeTtsEngine(delay=0.05)
    tts = make_tts(tmp_path, engine, max_batch=4, batch_window_ms=50)
    tts.synthesize(DEFAULT_VOICE, "warm", "en")  # builds the prompt, so the batch below isn't waiting on it
    engine.batches.clear()

    texts = ["Yes, please.", "Not right now.", "Can you ask me later?"]
    threads = [threading.Thread(target=tts.synthesize, args=(DEFAULT_VOICE, t, "en")) for t in texts]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(engine.batches[0]) == sorted(texts)
    assert len(engine.batches) == 1


def test_different_voices_are_not_batched_together(tmp_path):
    engine = FakeTtsEngine(delay=0.05)
    tts = make_tts(tmp_path, engine, batch_window_ms=50)
    other = tts.create_voice(sample_wav(), "My voice.", "c1", "en", FakeStt().transcribe)
    engine.batches.clear()

    threads = [
        threading.Thread(target=tts.synthesize, args=(DEFAULT_VOICE, "one", "en")),
        threading.Thread(target=tts.synthesize, args=(other, "two", "en")),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(engine.batches) == [["one"], ["two"]]


def test_the_model_is_only_touched_from_the_worker_thread(tmp_path):
    engine = FakeTtsEngine()
    tts = make_tts(tmp_path, engine)
    tts.load()
    tts.create_voice(sample_wav(), "My voice.", "c1", "en", FakeStt().transcribe)
    assert engine.threads == {"tts"}


def test_voices_survive_a_restart(tmp_path):
    first = make_tts(tmp_path)
    voice_id = first.create_voice(sample_wav(), "My voice.", "c1", "en", FakeStt().transcribe)

    engine = FakeTtsEngine()
    second = make_tts(tmp_path, engine)
    assert second.synthesize(voice_id, "Hello again.", "en").startswith(b"RIFF")
    assert engine.prompts == ["My voice."]  # rebuilt from the stored reference


def test_deleted_voices_are_gone(tmp_path):
    tts = make_tts(tmp_path)
    voice_id = tts.create_voice(sample_wav(), "My voice.", "c1", "en", FakeStt().transcribe)
    tts.delete_voice(voice_id)
    with pytest.raises(UnknownVoice):
        tts.synthesize(voice_id, "Hi", "en")


def test_engine_errors_reach_every_waiting_request(tmp_path):
    engine = FakeTtsEngine()
    engine.generate = lambda *a: (_ for _ in ()).throw(RuntimeError("CUDA out of memory"))
    tts = make_tts(tmp_path, engine)
    with pytest.raises(RuntimeError, match="out of memory"):
        tts.synthesize(DEFAULT_VOICE, "Hi", "en")
    with pytest.raises(RuntimeError):  # and the worker is still alive
        tts.synthesize(DEFAULT_VOICE, "Hi", "en")


def test_max_tokens_scales_with_the_longest_text():
    assert max_tokens(["Yes."]) < max_tokens(["Yes.", "Can you bring the photo albums tomorrow, please?"])
    assert max_tokens(["x" * 60]) == 12 * 13
