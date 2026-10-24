"""Turn raw model output into replies. Models wrap JSON in prose or code fences; strip that first."""

import json
import re

from pydantic import ValidationError

from app.schemas import Reply

_JSON_ARRAY = re.compile(r"\[.*\]", re.DOTALL)


def parse_replies(raw: str, n: int) -> list[Reply]:
    """Parse a JSON array of {text, kind}; raise ValueError if there isn't one with at least n items."""
    match = _JSON_ARRAY.search(raw)
    if not match:
        raise ValueError("no JSON array in model output")
    try:
        items = [Reply.model_validate(item) for item in json.loads(match.group(0))]
    except (json.JSONDecodeError, ValidationError, TypeError) as e:
        raise ValueError(f"bad reply JSON: {e}") from e
    if len(items) < n:
        raise ValueError(f"wanted {n} replies, got {len(items)}")
    return items[:n]
