"""Mock model service: same endpoints as services/models, canned responses, configurable delays.

Run: uv run uvicorn mock_models:app --host 127.0.0.1 --port 8000
Delays (ms) via env: MOCK_SUGGEST_MS (default 600), MOCK_TTS_MS (default 900).
"""

import asyncio
import io
import itertools
import math
import os
import struct
import wave
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile, WebSocket, WebSocketDisconnect

SUGGEST_MS = int(os.getenv("MOCK_SUGGEST_MS", "600"))
TTS_MS = int(os.getenv("MOCK_TTS_MS", "900"))

CANNED = [
    [
        {"text": "Better than yesterday, thanks.", "kind": "statement"},
        {"text": "A little tired.", "kind": "statement"},
        {"text": "Is the doctor coming today?", "kind": "question"},
    ],
    [
        {"text": "Yes, please.", "kind": "yes_no"},
        {"text": "Not right now.", "kind": "yes_no"},
        {"text": "Can you ask me later?", "kind": "question"},
    ],
]
_canned = itertools.cycle(CANNED)
_voices = itertools.count(1)

app = FastAPI(title="Cadence mock models")


def beep_wav(text: str) -> bytes:
    """A short tone whose length scales with the text, so playback timing feels real."""
    rate, seconds = 16000, min(0.3 + 0.05 * len(text), 4.0)
    frames = b"".join(
        struct.pack("<h", int(4000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(int(rate * seconds))
    )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


@app.get("/health")
def health() -> dict[str, str]:
    return {"stt": "ready", "suggest": "ready", "tts": "ready", "backend": "mock"}


@app.websocket("/stt")
async def stt(ws: WebSocket) -> None:
    """Emits a scripted question after every ~2 s of audio frames."""
    await ws.accept()
    words = "How are you feeling today?".split()
    frames = 0
    while True:
        try:
            await ws.receive_bytes()
        except WebSocketDisconnect:
            return
        frames += 1
        step = frames % 100  # 100 frames of 20 ms = 2 s per scripted utterance
        if step == 0:
            await ws.send_json({"kind": "final", "text": " ".join(words)})
        elif step % 20 == 0:
            await ws.send_json({"kind": "partial", "text": " ".join(words[: step // 20])})


@app.post("/suggest")
async def suggest(req: dict[str, Any]) -> dict[str, Any]:
    await asyncio.sleep(SUGGEST_MS / 1000)
    return {"turnId": req.get("turnId", ""), "items": next(_canned)[: req.get("n", 3)], "ms": SUGGEST_MS}


@app.post("/tts")
async def tts(req: dict[str, Any]) -> Response:
    await asyncio.sleep(TTS_MS / 1000)
    return Response(content=beep_wav(req.get("text", "")), media_type="audio/wav", headers={"X-Gen-Ms": str(TTS_MS)})


@app.post("/voices")
async def create_voice(
    audio: Annotated[UploadFile, File()],
    consentId: Annotated[str, Form()] = "",
    transcript: Annotated[str | None, Form()] = None,  # optional (§6.2): the real service transcribes the sample
    locale: Annotated[str, Form()] = "en",
) -> dict[str, str]:
    if not consentId:
        raise HTTPException(status_code=400, detail="consentId is required")
    return {"voiceId": f"mock_voice_{next(_voices)}"}


@app.delete("/voices/{voice_id}", status_code=204)
def delete_voice(voice_id: str) -> Response:
    return Response(status_code=204)


@app.post("/summarize")
async def summarize(req: dict[str, Any]) -> dict[str, Any]:
    return {"summary": "Mock summary: the doctor asked how they were feeling.", "ms": 0}
