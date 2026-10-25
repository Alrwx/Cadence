import io

import av
import numpy as np
import pytest

from app.audio import BadAudio, decode, pcm16_to_float, prepare_reference, speech_seconds, to_wav
from app.config import ASSETS
from tests.conftest import silence, speech_like


def encode(samples: np.ndarray, rate: int, fmt: str, codec: str, with_video: bool = False) -> bytes:
    """What a phone uploads: webm/opus from Chrome's MediaRecorder, mp4/aac from Safari, or a video file."""
    buf = io.BytesIO()
    with av.open(buf, "w", format=fmt) as out:
        if with_video:
            video = out.add_stream("libvpx" if fmt == "webm" else "mpeg4", rate=10)
            video.width, video.height, video.pix_fmt = 64, 64, "yuv420p"
        stream = out.add_stream(codec, rate=48000)
        stream.layout = "mono"
        pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
        frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = rate
        resampler = av.AudioResampler(format=stream.format.name, layout="mono", rate=48000)
        for f in resampler.resample(frame) + resampler.resample(None):
            for packet in stream.encode(f):
                out.mux(packet)
        if with_video:
            for _ in range(int(len(samples) / rate * 10)):
                img = av.VideoFrame.from_ndarray(np.zeros((64, 64, 3), dtype=np.uint8), format="rgb24")
                for packet in video.encode(img):
                    out.mux(packet)
            for packet in video.encode():
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    return buf.getvalue()


def test_wav_is_resampled():
    audio = decode(to_wav(speech_like(2.0, rate=44100), 44100), 16000)
    assert abs(len(audio) / 16000 - 2.0) < 0.01
    assert audio.dtype == np.float32


@pytest.mark.parametrize(
    ("fmt", "codec", "video"), [("webm", "libopus", False), ("mp4", "aac", False), ("webm", "libopus", True)]
)
def test_phone_recordings_decode(fmt, codec, video):
    data = encode(speech_like(3.0, rate=48000), 48000, fmt, codec, with_video=video)
    audio = decode(data, 24000)
    assert 2.8 < len(audio) / 24000 < 3.3
    assert speech_seconds(audio, 24000) > 1.5


def test_garbage_is_bad_audio():
    with pytest.raises(BadAudio):
        decode(b"\x00\x01garbage" * 100, 16000)


def test_pcm16_frames():
    frame = np.array([0, 16384, -32768], dtype="<i2").tobytes()
    assert pcm16_to_float(frame).tolist() == [0.0, 0.5, -1.0]


def test_reference_is_trimmed_and_cut_at_a_pause():
    rate = 24000
    clip = np.concatenate(
        [silence(1.0, rate), speech_like(10.5, rate), silence(0.4, rate), speech_like(12.0, rate, seed=1)]
    )
    ref = prepare_reference(clip, rate, max_seconds=15.0)
    # leading silence trimmed to 200 ms, then cut inside the pause after 10.5 s of speech
    assert 10.6 < len(ref) / rate < 11.1
    assert abs(float(np.abs(ref).max()) - 0.9) < 1e-3


def test_default_voice_asset_is_usable():
    audio = decode((ASSETS / "default_voice.wav").read_bytes(), 24000)
    assert speech_seconds(audio, 24000) > 5
    assert (ASSETS / "default_voice.txt").read_text().strip()
