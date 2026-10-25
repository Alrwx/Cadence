"""Locale plumbing (AGENTS(GH).md §1 Languages). Every route takes a BCP 47 locale such as "en" or "pt-BR"."""

LANGUAGES = {
    "en": "English",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "ru": "Russian",
    "pt": "Portuguese",
    "es": "Spanish",
    "it": "Italian",
}


def language_code(locale: str) -> str:
    """Whisper's language code, e.g. pt-BR -> pt."""
    return (locale or "en").replace("_", "-").split("-")[0].lower()


def language_name(locale: str) -> str:
    """Qwen3-TTS's (and the prompts') language name, e.g. pt-BR -> Portuguese; "Auto" for languages it doesn't list."""
    return LANGUAGES.get(language_code(locale), "Auto")
