import { createCadenceStore, GatewayConnection, sessionIdFromUrl, type CadenceState } from "@cadence/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { PhoneAudio } from "./audio.ts";

const store = createCadenceStore();
const useCadence = <T,>(select: (s: CadenceState) => T): T => useStore(store, select);

const connection = new GatewayConnection({
  role: "phone",
  sessionId: sessionIdFromUrl(),
  onEvent: (event) => store.getState().applyEvent(event),
  onStatus: (status) => store.getState().setConnection(status),
});

export function App() {
  const [audio, setAudio] = useState<PhoneAudio | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  useEffect(() => {
    connection.connect();
    return () => connection.close();
  }, []);

  const start = async () => {
    // Created inside the tap so playback is allowed later without another tap.
    const a = new PhoneAudio();
    setAudio(a);
    connection.send("phone.unlock", {});
    try {
      await a.startMic((frame) => connection.sendAudio(frame));
    } catch (err) {
      setMicError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!audio) {
    return (
      <div className="start">
        <button onClick={start}>Start</button>
      </div>
    );
  }
  return <Main audio={audio} micError={micError} />;
}

function Main({ audio, micError }: { audio: PhoneAudio; micError: string | null }) {
  const state = useCadence((s) => s.state);
  const status = useCadence((s) => s.connection);
  const captions = useCadence((s) => s.captions);
  const partial = useCadence((s) => s.partial);
  const nowPlaying = useCadence((s) => s.nowPlaying);
  const played = useRef(new Set<string>());

  // Play each audio.play clip once, then report audio.done.
  useEffect(() => {
    if (!nowPlaying || played.current.has(nowPlaying.clipId)) return;
    played.current.add(nowPlaying.clipId);
    audio
      .play(nowPlaying.url)
      .catch((err) => console.error("playback failed", err))
      .finally(() => connection.send("audio.done", { clipId: nowPlaying.clipId }));
  }, [audio, nowPlaying]);

  const answering = state === "CHOOSING" || state === "COMPOSING";
  return (
    <div className="main">
      <div className="status">
        gateway: {status} · {state}
        {micError && ` · mic error: ${micError}`}
      </div>
      {answering && <div className="ring">I'm answering…</div>}
      {state === "SPEAKING" && nowPlaying && <div className="speaking">“{nowPlaying.text}”</div>}
      <div className="captions">
        {captions.slice(-4).map((c, i) => (
          <div key={i}>{c}</div>
        ))}
        {partial && <div className="partial">{partial}</div>}
      </div>
    </div>
  );
}
