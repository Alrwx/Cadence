import asyncio

import numpy as np

from app.stt_stream import DEFAULT_VAD, Segmenter, SttSession, VadConfig, clean
from tests.conftest import silence, speech_like


def cuts_for(*parts: np.ndarray, cfg: VadConfig = DEFAULT_VAD):
    seg = Segmenter(cfg)
    audio = np.concatenate(parts)
    cuts = []
    for i in range(0, len(audio), 320):
        cuts += seg.feed(audio[i : i + 320])
    return seg, cuts


def test_silence_produces_nothing():
    _, cuts = cuts_for(silence(3.0))
    assert cuts == []


def test_one_utterance_gives_partials_then_one_final():
    _, cuts = cuts_for(silence(0.5), speech_like(2.0), silence(1.0))
    kinds = [c.kind for c in cuts]
    assert kinds.count("final") == 1 and kinds[-1] == "final"
    assert kinds.count("partial") >= 2  # ~every 600 ms of speech
    final = cuts[-1].audio
    # speech + preroll (<= 300 ms) + 200 ms of trailing silence, give or take the start detection
    assert 2.0 <= len(final) / 16000 <= 2.6


def test_two_utterances_are_numbered():
    _, cuts = cuts_for(silence(0.3), speech_like(1.0), silence(1.0), speech_like(1.0, seed=1), silence(1.0))
    finals = [c for c in cuts if c.kind == "final"]
    assert [c.utterance for c in finals] == [1, 2]


def test_short_blips_are_dropped():
    _, cuts = cuts_for(silence(0.5), speech_like(0.12), silence(1.0))
    assert cuts == []


def test_long_speech_is_cut_at_the_limit():
    cfg = VadConfig(max_utterance_s=3.0)
    _, cuts = cuts_for(silence(0.2), speech_like(7.0), cfg=cfg)
    assert sum(c.kind == "final" for c in cuts) == 2


def test_steady_noise_stops_counting_as_speech():
    # A fan at about -26 dBFS: after it has run for a while, it must not hold the VAD in speech forever.
    _, cuts = cuts_for(speech_like(30.0, level=0.05), cfg=VadConfig(max_utterance_s=60.0))
    assert sum(c.kind == "final" for c in cuts) <= 1


def test_flush_finishes_an_utterance_in_progress():
    seg, cuts = cuts_for(silence(0.3), speech_like(1.0))
    assert all(c.kind == "partial" for c in cuts)
    assert seg.flush().kind == "final"


def test_clean_drops_non_words():
    assert clean("  Hello   there ") == "Hello there"
    assert clean(" ... ") == ""


def test_session_drops_stale_partials_while_the_model_is_busy():
    async def run():
        sent, calls = [], []

        def slow_transcribe(audio, locale):
            import time

            calls.append(len(audio))
            time.sleep(0.3)
            return f"words {len(calls)}"

        async def send(msg):
            sent.append(msg)

        session = SttSession(slow_transcribe, "en", send)
        audio = np.concatenate([silence(0.3), speech_like(3.0), silence(1.0)])
        pcm = (audio * 32767).astype("<i2").tobytes()
        for i in range(0, len(pcm), 640):
            await session.feed(pcm[i : i + 640])
        await session.finish()
        return sent, calls

    sent, calls = asyncio.run(run())
    assert sent[-1]["kind"] == "final"
    # all audio arrived at once, so the queued partials were superseded by the final
    assert len(calls) < 6
