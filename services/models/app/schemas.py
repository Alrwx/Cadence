"""Request/response types for §6.2. services/gateway/internal/models/client.go mirrors these by hand."""

from typing import Literal

from pydantic import BaseModel, Field

Status = Literal["ready", "loading", "error"]
ReplyKind = Literal["statement", "question", "yes_no"]


class Health(BaseModel):
    stt: Status
    suggest: Status
    tts: Status
    backend: str


class Turn(BaseModel):
    speaker: Literal["other", "user"]
    text: str


class Style(BaseModel):
    phrases: list[str] = []
    tone: str = ""


class ContextItem(BaseModel):
    """A saved conversation attached as context (stretch)."""

    label: str
    summary: str


class SuggestRequest(BaseModel):
    turnId: str
    history: list[Turn]
    style: Style = Style()
    context: list[ContextItem] = []
    memories: list[str] = []
    locale: str = "en"
    n: int = Field(default=3, ge=1, le=5)


class Reply(BaseModel):
    text: str
    kind: ReplyKind


class SuggestResponse(BaseModel):
    turnId: str
    items: list[Reply]
    ms: int


class TtsRequest(BaseModel):
    voiceId: str
    text: str = Field(min_length=1, max_length=400)
    locale: str = "en"


class VoiceCreated(BaseModel):
    voiceId: str


class SummarizeRequest(BaseModel):
    turns: list[Turn]
    locale: str = "en"


class SummarizeResponse(BaseModel):
    summary: str
    ms: int
