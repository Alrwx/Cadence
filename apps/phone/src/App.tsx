import type { AudioPlayData } from "@cadence/protocol";
import { createCadenceStore, GatewayConnection, sessionIdFromUrl, type CadenceState } from "@cadence/shared";
import { t } from "@cadence/shared/i18n";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { PhoneAudio } from "./audio.ts";
import { keepScreenOn } from "./wakeLock.ts";

const store = createCadenceStore();
const useCadence = <T,>(select: (s: CadenceState) => T): T => useStore(store, select);

/** Created inside the Start tap; null until then, so nothing can ever play before the user taps. */
let audio: PhoneAudio | null = null;

function playClip(clip: AudioPlayData): void {
  if (!audio) {
    // No tap yet, so playing isn't allowed. Report done anyway so the gateway doesn't wait in SPEAKING.
    console.warn("audio.play before Start; not playing", clip.clipId);
    connection.send("audio.done", { clipId: clip.clipId });
    return;
  }
  audio
    .enqueue(clip.url)
    .catch((err) => console.error("playback failed", err))
    .finally(() => connection.send("audio.done", { clipId: clip.clipId }));
}

const connection = new GatewayConnection({
  role: "phone",
  sessionId: sessionIdFromUrl(),
  onEvent: (event) => {
    store.getState().applyEvent(event);
    if (event.type === "audio.play") playClip(event.data);
  },
  onStatus: (status) => store.getState().setConnection(status),
  // The gateway forgets the unlock when the connection drops; tell it again on every reconnect.
  onOpen: () => {
    if (audio) connection.send("phone.unlock", {});
  },
});

export function App() {
  const [started, setStarted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  useEffect(() => {
    connection.connect();
    return () => connection.close();
  }, []);

  const start = async () => {
    // Everything that needs a user gesture happens synchronously inside this tap.
    audio ??= new PhoneAudio();
    keepScreenOn();
    setStarted(true);
    connection.send("phone.unlock", {}); // if the socket isn't open yet, onOpen sends it
    try {
      await audio.startMic((frame) => connection.sendAudio(frame));
    } catch (err) {
      setMicError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!started) {
    return (
      <div className="start">
        <button onClick={start}>{t("phone.start")}</button>
        <p className="hint">{t("phone.startHint")}</p>
      </div>
    );
  }
  return <Main micError={micError} />;
}

function Main({ micError }: { micError: string | null }) {
  const state = useCadence((s) => s.state);
  const status = useCadence((s) => s.connection);
  const captions = useCadence((s) => s.captions);
  const partial = useCadence((s) => s.partial);
  const nowPlaying = useCadence((s) => s.nowPlaying);

  const answering = state === "CHOOSING" || state === "COMPOSING";
  return (
    <div className="main">
      <div className={`status ${status}`}>
        {t(`status.${status}`)}
        {micError && <div className="error">{t("phone.micError", { error: micError })}</div>}
      </div>
      {answering && <div className="ring">{t("phone.answering")}</div>}
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
