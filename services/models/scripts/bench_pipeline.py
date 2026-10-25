"""Time STT, /suggest and /tts for 20 sample turns against a running model service; write docs/latency.md.

This is Dev 3's "done means" check (AGENTS(GH).md §7). It goes through the real HTTP/WebSocket API, the same way
the gateway does, so the numbers include everything the gateway will wait on.

For each turn:
- the listener's line is spoken in the default voice (/tts), then streamed to /stt in real time as 20 ms frames.
  "STT final" is the time from the clip's last frame to the final transcript, i.e. the VAD's end-of-speech wait
  plus transcription: what the user waits after the speaker stops. The clip's own trailing silence (a few hundred
  ms) already counts toward that wait, the same as a real pause would.
- /suggest gets the conversation so far.
- the 3 suggestions go to /tts at once (the gateway's speculation), and "instant" is a lone short phrase.

Run from services/models, with the service up (`make models`):
    uv run --extra cuda python scripts/bench_pipeline.py --hardware "RTX 3080 server"
"""

import argparse
import asyncio
import io
import json
import platform
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.audio import decode  # noqa: E402

LATENCY_MD = Path(__file__).resolve().parents[3] / "docs" / "latency.md"
START, END = "<!-- bench_pipeline:start -->", "<!-- bench_pipeline:end -->"

TURNS = [
    "Good morning. How did you sleep last night?",
    "Are you in any pain right now?",
    "Would you like some water?",
    "Your daughter called. She's coming at four.",
    "Do you want the window open or closed?",
    "The doctor wants to change your medication. Is that okay?",
    "What would you like for lunch today?",
    "Did the physical therapist come by this morning?",
    "Are you warm enough, or should I get another blanket?",
    "Can you squeeze my hand?",
    "Do you remember my name?",
    "Should I turn the TV on for the game?",
    "We're going to take your blood pressure now.",
    "How are you feeling compared to yesterday?",
    "Is there anyone you want me to call?",
    "Do you need help getting to the bathroom?",
    "The nurse will be here in ten minutes.",
    "Would you like me to read you the news?",
    "Are you hungry?",
    "I'll see you tomorrow. Is there anything else you need?",
]
INSTANT = ["Yes", "No", "Give me a second", "Thank you"]


def post(url: str, body: dict, timeout: float = 60) -> tuple[bytes, float]:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"}, method="POST")
    start = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    return data, time.perf_counter() - start


def get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return json.loads(resp.read())


def wav_seconds(data: bytes) -> float:
    with wave.open(io.BytesIO(data)) as w:
        return w.getnframes() / w.getframerate()


async def stream_stt(ws_url: str, audio16k: np.ndarray) -> tuple[str, float, int]:
    """Stream speech + 1.5 s of silence in real time; return (final text, seconds from end of speech, partials)."""
    pcm = (np.clip(np.concatenate([audio16k, np.zeros(24000, np.float32)]), -1, 1) * 32767).astype("<i2").tobytes()
    speech_end_byte = len(audio16k) * 2
    partials, final, speech_end = 0, "", 0.0
    async with websockets.connect(ws_url) as ws:

        async def send() -> None:
            nonlocal speech_end
            t0 = time.perf_counter()
            for i, off in enumerate(range(0, len(pcm), 640)):
                await ws.send(pcm[off : off + 640])
                if off + 640 >= speech_end_byte and not speech_end:
                    speech_end = time.perf_counter()
                await asyncio.sleep(max(0.0, t0 + (i + 1) * 0.02 - time.perf_counter()))

        sender = asyncio.create_task(send())
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if msg["kind"] == "partial":
                partials += 1
            else:
                final, done = msg["text"], time.perf_counter()
                break
        sender.cancel()
    return final, done - speech_end, partials


def pct(values: list[float], q: float) -> float:
    return float(np.percentile(values, q)) if values else float("nan")


