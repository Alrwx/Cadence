"""Streaming STT on top of a whole-clip transcriber.

An energy VAD cuts the phone's PCM16 stream into utterances. While someone is talking, the utterance so far is
re-transcribed every ~600 ms and sent as a partial; ~700 ms of silence ends it and sends the final. Whisper on a
few seconds of audio takes well under that interval on both backends, so re-transcribing is simpler than a real
streaming decoder and gives the gateway what it needs for speculation (§3).
"""

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

import numpy as np

from app.audio import pcm16_to_float

log = logging.getLogger("models.stt")

Transcribe = Callable[[np.ndarray, str], str]


@dataclass(frozen=True)
class VadConfig:
    sample_rate: int = 16000
    min_rms: float = 0.008  # about -42 dBFS: quieter audio is never speech
    floor_ratio: float = 3.0  # speech is this many times louder than the running noise floor
    start_ms: int = 60  # this much voiced audio in a row starts an utterance
    end_silence_ms: int = 700  # this much silence ends it
    preroll_ms: int = 300  # audio kept from before the start, so first syllables aren't clipped
    min_speech_ms: int = 250  # shorter utterances (a cough, a door) are dropped
    partial_every_ms: int = 600
    max_utterance_s: float = 20.0


DEFAULT_VAD = VadConfig()


@dataclass(frozen=True)
class Cut:
    kind: Literal["partial", "final"]
    utterance: int
    audio: np.ndarray


class Segmenter:
    """Pure VAD state machine: feed samples, get back the audio to transcribe. No I/O, so it's easy to test."""

    def __init__(self, cfg: VadConfig = DEFAULT_VAD) -> None:
        self.cfg = cfg
        self.hop = cfg.sample_rate // 50  # 20 ms
        ms = lambda v: max(1, v // 20)  # noqa: E731
        self.start_hops, self.end_hops = ms(cfg.start_ms), ms(cfg.end_silence_ms)
        self.min_speech_hops, self.partial_hops = ms(cfg.min_speech_ms), ms(cfg.partial_every_ms)
        self.max_hops = int(cfg.max_utterance_s * 50)
        self.pending = np.zeros(0, dtype=np.float32)
        self.floor = 0.003
        self.preroll: deque[np.ndarray] = deque(maxlen=ms(cfg.preroll_ms))
        self.in_speech = False
        self.run = 0
        self.buf: list[np.ndarray] = []
        self.voiced_hops = self.silent_hops = self.since_partial = 0
        self.utterance = 0

    def feed(self, samples: np.ndarray) -> list[Cut]:
        data = np.concatenate([self.pending, samples]) if self.pending.size else samples
        n = len(data) // self.hop
        cuts = [c for i in range(n) if (c := self._step(data[i * self.hop : (i + 1) * self.hop])) is not None]
        self.pending = data[n * self.hop :]
        return cuts

    def flush(self) -> Cut | None:
        """The stream ended: finish an utterance in progress."""
        return self._finish() if self.in_speech else None

    def _step(self, hop: np.ndarray) -> Cut | None:
        rms = float(np.sqrt(np.mean(hop**2)))
        voiced = rms > max(self.cfg.min_rms, self.floor * self.cfg.floor_ratio)
        if not self.in_speech:
            # Track the noise floor; follow it up slowly even through "voiced" windows so steady loud noise
            # (a fan, a TV) stops counting as speech.
            self.floor += (0.05 if not voiced else 0.005) * (rms - self.floor)
            self.preroll.append(hop)
            self.run = self.run + 1 if voiced else 0
            if self.run >= self.start_hops:
                self.in_speech = True
                self.utterance += 1
                self.buf = list(self.preroll)
                self.preroll.clear()
                self.voiced_hops, self.silent_hops, self.since_partial, self.run = self.run, 0, 0, 0
            return None

        self.buf.append(hop)
        if voiced:
            self.voiced_hops += 1
            self.silent_hops = 0
        else:
            self.silent_hops += 1
        self.since_partial += 1
        if self.silent_hops >= self.end_hops or len(self.buf) >= self.max_hops:
            return self._finish()
        if self.since_partial >= self.partial_hops and self.voiced_hops >= self.min_speech_hops:
            self.since_partial = 0
            return Cut("partial", self.utterance, np.concatenate(self.buf))
        return None

    def _finish(self) -> Cut | None:
        keep = len(self.buf) - max(0, self.silent_hops - 10)  # keep 200 ms of the trailing silence
        audio = np.concatenate(self.buf[:keep]) if keep > 0 else np.zeros(0, dtype=np.float32)
        enough = self.voiced_hops >= self.min_speech_hops
        self.in_speech = False
        self.buf = []
        self.voiced_hops = self.silent_hops = self.since_partial = 0
        return Cut("final", self.utterance, audio) if enough else None


def clean(text: str) -> str:
    text = " ".join(text.split())
    return text if any(ch.isalnum() for ch in text) else ""


class SttSession:
    """One /stt WebSocket. Transcription runs in a worker thread so the read loop never blocks on the model.

    While the model is busy, only the newest partial is kept: an older one would be stale by the time it ran.
    Partials of an utterance that already has its final are dropped.
    """

    def __init__(
        self,
        transcribe: Transcribe,
        locale: str,
        send: Callable[[dict], Awaitable[None]],
        cfg: VadConfig = DEFAULT_VAD,
    ) -> None:
        self.transcribe, self.locale, self.send = transcribe, locale, send
        self.segmenter = Segmenter(cfg)
        self.jobs: deque[Cut | None] = deque()
        self.wake = asyncio.Event()
        self.finalized = 0
        self.last_partial = ""
        self.worker = asyncio.create_task(self._work())

    async def feed(self, frame: bytes) -> None:
        for cut in self.segmenter.feed(pcm16_to_float(frame)):
            self._enqueue(cut)

    async def finish(self) -> None:
        """The client is done sending: transcribe what's left, then stop."""
        if (cut := self.segmenter.flush()) is not None:
            self._enqueue(cut)
        self.jobs.append(None)
        self.wake.set()
        await self.worker

    async def cancel(self) -> None:
        self.worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.worker

    def _enqueue(self, cut: Cut) -> None:
        # A newer cut (partial or final) makes every queued partial up to its utterance stale.
        for j in [j for j in self.jobs if j is not None and j.kind == "partial" and j.utterance <= cut.utterance]:
            self.jobs.remove(j)
        self.jobs.append(cut)
        self.wake.set()

    async def _work(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            while self.jobs:
                cut = self.jobs.popleft()
                if cut is None:
                    return
                if cut.kind == "partial" and cut.utterance <= self.finalized:
                    continue
                start = time.perf_counter()
                try:
                    text = clean(await asyncio.to_thread(self.transcribe, cut.audio, self.locale))
                except Exception:
                    log.exception("transcription failed")
                    text = ""
                ms = round((time.perf_counter() - start) * 1000)
                audio_s = len(cut.audio) / self.segmenter.cfg.sample_rate
                log.info("stt %s utt=%d audio=%.1fs ms=%d", cut.kind, cut.utterance, audio_s, ms)
                if cut.kind == "final":
                    self.finalized = cut.utterance
                    self.last_partial = ""
                elif cut.utterance <= self.finalized or text == self.last_partial:
                    continue
                else:
                    self.last_partial = text
                if text:
                    try:
                        await self.send({"kind": cut.kind, "text": text})
                    except Exception:  # noqa: BLE001  (the gateway hung up; nothing left to do)
                        return
