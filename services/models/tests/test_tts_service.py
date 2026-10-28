import threading
from concurrent.futures import Future

import pytest

from app.tts import DEFAULT_VOICE, MAX_CHUNK_CHARS, TtsService, UnknownVoice, max_tokens
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


def test_the_default_voice_version_follows_its_recording(tmp_path):
    other_audio, other_text = tmp_path / "ref.wav", tmp_path / "ref.txt"
    other_audio.write_bytes(sample_wav())
    other_text.write_text("Someone else.", encoding="utf-8")

    synthetic, synthetic_again = make_tts(tmp_path), make_tts(tmp_path)
    real = TtsService(FakeTtsEngine(), tmp_path / "voices", default_audio=other_audio, default_text=other_text)
    for tts in (synthetic, synthetic_again, real):
        tts.synthesize(DEFAULT_VOICE, "Yes", "en")

    assert synthetic.default_version == synthetic_again.default_version != ""
    assert real.default_version != synthetic.default_version


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


class DropsAClipOnce(FakeTtsEngine):
    def __init__(self) -> None:
        super().__init__()
        self.dropped = False

    def generate(self, prompt, texts, language, max_tokens):
        wavs = super().generate(prompt, texts, language, max_tokens)
        if not self.dropped:
            self.dropped = True
            return wavs[:-1]
        return wavs


def within(seconds, fn, *args):
    """Runs fn on a daemon thread, so a hung worker fails the test instead of hanging pytest."""
    result: Future = Future()

    def run():
        try:
            result.set_result(fn(*args))
        except Exception as e:  # noqa: BLE001
            result.set_exception(e)

    threading.Thread(target=run, daemon=True).start()
    return result.result(timeout=seconds)


def test_a_bad_batch_fails_its_request_and_the_worker_keeps_serving(tmp_path):
    tts = make_tts(tmp_path, DropsAClipOnce())
    with pytest.raises(RuntimeError):
        within(2, tts.synthesize, DEFAULT_VOICE, "Yes.", "en")
    assert within(2, tts.synthesize, DEFAULT_VOICE, "No.", "en").startswith(b"RIFF")


def test_long_text_is_synthesized_as_reply_sized_chunks_in_order(tmp_path):
    engine = FakeTtsEngine()
    tts = make_tts(tmp_path, engine, max_batch=4, batch_window_ms=50)
    tts.synthesize(DEFAULT_VOICE, "warm", "en")
    engine.batches.clear()

    text = " ".join(["This is one of the sentences I typed on the word board."] * 7)
    assert tts.synthesize(DEFAULT_VOICE, text, "en").startswith(b"RIFF")
    spoken = [chunk for batch in engine.batches for chunk in batch]
    assert all(len(chunk) <= MAX_CHUNK_CHARS for chunk in spoken)
    assert " ".join(spoken) == text
    assert len(engine.batches) == 1
