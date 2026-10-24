"""Request/response types; ServerClient.swift mirrors these by hand."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class VoiceProfile(BaseModel):
    id: UUID
    status: Literal["pending", "ready", "failed"]


class TtsRequest(BaseModel):
    text: str
    locale: str
    voice_profile_id: UUID
