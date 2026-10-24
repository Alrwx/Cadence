from fastapi import FastAPI

from app.routes import tts, voice

app = FastAPI(title="Cadence")
app.include_router(voice.router)
app.include_router(tts.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
