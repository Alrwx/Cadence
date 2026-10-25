"""Voices and synthesis on top of a TtsEngine (backends/base.py).

- Voices persist under DATA_DIR/voices/<voiceId>/ (reference clip + transcript), so a voiceId the gateway stored
  still works after this service restarts. The voice prompt itself is cached in memory and rebuilt on first use.
- "default" is the built-in generic voice (assets/, see scripts/make_default_voice.py). It can't be deleted.
- One worker thread owns the model. /tts requests for the same voice and language that arrive within a few ms of
  each other are synthesized as one batch: the gateway asks for all 3 suggestions at once, and on the 3080 a batch
  of 3 takes about as long as one reply (docs/latency.md).
"""

import json
import logging
import queue
import re
import shutil
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from app.audio import BadAudio, decode, prepare_reference, read_wav, resample, speech_seconds, to_wav
from app.backends.base import TtsEngine
from app.locale import language_name

log = logging.getLogger("models.tts")

DEFAULT_VOICE = "default"
MIN_SPEECH_S = 3.0  # less than this and the clone sounds like no one in particular
MAX_REFERENCE_S = 15.0
MAX_TRANSCRIBED_S = 28.0  # Whisper sees 30 s at a time
# Long text is spoken as chunks about one reply long, so no generation runs longer than a batch of suggestions.
MAX_CHUNK_CHARS = 120


class UnknownVoice(KeyError):
    pass


@dataclass
class _Synth:
    voice_id: str
    language: str
    text: str
    future: Future = field(default_factory=Future)


@dataclass
class _Call:
    fn: Callable[[], Any]
    future: Future = field(default_factory=Future)


def max_tokens(texts: list[str]) -> int:
    """Codec-token cap: 12 tokens per second of audio, ~6 characters per second at a slow pace, plus 3 s.

    Sampling occasionally fails to stop; this bounds a runaway generation to a few seconds over the expected length.
    """
    return int(12 * (3 + max(len(t) for t in texts) / 6))


def split_text(text: str) -> list[str]:
    """Splits text at sentence ends (then at spaces) into chunks of at most MAX_CHUNK_CHARS, packing short ones."""
    pieces = []
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        line = ""
        for word in sentence.split():
            if line and len(line) + 1 + len(word) > MAX_CHUNK_CHARS:
                pieces.append(line)
                line = word
            else:
                line = f"{line} {word}" if line else word
        if line:
            pieces.append(line)
    chunks: list[str] = []
    for piece in pieces:
        if chunks and len(chunks[-1]) + 1 + len(piece) <= MAX_CHUNK_CHARS:
            chunks[-1] += " " + piece
        else:
            chunks.append(piece)
    return chunks


