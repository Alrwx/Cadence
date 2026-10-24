from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert set(body) == {"stt", "suggest", "tts", "backend"}


def test_unimplemented_backends_return_501():
    resp = client.post("/suggest", json={"turnId": "t_1", "history": [{"speaker": "other", "text": "Hi"}]})
    assert resp.status_code == 501
    assert client.post("/tts", json={"voiceId": "v", "text": "Yes"}).status_code == 501
