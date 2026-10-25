"""Audio in and out: decode uploaded samples (audio, or video with an audio track), trim references, encode WAV.

PyAV bundles FFmpeg's libraries, so webm/opus from Chrome's MediaRecorder, mp4/aac from Safari, and picked video files
all decode without a system ffmpeg.
"""

import io
import wave

import numpy as np

HOP_S = 0.02  # 20 ms analysis windows, the same size as the phone's frames


class BadAudio(ValueError):
    """The upload isn't usable as a voice sample. The message is safe to show the user."""


def decode(data: bytes, sample_rate: int) -> np.ndarray:
    """Decode any container FFmpeg reads into mono float32 at sample_rate."""
    import av

    chunks: list[np.ndarray] = []
    try:
        with av.open(io.BytesIO(data)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise BadAudio("the upload has no audio track")
            resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)
            for frame in container.decode(stream):
                chunks += [out.to_ndarray().reshape(-1) for out in resampler.resample(frame)]
            chunks += [out.to_ndarray().reshape(-1) for out in resampler.resample(None)]
    except av.error.FFmpegError as e:
        raise BadAudio(f"can't decode the upload: {e}") from e
    if not chunks:
        raise BadAudio("the upload has no audio")
    return np.concatenate(chunks).astype(np.float32)


def resample(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    return samples if from_rate == to_rate else decode(to_wav(samples, from_rate), to_rate)


def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{path}: expected 16-bit PCM")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, w.getnchannels())
        return pcm.mean(axis=1).astype(np.float32) / 32768.0, w.getframerate()


def window_rms(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    hop = int(sample_rate * HOP_S)
    n = len(samples) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    frames = samples[: n * hop].reshape(n, hop)
    return np.sqrt(np.mean(frames**2, axis=1))


def voiced_windows(rms: np.ndarray) -> np.ndarray:
    """Windows well above the clip's noise floor. The floor estimate is capped, so a clip with no pauses (whose
    quietest windows are still speech) isn't measured against itself."""
    floor = min(float(np.percentile(rms, 10)), 0.01)
    return rms > max(0.01, floor * 3)


def speech_seconds(samples: np.ndarray, sample_rate: int) -> float:
    """Rough amount of speech in a clip."""
    rms = window_rms(samples, sample_rate)
    return float(voiced_windows(rms).sum()) * HOP_S if rms.size else 0.0


def prepare_reference(samples: np.ndarray, sample_rate: int, max_seconds: float) -> np.ndarray:
    """Trim leading/trailing silence, cut long clips at the quietest point in the last third, normalize the peak.

    Cloning only needs ~10 s; a longer reference makes the voice prompt, and every generation after it, slower.
    """
    rms = window_rms(samples, sample_rate)
    hop = int(sample_rate * HOP_S)
    if rms.size:
        voiced = np.flatnonzero(voiced_windows(rms))
        if voiced.size:
            start = max(0, (voiced[0] - 10) * hop)  # keep 200 ms of lead-in
            end = min(len(samples), (voiced[-1] + 10) * hop)
            samples = samples[start:end]
            rms = window_rms(samples, sample_rate)
    max_len = int(max_seconds * sample_rate)
    if len(samples) > max_len:
        hi = min(len(rms), max_len // hop)
        lo = hi * 2 // 3
        cut = (lo + int(np.argmin(rms[lo:hi]))) * hop if hi > lo else max_len
        samples = samples[:cut]
    peak = float(np.abs(samples).max()) if samples.size else 0.0
    return (samples * (0.9 / peak) if peak > 0 else samples).astype(np.float32)