class TtsService:
    def __init__(
        self,
        engine: TtsEngine,
        voices_dir: Path,
        default_audio: Path,
        default_text: Path,
        max_batch: int = 4,
        batch_window_ms: int = 30,
    ) -> None:
        self.engine = engine
        self.voices_dir = voices_dir
        self.default_audio, self.default_text = default_audio, default_text
        self.max_batch, self.batch_window = max_batch, batch_window_ms / 1000
        self.prompts: dict[str, Any] = {}
        self.jobs: queue.Queue[_Synth | _Call] = queue.Queue()
        self.held: list[_Synth | _Call] = []  # taken off the queue but not part of the current batch
        self.worker = threading.Thread(target=self._work, name="tts", daemon=True)
        self.worker.start()

    # --- public API (called from request threads) ---

    def load(self) -> None:
        """Load the model on the worker thread, then build the default voice and run one generation, so the first
        real request isn't the slow one."""
        self._call(self.engine.load)
        self.synthesize(DEFAULT_VOICE, "Okay.", "en")

    def create_voice(
        self,
        data: bytes,
        transcript: str | None,
        consent_id: str,
        locale: str,
        transcribe: Callable[[np.ndarray, str], str],
    ) -> str:
        sr = self.engine.sample_rate
        audio = decode(data, sr)
        if speech_seconds(audio, sr) < MIN_SPEECH_S:
            raise BadAudio(f"the sample needs at least {MIN_SPEECH_S:.0f} seconds of speech")
        if transcript and transcript.strip():
            # A given transcript has to match the clip word for word, so don't cut it (beyond silence).
            ref = prepare_reference(audio, sr, max_seconds=MAX_TRANSCRIBED_S)
            text = transcript.strip()
        else:
            ref = prepare_reference(audio, sr, max_seconds=MAX_REFERENCE_S)
            text = transcribe(resample(ref, sr, 16000), locale).strip()
            if not text:
                raise BadAudio("couldn't hear any words in the sample")

        voice_id = f"v_{uuid.uuid4().hex[:12]}"
        prompt = self._call(lambda: self.engine.make_prompt(ref, text))
        folder = self.voices_dir / voice_id
        folder.mkdir(parents=True)
        (folder / "ref.wav").write_bytes(to_wav(ref, sr))
        meta = {"transcript": text, "consentId": consent_id, "locale": locale, "createdAt": time.time()}
        (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        self.prompts[voice_id] = prompt
        log.info("voice created id=%s ref=%.1fs transcribed=%s", voice_id, len(ref) / sr, not transcript)
        return voice_id

    def delete_voice(self, voice_id: str) -> None:
        if voice_id == DEFAULT_VOICE or not _safe_id(voice_id):
            return
        self.prompts.pop(voice_id, None)
        shutil.rmtree(self.voices_dir / voice_id, ignore_errors=True)

    def synthesize(self, voice_id: str, text: str, locale: str) -> bytes:
        if voice_id != DEFAULT_VOICE and not (_safe_id(voice_id) and (self.voices_dir / voice_id).is_dir()):
            raise UnknownVoice(voice_id)
        language = language_name(locale)
        jobs = [_Synth(voice_id, language, chunk) for chunk in split_text(text)]
        for job in jobs:
            self.jobs.put(job)
        return to_wav(np.concatenate([job.future.result() for job in jobs]), self.engine.sample_rate)

    # --- worker thread ---

    def _call(self, fn: Callable[[], Any]) -> Any:
        job = _Call(fn)
        self.jobs.put(job)
        return job.future.result()

    def _work(self) -> None:
        while True:
            job = self.held.pop(0) if self.held else self.jobs.get()
            if isinstance(job, _Call):
                _run(job.future, job.fn)
                continue
            batch = [job]
            for other in [h for h in self.held if _same(job, h)][: self.max_batch - 1]:
                self.held.remove(other)
                batch.append(other)
            deadline = time.monotonic() + self.batch_window
            while len(batch) < self.max_batch:
                try:
                    nxt = self.jobs.get(timeout=max(0.0, deadline - time.monotonic()))
                except queue.Empty:
                    break
                (batch if _same(job, nxt) else self.held).append(nxt)
            self._synthesize_batch(batch)

    def _synthesize_batch(self, batch: list[_Synth]) -> None:
        first = batch[0]
        try:
            prompt = self._prompt(first.voice_id)
            texts = [j.text for j in batch]
            start = time.perf_counter()
            wavs = self.engine.generate(prompt, texts, first.language, max_tokens(texts))
            if len(wavs) != len(batch):
                raise RuntimeError(f"the TTS engine returned {len(wavs)} clips for {len(batch)} texts")
            ms = round((time.perf_counter() - start) * 1000)
            log.info("tts voice=%s batch=%d ms=%d", first.voice_id, len(batch), ms)
        except Exception as e:  # noqa: BLE001  (every waiting request gets the error)
            for j in batch:
                j.future.set_exception(e)
            return
        for j, wav in zip(batch, wavs, strict=True):
            j.future.set_result(wav)

    def _prompt(self, voice_id: str) -> Any:
        if voice_id not in self.prompts:
            if voice_id == DEFAULT_VOICE:
                audio, text = self.default_audio, self.default_text.read_text(encoding="utf-8").strip()
            else:
                folder = self.voices_dir / voice_id
                audio, text = folder / "ref.wav", json.loads((folder / "meta.json").read_text("utf-8"))["transcript"]
            ref, sr = read_wav(str(audio))
            self.prompts[voice_id] = self.engine.make_prompt(resample(ref, sr, self.engine.sample_rate), text)
        return self.prompts[voice_id]


def _same(job: _Synth, other: _Synth | _Call) -> bool:
    return isinstance(other, _Synth) and (other.voice_id, other.language) == (job.voice_id, job.language)


def _run(future: Future, fn: Callable[[], Any]) -> None:
    try:
        future.set_result(fn())
    except Exception as e:  # noqa: BLE001
        future.set_exception(e)


def _safe_id(voice_id: str) -> bool:
    return voice_id.startswith("v_") and voice_id[2:].isalnum()
