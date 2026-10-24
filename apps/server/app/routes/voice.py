from fastapi import APIRouter, HTTPException, UploadFile

from app.models import VoiceProfile

router = APIRouter()


@router.post("/voice-profiles", status_code=202)
async def create_voice_profile(video: UploadFile) -> VoiceProfile:
    """Starts the one-time clone; the phone watches voice_profiles.status in Supabase for completion."""
    raise HTTPException(status_code=501)
