import io
import json
import time
import wave

import pytest
from fastapi.testclient import TestClient

from app.backends.ollama import OllamaError
from app.main import create_app
from tests.conftest import sample_wav, silence, speech_like


def wait_ready(client: TestClient, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get("/health").json()
        if all(body[k] == "ready" for k in ("stt", "suggest", "tts")):
            return body
        time.sleep(0.02)
    raise AssertionError(f"not ready: {body}")


@pytest.fixture
def client(models):
    with TestClient(create_app(models)) as c:
        wait_ready(c)
        yield c


def test_health_reports_loading_until_models_load(models):
    client = TestClient(create_app(models, load=False))
    body = client.get("/health").json()
    assert body == {
        "stt": "loading",
        "suggest": "loading",
        "tts": "loading",
        "backend": body["backend"],
        "defaultVoice": "",
    }
    resp = client.post("/tts", json={"voiceId": "default", "text": "Yes"})
    assert resp.status_code == 503
    assert "tts is loading" in resp.json()["detail"]


def test_load_failure_is_reported_as_error(models):
    def broken():
        raise RuntimeError("no GPU")

    models.stt.load = broken
    with TestClient(create_app(models)) as client:
        deadline = time.monotonic() + 5
        while client.get("/health").json()["stt"] != "error" and time.monotonic() < deadline:
            time.sleep(0.02)
        assert client.get("/health").json()["stt"] == "error"
        resp = client.post("/voices", files={"audio": ("a.wav", sample_wav())}, data={"consentId": "c1"})
        assert resp.status_code == 503
        assert "no GPU" in resp.json()["detail"]


def test_tts_default_voice_returns_wav(client):
    resp = client.post("/tts", json={"voiceId": "default", "text": "Yes, please.", "locale": "en"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert int(resp.headers["x-gen-ms"]) >= 0
    with wave.open(io.BytesIO(resp.content)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (24000, 1, 2)


def test_tts_unknown_voice_is_404(client):
    assert client.post("/tts", json={"voiceId": "v_000000000000", "text": "Yes"}).status_code == 404
    assert client.post("/tts", json={"voiceId": "../etc", "text": "Yes"}).status_code == 404


def test_tts_rejects_empty_or_blank_text(client):
    assert client.post("/tts", json={"voiceId": "default", "text": ""}).status_code == 422
    assert client.post("/tts", json={"voiceId": "default", "text": "  \n "}).status_code == 422


def test_tts_speaks_a_long_typed_message(client):
    text = " ".join(["I typed this whole sentence on the board."] * 25)
    assert client.post("/tts", json={"voiceId": "default", "text": text}).status_code == 200


def test_voice_without_transcript_is_transcribed(client, models, tmp_path):
    resp = client.post("/voices", files={"audio": ("sample.wav", sample_wav(), "audio/wav")}, data={"consentId": "c1"})
    assert resp.status_code == 200, resp.text
    voice_id = resp.json()["voiceId"]
    assert voice_id.startswith("v_")
    assert len(models.stt.calls) == 1  # the sample, at 16 kHz
    assert models.tts.engine.prompts[-1] == "hello there"
    assert (tmp_path / "voices" / voice_id / "ref.wav").exists()

    assert client.post("/tts", json={"voiceId": voice_id, "text": "Hi"}).status_code == 200
    assert client.delete(f"/voices/{voice_id}").status_code == 204
    assert not (tmp_path / "voices" / voice_id).exists()
    assert client.post("/tts", json={"voiceId": voice_id, "text": "Hi"}).status_code == 404


def test_voice_is_transcribed_in_the_language_of_the_clip(client, models, tmp_path):
    data = {"consentId": "c1", "locale": "es"}
    resp = client.post("/voices", files={"audio": ("s.wav", sample_wav(), "audio/wav")}, data=data)
    assert resp.status_code == 200, resp.text
    assert [locale for _, locale in models.stt.calls] == ["es"]
    meta = json.loads((tmp_path / "voices" / resp.json()["voiceId"] / "meta.json").read_text("utf-8"))
    assert meta["locale"] == "es"


def test_voice_with_transcript_skips_stt(client, models):
    data = {"consentId": "c1", "transcript": "This is what my voice sounds like."}
    resp = client.post("/voices", files={"audio": ("s.wav", sample_wav())}, data=data)
    assert resp.status_code == 200
    assert models.stt.calls == []
    assert models.tts.engine.prompts[-1] == "This is what my voice sounds like."


@pytest.mark.parametrize(
    ("audio", "data", "detail"),
    [
        (sample_wav(), {}, "consentId"),
        (b"not audio at all", {"consentId": "c1"}, "decode"),
        (sample_wav(seconds=1.0), {"consentId": "c1"}, "at least 3 seconds"),
    ],
)
def test_bad_voice_uploads_are_400(client, audio, data, detail):
    resp = client.post("/voices", files={"audio": ("s.wav", audio)}, data=data)
    assert resp.status_code == 400
    assert detail in resp.json()["detail"]


def test_voice_with_no_words_heard_is_400(client, models):
    models.stt.text = ""
    resp = client.post("/voices", files={"audio": ("s.wav", sample_wav())}, data={"consentId": "c1"})
    assert resp.status_code == 400
    assert "couldn't hear any words" in resp.json()["detail"]


def test_default_voice_cant_be_deleted(client):
    assert client.delete("/voices/default").status_code == 204
    assert client.post("/tts", json={"voiceId": "default", "text": "Yes"}).status_code == 200


def test_suggest_passes_memories_and_locale(client, models):
    body = {
        "turnId": "t_3",
        "history": [{"speaker": "other", "text": "Did you sleep well?"}],
        "memories": ["The nurse comes at 3 pm."],
        "locale": "es",
    }
    resp = client.post("/suggest", json=body)
    assert resp.status_code == 200
    out = resp.json()
    assert out["turnId"] == "t_3" and len(out["items"]) == 3 and out["ms"] >= 0
    assert models.suggest.calls[-1]["memories"] == ["The nurse comes at 3 pm."]
    assert models.suggest.calls[-1]["locale"] == "es"


def test_suggest_backend_failure_is_502(client, models):
    def down(*_):
        raise OllamaError("Ollama not reachable")

    models.suggest.suggest = down
    resp = client.post("/suggest", json={"turnId": "t_1", "history": []})
    assert resp.status_code == 502


def test_summarize(client):
    resp = client.post("/summarize", json={"turns": [{"speaker": "other", "text": "Hi"}]})
    assert resp.json()["summary"] == "1 turns"


def test_stt_streams_partials_and_a_final(client, models):
    audio = __import__("numpy").concatenate([silence(0.5), speech_like(2.0), silence(1.0)])
    pcm = (audio * 32767).astype("<i2").tobytes()
    events = []
    with client.websocket_connect("/stt?locale=en") as ws:
        for i in range(0, len(pcm), 640):  # 20 ms frames, like the phone
            ws.send_bytes(pcm[i : i + 640])
        ws.send_text("end")
        while True:
            try:
                events.append(ws.receive_json())
            except Exception:  # noqa: BLE001  (server closed after "end")
                break
    kinds = [e["kind"] for e in events]
    assert kinds[-1] == "final" and kinds.count("final") == 1
    assert events[-1]["text"] == "hello there"
    assert all(locale == "en" for _, locale in models.stt.calls)


def test_stt_refuses_while_loading(models):
    client = TestClient(create_app(models, load=False))
    with client.websocket_connect("/stt") as ws:
        with pytest.raises(Exception):  # noqa: B017
            ws.receive_json()
