import type { AudioPlayData } from "@cadence/protocol";
import { createCadenceStore, GatewayConnection, sessionIdFromUrl, type CadenceState } from "@cadence/shared";
import { t } from "@cadence/shared/i18n";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { PhoneAudio } from "./audio.ts";
import { PhraseManager } from "./PhraseManager.tsx";
import { VoiceSetup } from "./VoiceSetup.tsx";
import { keepScreenOn } from "./wakeLock.ts";

const store = createCadenceStore();
const useCadence = <T,>(select: (s: CadenceState) => T): T => useStore(store, select);

/** The clip actually coming out of the speaker; the shared store's nowPlaying is just the latest audio.play. */
const playback = createStore<{ playing: AudioPlayData | null; error: string | null }>()(() => ({
  playing: null,
  error: null,
}));

/** Created inside the Start tap; null until then, so nothing can ever play before the user taps. */
let audio: PhoneAudio | null = null;
const heldClips: AudioPlayData[] = [];
const unsentDone: string[] = [];

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function playClip(clip: AudioPlayData): void {
  if (!audio) {
    heldClips.push(clip);
    return;
  }
  audio
    .enqueue(clip.url, () => playback.setState({ playing: clip }))
    .then(
      () => playback.setState({ error: null }),
      (err) => {
        console.error("playback failed", err);
        playback.setState({ error: errorMessage(err) });
      },
    )
    .finally(() => {
      if (playback.getState().playing === clip) playback.setState({ playing: null });
      reportDone(clip.clipId);
    });
}

// The gateway stays in SPEAKING until it gets audio.done, so one lost while offline is sent on reconnect.
function reportDone(clipId: string): void {
  if (!connection.send("audio.done", { clipId })) unsentDone.push(clipId);
}

const connection = new GatewayConnection({
  role: "phone",
  sessionId: sessionIdFromUrl(),
  onEvent: (event) => {
    store.getState().applyEvent(event);
    if (event.type === "audio.play") playClip(event.data);
  },
  onStatus: (status) => store.getState().setConnection(status),
  // A restarted gateway is back in IDLE and needs the unlock again; otherwise it ignores the repeat.
  onOpen: () => {
    if (audio) connection.send("phone.unlock", {});
    unsentDone.splice(0).forEach(reportDone);
  },
});

export function App() {
  const [started, setStarted] = useState(false);
  const [settingUpVoice, setSettingUpVoice] = useState(false);
  const [managingPhrases, setManagingPhrases] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  useEffect(() => {
    connection.connect();
    return () => connection.close();
  }, []);

  const start = async () => {
    // Everything that needs a user gesture happens synchronously inside this tap.
    audio ??= new PhoneAudio();
    heldClips.splice(0).forEach(playClip);
    keepScreenOn();
    setStarted(true);
    connection.send("phone.unlock", {}); // if the socket isn't open yet, onOpen sends it
    const onMicError = (err: unknown) => setMicError(errorMessage(err));
    try {
      await audio.startMic((frame) => connection.sendAudio(frame), onMicError);
    } catch (err) {
      onMicError(err);
    }
  };

  // Voice setup lives before Start, so the sample isn't also streamed to speech-to-text.
  if (settingUpVoice) return <VoiceSetup onClose={() => setSettingUpVoice(false)} />;
  if (managingPhrases) {
    return <PhraseManager store={store} connection={connection} onClose={() => setManagingPhrases(false)} />;
  }
  if (!started) {
    return (
      <div className="start">
        <button className="big" onClick={start}>
          {t("phone.start")}
        </button>
        <p className="hint">{t("phone.startHint")}</p>
        <button className="secondary" onClick={() => setSettingUpVoice(true)}>
          {t("phone.setupVoice")}
        </button>
        <button className="secondary" onClick={() => setManagingPhrases(true)}>
          {t("phone.managePhrases")}
        </button>
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
  const playing = useStore(playback, (s) => s.playing);
  const playError = useStore(playback, (s) => s.error);

  const answering = state === "CHOOSING" || state === "COMPOSING";
  return (
    <div className="main">
      <div className={`status ${status}`}>
        {t(`status.${status}`)}
        {micError && <div className="error">{t("phone.micError", { error: micError })}</div>}
        {playError && <div className="error">{t("phone.playError", { error: playError })}</div>}
      </div>
      {answering && <div className="ring">{t("phone.answering")}</div>}
      {playing && <div className="speaking">“{playing.text}”</div>}
      <div className="captions">
        {captions.slice(-4).map((c, i) => (
          <div key={i}>{c}</div>
        ))}
        {partial && <div className="partial">{partial}</div>}
      </div>
    </div>
  );
}
