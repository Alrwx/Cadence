import pytest

from app.parsing import parse_replies


def test_parses_array_wrapped_in_prose_and_fences():
    raw = 'Sure!\n```json\n[{"text": "Yes", "kind": "yes_no"}, {"text": "A bit tired", "kind": "statement"},'
    raw += ' {"text": "Is it time?", "kind": "question"}]\n```'
    replies = parse_replies(raw, 3)
    assert [r.kind for r in replies] == ["yes_no", "statement", "question"]


def test_trims_extra_replies():
    raw = '[{"text": "a", "kind": "statement"}, {"text": "b", "kind": "statement"}]'
    assert len(parse_replies(raw, 1)) == 1


@pytest.mark.parametrize(
    "raw",
    [
        "no json here",
        '[{"text": "a", "kind": "shout"}]',
        '[{"text": "only one", "kind": "statement"}]',
        "[not json]",
    ],
)
def test_rejects_bad_output(raw):
    with pytest.raises(ValueError):
        parse_replies(raw, 2)
