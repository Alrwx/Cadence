"""Turn a recording of a real person into the "default" voice on one machine, without committing it.

Decodes the clip (m4a, webm, mp4, wav, ...), trims leading/trailing silence and normalizes it the same way
/voices does, then writes ref.wav + ref.txt to --out. Point DEFAULT_VOICE_AUDIO / DEFAULT_VOICE_TEXT in .env at
them and restart the model service. The transcript must match the clip word for word, so a clip longer than
/voices keeps (MAX_TRANSCRIBED_S) is rejected rather than cut. Keep --out under data/ (gitignored), not in assets/.

Run from services/models:
    uv run --extra cuda python scripts/set_default_voice.py clip.m4a --text "Exactly what I said."
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app.backends  # noqa: E402, F401  (app.tts and app.backends import each other; load the package first)
from app.audio import decode, prepare_reference, speech_seconds, to_wav  # noqa: E402
from app.tts import MAX_TRANSCRIBED_S, MIN_SPEECH_S  # noqa: E402

SAMPLE_RATE = 24000  # Qwen3-TTS's rate; the service resamples to its engine's rate anyway
DATA = Path(__file__).resolve().parents[3] / "data"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("clip", type=Path)
    text = p.add_mutually_exclusive_group(required=True)
    text.add_argument("--text", help="what the clip says, word for word")
    text.add_argument("--text-file", type=Path)
    p.add_argument("--out", type=Path, default=DATA / "default_voice")
    args = p.parse_args()

    transcript = (args.text if args.text is not None else args.text_file.read_text(encoding="utf-8")).strip()
    if not transcript:
        p.error("the transcript is empty")
    audio = decode(args.clip.read_bytes(), SAMPLE_RATE)
    if speech_seconds(audio, SAMPLE_RATE) < MIN_SPEECH_S:
        p.error(f"the clip needs at least {MIN_SPEECH_S:.0f} seconds of speech")
    ref = prepare_reference(audio, SAMPLE_RATE, max_seconds=len(audio) / SAMPLE_RATE)  # trim silence, never cut
    seconds = len(ref) / SAMPLE_RATE
    if seconds > MAX_TRANSCRIBED_S:
        p.error(f"the clip is {seconds:.1f} s after trimming silence; keep it under {MAX_TRANSCRIBED_S:.0f} s")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "ref.wav").write_bytes(to_wav(ref, SAMPLE_RATE))
    (args.out / "ref.txt").write_text(transcript + "\n", encoding="utf-8")
    out = args.out.resolve()
    print(f"wrote {out / 'ref.wav'} ({seconds:.1f} s). Add to .env, then restart the model service:")
    print(f"DEFAULT_VOICE_AUDIO={out / 'ref.wav'}\nDEFAULT_VOICE_TEXT={out / 'ref.txt'}")


if __name__ == "__main__":
    main()
