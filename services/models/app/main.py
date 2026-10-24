"""Model service: STT, suggestions, TTS. Binds to 127.0.0.1 only; the gateway decides when to call it."""

import logging
import time
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from app.backends.mlx import MlxStt, MlxSuggest, MlxTts
from app.config import settings
from app.schemas import (
    Health,
    SuggestRequest,
    SuggestResponse,
    SummarizeRequest,
    SummarizeResponse,
    TtsRequest,
    VoiceCreated,
)

log = logging.getLogger("models")

app = FastAPI(title="Cadence model service")

# Heavy model loading happens once, here at startup.
stt = MlxStt(settings.stt_model)
suggester = MlxSuggest(settings.suggest_model)
tts = MlxTts(settings.tts_model)


@app.exception_handler(NotImplementedError)
async def not_implemented(_: Request, exc: NotImplementedError) -> JSONResponse:
    return JSONResponse(status_code=501, content={"detail": f"not implemented yet: {exc}"})


@app.get("/health")
def health() -> Health:
    # TODO(Dev 3): report "loading" until each model is warm, "error" if loading failed.
    return Health(stt="loading", suggest="loading", tts="loading", backend=settings.backend)


@app.websocket("/stt")
async def stream_stt(ws: WebSocket) -> None:
    await ws.accept()

    async def frames() -> AsyncIterator[bytes]:
        while True:
            yield await ws.receive_bytes()

    try:
        async for kind, text in stt.transcribe(frames()):
            await ws.send_json({"kind": kind, "text": text})
    except WebSocketDisconnect:
        return
    except NotImplementedError as e:
        await ws.close(code=1011, reason=f"not implemented yet: {e}")


@app.post("/suggest")
def suggest(req: SuggestRequest) -> SuggestResponse:
    start = time.perf_counter()
    items = suggester.suggest(req.history, req.style, req.context, req.n)
    ms = round((time.perf_counter() - start) * 1000)
    log.info("suggest turn=%s ms=%d", req.turnId, ms)
    return SuggestResponse(turnId=req.turnId, items=items, ms=ms)


@app.post("/tts", response_class=Response, responses={200: {"content": {"audio/wav": {}}}})
def synthesize(req: TtsRequest) -> Response:
    start = time.perf_counter()
    wav = tts.synthesize(req.voiceId, req.text)
    ms = round((time.perf_counter() - start) * 1000)
    log.info("tts voice=%s chars=%d ms=%d", req.voiceId, len(req.text), ms)
    return Response(content=wav, media_type="audio/wav", headers={"X-Gen-Ms": str(ms)})


@app.post("/voices")
async def create_voice(
    audio: Annotated[UploadFile, File()],
    transcript: Annotated[str, Form()],
    consentId: Annotated[str, Form()],
) -> VoiceCreated:
    if not consentId:
        raise HTTPException(status_code=400, detail="consentId is required")
    # TODO(Dev 3): after cloning, pre-synthesize the instant phrases for this voice.
    return VoiceCreated(voiceId=tts.create_voice(await audio.read(), transcript))


@app.delete("/voices/{voice_id}", status_code=204)
def delete_voice(voice_id: str) -> Response:
    tts.delete_voice(voice_id)
    return Response(status_code=204)


@app.post("/summarize")
def summarize(req: SummarizeRequest) -> SummarizeResponse:
    """Stretch: summary of a saved conversation, used as context for later suggestions."""
    start = time.perf_counter()
    summary = suggester.summarize(req.turns)
    return SummarizeResponse(summary=summary, ms=round((time.perf_counter() - start) * 1000))
