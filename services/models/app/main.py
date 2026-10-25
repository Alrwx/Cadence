"""Model service: STT, suggestions, TTS. Binds to 127.0.0.1 only; the gateway decides when to call it."""

import logging
import threading
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile, WebSocket, WebSocketDisconnect

from app.audio import BadAudio
from app.backends import Models, build
from app.backends.ollama import OllamaError
from app.config import settings
from app.schemas import (
    Health,
    Status,
    SuggestRequest,
    SuggestResponse,
    SummarizeRequest,
    SummarizeResponse,
    TtsRequest,
    VoiceCreated,
)
from app.stt_stream import SttSession
from app.tts import UnknownVoice

log = logging.getLogger("models")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # same limit as the gateway's POST /api/voices
SUGGEST_RETRY_S = 10.0  # Ollama may start after this service; keep trying until it answers


class Readiness:
    """What /health reports. Each model loads in the background, so the service answers (with 503s) right away."""

    def __init__(self) -> None:
        self.status: dict[str, Status] = {"stt": "loading", "suggest": "loading", "tts": "loading"}
        self.errors: dict[str, str] = {}

    def load(self, name: str, fn: Callable[[], None]) -> bool:
        start = time.perf_counter()
        try:
            fn()
        except OllamaError as e:  # expected while Ollama is starting; retried, so one line per new error
            if self.errors.get(name) != str(e):
                log.warning("%s not ready, retrying every %.0f s: %s", name, SUGGEST_RETRY_S, e)
            self.status[name], self.errors[name] = "error", str(e)
            return False
        except Exception as e:  # noqa: BLE001  (any load failure is reported, never raised)
            log.exception("%s failed to load", name)
            self.status[name], self.errors[name] = "error", f"{type(e).__name__}: {e}"
            return False
        self.status[name] = "ready"
        self.errors.pop(name, None)
        log.info("%s ready in %.1f s", name, time.perf_counter() - start)
        return True

    def require(self, name: str) -> None:
        if self.status[name] != "ready":
            detail = f"{name} is {self.status[name]}" + (f": {self.errors[name]}" if name in self.errors else "")
            raise HTTPException(status_code=503, detail=detail)


def load_all(models: Models, ready: Readiness) -> None:
    def gpu() -> None:  # TTS first: the demo opens with a cloned voice
        ready.load("tts", models.tts.load)
        ready.load("stt", models.stt.load)

    def suggest() -> None:
        while not ready.load("suggest", models.suggest.load):
            time.sleep(SUGGEST_RETRY_S)

    threading.Thread(target=gpu, name="load-gpu", daemon=True).start()
    threading.Thread(target=suggest, name="load-suggest", daemon=True).start()


def create_app(models: Models, load: bool = True) -> FastAPI:
    ready = Readiness()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if load:
            load_all(models, ready)
        yield

    app = FastAPI(title="Cadence model service", lifespan=lifespan)
    app.state.models, app.state.ready = models, ready

    @app.get("/health")
    def health() -> Health:
        return Health(**ready.status, backend=settings.backend)

    @app.websocket("/stt")
    async def stream_stt(ws: WebSocket, locale: str = "en") -> None:
        await ws.accept()
        if ready.status["stt"] != "ready":
            await ws.close(code=1013, reason=f"stt is {ready.status['stt']}")  # 1013 = try again later
            return
        session = SttSession(models.stt.transcribe, locale, ws.send_json)
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes"):
                    await session.feed(msg["bytes"])
                elif msg.get("text") == "end":  # optional: flush the last utterance, then close
                    await session.finish()
                    await ws.close()
                    return
        except WebSocketDisconnect:
            pass
        await session.cancel()

    @app.post("/suggest")
    def suggest(req: SuggestRequest) -> SuggestResponse:
        ready.require("suggest")
        start = time.perf_counter()
        try:
            items = models.suggest.suggest(req.history, req.style, req.context, req.memories, req.locale, req.n)
        except (OllamaError, ValueError) as e:
            raise HTTPException(status_code=502, detail=f"suggest failed: {e}") from e
        ms = round((time.perf_counter() - start) * 1000)
        log.info("suggest turn=%s ms=%d", req.turnId, ms)
        return SuggestResponse(turnId=req.turnId, items=items, ms=ms)

    @app.post("/tts", response_class=Response, responses={200: {"content": {"audio/wav": {}}}})
    def synthesize(req: TtsRequest) -> Response:
        ready.require("tts")
        start = time.perf_counter()
        try:
            wav = models.tts.synthesize(req.voiceId, req.text.strip(), req.locale)
        except UnknownVoice as e:
            raise HTTPException(status_code=404, detail=f"unknown voiceId {req.voiceId}") from e
        ms = round((time.perf_counter() - start) * 1000)
        log.info("tts voice=%s chars=%d ms=%d", req.voiceId, len(req.text), ms)
        return Response(content=wav, media_type="audio/wav", headers={"X-Gen-Ms": str(ms)})

    @app.post("/voices")
    def create_voice(
        audio: Annotated[UploadFile, File()],
        consentId: Annotated[str, Form()] = "",
        transcript: Annotated[str | None, Form()] = None,
        locale: Annotated[str, Form()] = "en",
    ) -> VoiceCreated:
        if not consentId.strip():
            raise HTTPException(status_code=400, detail="consentId is required")
        ready.require("tts")
        if not (transcript and transcript.strip()):
            ready.require("stt")  # we transcribe the sample ourselves (§6.2)
        data = audio.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="sample is larger than 25 MB")
        start = time.perf_counter()
        try:
            voice_id = models.tts.create_voice(data, transcript, consentId, locale, models.stt.transcribe)
        except BadAudio as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        log.info("voices id=%s bytes=%d ms=%d", voice_id, len(data), round((time.perf_counter() - start) * 1000))
        return VoiceCreated(voiceId=voice_id)

    @app.delete("/voices/{voice_id}", status_code=204)
    def delete_voice(voice_id: str) -> Response:
        models.tts.delete_voice(voice_id)
        return Response(status_code=204)

    @app.post("/summarize")
    def summarize(req: SummarizeRequest) -> SummarizeResponse:
        """Stretch: summary of a saved conversation or quick memory, used as context for later suggestions."""
        ready.require("suggest")
        start = time.perf_counter()
        try:
            summary = models.suggest.summarize(req.turns, req.locale)
        except OllamaError as e:
            raise HTTPException(status_code=502, detail=f"summarize failed: {e}") from e
        return SummarizeResponse(summary=summary, ms=round((time.perf_counter() - start) * 1000))

    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
app = create_app(build(settings))
