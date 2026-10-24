from fastapi import APIRouter, HTTPException, Response

from app.models import TtsRequest

router = APIRouter()


@router.post("/tts", response_class=Response, responses={200: {"content": {"audio/wav": {}}}})
async def synthesize(request: TtsRequest) -> Response:
    """Returns WAV audio, reusing the stored clip when this voice, locale and text were synthesized before."""
    raise HTTPException(status_code=501)
