import http.client
import json
import urllib.request

import pytest

from app.backends.ollama import OllamaError, OllamaSuggest, post_json
from app.schemas import ContextItem, Style, Turn

REPLIES = [
    {"text": "Yes, I slept well.", "kind": "yes_no"},
    {"text": "A bit tired today.", "kind": "statement"},
    {"text": "Did you sleep well?", "kind": "question"},
]


class FakeOllama:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.bodies = []

    def __call__(self, url, body, timeout):
        self.bodies.append((url, body))
        answer = self.answers.pop(0) if self.answers else json.dumps(REPLIES)
        if isinstance(answer, Exception):
            raise answer
        return {"message": {"content": answer}}


def suggest(backend: OllamaSuggest, **kw):
    args = {
        "history": [Turn(speaker="other", text="Did you sleep well?")],
        "style": Style(tone="dry humor", phrases=["no worries"]),
        "context": [ContextItem(label="Dr. Lee", summary="New medication.")],
        "memories": ["The nurse comes at 3 pm."],
        "locale": "en",
        "n": 3,
    }
    return backend.suggest(**(args | kw))


def test_request_asks_for_schema_constrained_json_without_thinking():
    fake = FakeOllama()
    items = suggest(OllamaSuggest("gemma4:e4b", "http://127.0.0.1:11434/", post=fake))
    assert [i.kind for i in items] == ["yes_no", "statement", "question"]
    url, body = fake.bodies[0]
    assert url == "http://127.0.0.1:11434/api/chat"
    assert body["model"] == "gemma4:e4b" and body["stream"] is False and body["think"] is False
    assert body["keep_alive"] == -1
    assert body["format"]["minItems"] == 3 and body["format"]["maxItems"] == 3


def test_prompt_includes_history_style_context_memories_and_language():
    fake = FakeOllama()
    suggest(OllamaSuggest("m", "http://x", post=fake), locale="es-MX")
    prompt = fake.bodies[0][1]["messages"][0]["content"]
    expected = [
        "other: Did you sleep well?",
        "dry humor",
        "- no worries",
        "Dr. Lee: New medication.",
        "3 pm",
        "Spanish",
    ]
    for part in expected:
        assert part in prompt


def test_prompt_singles_out_the_last_line_so_a_topic_change_is_followed():
    fake = FakeOllama()
    s = OllamaSuggest("m", "http://x", post=fake)
    history = [Turn(speaker="other", text="Soup or salad?"), Turn(speaker="other", text="How's your pain?")]
    s.suggest(history, Style(phrases=[]), [], [], "en", 3)
    prompt = fake.bodies[0][1]["messages"][0]["content"]
    assert "every reply must respond to:\nother: How's your pain?" in prompt


def test_bad_output_is_retried_once():
    fake = FakeOllama("Sure! Here you go", json.dumps(REPLIES))
    assert len(suggest(OllamaSuggest("m", "http://x", post=fake))) == 3
    assert len(fake.bodies) == 2


def test_bad_output_twice_raises():
    fake = FakeOllama("nope", "[]")
    with pytest.raises(ValueError):
        suggest(OllamaSuggest("m", "http://x", post=fake))


def test_think_flag_is_dropped_if_the_server_rejects_it():
    fake = FakeOllama(OllamaError('400 {"error":"\\"m\\" does not support thinking"}'))
    backend = OllamaSuggest("m", "http://x", post=fake)
    suggest(backend)
    assert "think" in fake.bodies[0][1] and "think" not in fake.bodies[1][1]
    suggest(backend)
    assert "think" not in fake.bodies[2][1]


def test_other_errors_propagate():
    fake = FakeOllama(OllamaError("Ollama not reachable at http://x"))
    with pytest.raises(OllamaError):
        suggest(OllamaSuggest("m", "http://x", post=fake))


def test_summarize_is_plain_text_in_the_locale_language():
    fake = FakeOllama("  Dr. Lee wants a follow-up in two weeks.  ")
    turns = [Turn(speaker="other", text="See you in two weeks")]
    out = OllamaSuggest("m", "http://x", post=fake).summarize(turns, "fr")
    assert out == "Dr. Lee wants a follow-up in two weeks."
    body = fake.bodies[0][1]
    assert "format" not in body and "French" in body["messages"][0]["content"]


@pytest.mark.parametrize("dropped", [http.client.RemoteDisconnected("closed"), ConnectionResetError("reset")])
def test_a_connection_dropped_mid_response_is_an_ollama_error(monkeypatch, dropped):
    def urlopen(*args, **kwargs):
        raise dropped

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    with pytest.raises(OllamaError):
        post_json("http://127.0.0.1:11434/api/chat", {}, 1.0)