def fmt(values: list[float]) -> str:
    if not values:
        return "n/a"
    return f"{pct(values, 50) * 1000:.0f} / {pct(values, 95) * 1000:.0f} / {max(values) * 1000:.0f}"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://127.0.0.1:8000")
    p.add_argument("--hardware", required=True, help='e.g. "M4 Pro 24 GB" or "RTX 3080 server"')
    p.add_argument("--no-write", action="store_true", help="print the table instead of updating docs/latency.md")
    args = p.parse_args()
    base, ws_url = args.url.rstrip("/"), args.url.replace("http", "ws", 1).rstrip("/") + "/stt?locale=en"

    health = get(f"{base}/health")
    print("health:", health)
    if health["tts"] != "ready" or health["stt"] != "ready":
        raise SystemExit("stt and tts must be ready")
    can_suggest = health["suggest"] == "ready"

    stt_final, stt_ok, suggest_s, tts_batch, tts_one_s, instant_s, rtf = [], 0, [], [], [], [], []
    history: list[dict] = []
    pool = ThreadPoolExecutor(max_workers=3)
    for i, line in enumerate(TURNS, 1):
        wav, _ = post(f"{base}/tts", {"voiceId": "default", "text": line})
        heard, final_s, partials = asyncio.run(stream_stt(ws_url, decode(wav, 16000)))
        stt_final.append(final_s)
        expected = set(re.findall(r"[a-z']+", line.lower()))
        overlap = len(expected & set(re.findall(r"[a-z']+", heard.lower()))) / len(expected)
        stt_ok += overlap >= 0.8
        history.append({"speaker": "other", "text": heard or line})

        replies = ["Yes, please.", "Not right now.", "Can you ask me later?"]
        if can_suggest:
            try:
                body, secs = post(f"{base}/suggest", {"turnId": f"t_{i}", "history": history[-20:]}, timeout=30)
                replies = [r["text"] for r in json.loads(body)["items"]]
                suggest_s.append(secs)
            except urllib.error.URLError as e:
                print(f"  suggest failed: {e}")

        start = time.perf_counter()
        clips = list(pool.map(lambda t: post(f"{base}/tts", {"voiceId": "default", "text": t}), replies))
        tts_batch.append(time.perf_counter() - start)
        rtf += [secs / wav_seconds(data) for data, secs in clips]
        _, secs = post(f"{base}/tts", {"voiceId": "default", "text": replies[0]})
        tts_one_s.append(secs)
        _, secs = post(f"{base}/tts", {"voiceId": "default", "text": INSTANT[i % len(INSTANT)]})
        instant_s.append(secs)
        history.append({"speaker": "user", "text": replies[0]})
        print(f"{i:2d} stt {final_s * 1000:5.0f} ms ({partials} partials) heard={heard!r}")

    table = [
        f"Measured {date.today().isoformat()} on **{args.hardware}** ({platform.system()} {platform.machine()}), "
        f"backend `{health['backend']}`, by `services/models/scripts/bench_pipeline.py` over HTTP/WebSocket "
        f"({len(TURNS)} turns, warm). Values are p50 / p95 / max in ms.",
        "",
        "| Step | p50 / p95 / max (ms) | Notes |",
        "|---|---|---|",
        f"| STT final after the speaker stops | {fmt(stt_final)} | from the end of the clip, so the clip's own "
        "trailing silence counts toward the VAD's 700 ms end-of-speech wait; "
        f"{stt_ok}/{len(TURNS)} transcripts had ≥ 80% of the words |",
        f"| `/suggest` | {fmt(suggest_s)} | "
        + ("Gemma 4 via Ollama |" if suggest_s else "not measured: Ollama wasn't ready |"),
        f"| `/tts`, 3 suggestions at once | {fmt(tts_batch)} | until the last of the 3 clips is back; batched |",
        f"| `/tts`, one reply | {fmt(tts_one_s)} | alone; in the batches, wall time ÷ audio length per clip was "
        f"{statistics.median(rtf):.2f} (p50) |",
        f"| `/tts`, instant phrase | {fmt(instant_s)} | the gateway's clip cache serves repeats without this |",
    ]
    section = "\n".join([START, f"## Pipeline: {args.hardware}", "", *table, END])
    print("\n" + section)
    if args.no_write:
        return
    doc = LATENCY_MD.read_text(encoding="utf-8")
    marker = re.compile(re.escape(START) + r".*?" + re.escape(END), re.DOTALL)
    hardware_start = f"{START}\n## Pipeline: {args.hardware}\n"
    blocks = [m for m in marker.finditer(doc) if m.group(0).startswith(hardware_start)]
    if blocks:
        doc = doc[: blocks[0].start()] + section + doc[blocks[0].end() :]
    else:
        doc = doc.rstrip("\n") + "\n\n" + section + "\n"
    LATENCY_MD.write_text(doc, encoding="utf-8")
    print(f"updated {LATENCY_MD}")


if __name__ == "__main__":
    main()
