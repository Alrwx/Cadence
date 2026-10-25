"""Suggestions and summaries from Gemma 4 served by a local Ollama (127.0.0.1 only; nothing leaves the machine).

The same backend runs on both machines: Ollama uses its MLX engine on the Mac and CUDA on the 3080. Ollama's
`format` takes a JSON schema and constrains decoding to it, so a parse failure is rare; parse_replies and one
retry still guard against it.
"""

import http.client
import json
import logging
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.locale import language_name
from app.parsing import parse_replies
from app.schemas import ContextItem, Reply, Style, Turn

log = logging.getLogger("models.suggest")

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"

Post = Callable[[str, dict[str, Any], float], dict[str, Any]]


class OllamaError(RuntimeError):
    pass


def post_json(url: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise OllamaError(f"{url}: {e.code} {e.read().decode(errors='replace')[:300]}") from e
    except (OSError, http.client.HTTPException) as e:  # URLError, timeouts, and connections dropped mid-response
        raise OllamaError(f"Ollama request to {url} failed: {e}") from e


def replies_schema(n: int) -> dict[str, Any]:
    reply = {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "kind": {"type": "string", "enum": ["statement", "question", "yes_no"]},
        },
        "required": ["text", "kind"],
    }
    return {"type": "array", "items": reply, "minItems": n, "maxItems": n}


def lines(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items) or "(none)"


class OllamaSuggest:
    def __init__(self, model: str, url: str, timeout: float = 10.0, post: Post = post_json) -> None:
        self.model, self.url, self.timeout, self.post = model, url.rstrip("/"), timeout, post
        self.prompt = (PROMPTS / "suggest.md").read_text(encoding="utf-8")
        self.summary_prompt = (PROMPTS / "summarize.md").read_text(encoding="utf-8")
        self.send_think = True  # Gemma 4 can think; thinking costs seconds we don't have, so it's turned off

    def load(self) -> None:
        """Fails (and /health says "error") if Ollama isn't running or the model isn't pulled."""
        self.post(f"{self.url}/api/show", {"model": self.model}, self.timeout)
        self._chat("Reply with the single word: ready", num_predict=8, timeout=120)  # loads it into memory

    def suggest(
        self, history: list[Turn], style: Style, context: list[ContextItem], memories: list[str], locale: str, n: int
    ) -> list[Reply]:
        prompt = self.render(history, style, context, memories, locale, n)
        raw = self._chat(prompt, schema=replies_schema(n), num_predict=60 * n)
        try:
            return parse_replies(raw, n)
        except ValueError as e:
            log.warning("suggest: %s; retrying once", e)
            return parse_replies(self._chat(prompt, schema=replies_schema(n), num_predict=60 * n), n)

    def summarize(self, turns: list[Turn], locale: str) -> str:
        prompt = self.summary_prompt.format(
            transcript="\n".join(f"{t.speaker}: {t.text}" for t in turns), language=language_name(locale)
        )
        return self._chat(prompt, num_predict=200).strip()

    def render(
        self, history: list[Turn], style: Style, context: list[ContextItem], memories: list[str], locale: str, n: int
    ) -> str:
        language = language_name(locale)
        return self.prompt.format(
            n=n,
            history="\n".join(f"{t.speaker}: {t.text}" for t in history[-8:]),
            tone=style.tone or "plain and friendly",
            phrases=lines(style.phrases),
            context=lines([f"{c.label}: {c.summary}" for c in context]),
            memories=lines(memories),
            language="English" if language == "Auto" else language,
        )

    def _chat(
        self, prompt: str, schema: dict[str, Any] | None = None, num_predict: int = 200, timeout: float | None = None
    ) -> str:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "keep_alive": -1,  # stay loaded; a reload costs seconds mid-conversation
            "options": {"temperature": 0.7, "num_predict": num_predict},
        }
        if schema is not None:
            body["format"] = schema
        if self.send_think:
            body["think"] = False
        try:
            resp = self.post(f"{self.url}/api/chat", body, timeout or self.timeout)
        except OllamaError as e:
            if self.send_think and "think" in str(e).lower():
                self.send_think = False  # this model/server doesn't take the flag; don't send it again
                return self._chat(prompt, schema, num_predict, timeout)
            raise
        return str(resp.get("message", {}).get("content", ""))
