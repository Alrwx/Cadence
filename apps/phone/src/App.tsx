import type { AudioPlayData } from "@cadence/protocol";
import {
  createCadenceStore,
  GatewayConnection,
  sessionIdFromUrl,
  type CadenceState,
  type ConnectionStatus,
} from "@cadence/shared";
import { isLocale, LANGUAGES, t } from "@cadence/shared/i18n";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { PhoneAudio } from "./audio.ts";
import { PhraseManager } from "./PhraseManager.tsx";
import { setTheme, useTheme } from "./theme.ts";
import { Icon, Sheet } from "./ui.tsx";
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
  // Every string comes from t(), which follows the gateway's language event; re-render the tree when it changes.
  useCadence((s) => s.locale);

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
  const covered = settingUpVoice || managingPhrases;
  return (
    <>
      {started ? (
        <Main micError={micError} />
      ) : (
        <Start
          inert={covered}
          onStart={start}
          onSetupVoice={() => setSettingUpVoice(true)}
          onPhrases={() => setManagingPhrases(true)}
        />
      )}
      {settingUpVoice && (
        <Sheet label={t("voice.title")} onClosed={() => setSettingUpVoice(false)}>
          {(close) => <VoiceSetup onClose={close} />}
        </Sheet>
      )}
      {managingPhrases && (
        <Sheet label={t("phrases.title")} variant="push" onClosed={() => setManagingPhrases(false)}>
          {(close) => <PhraseManager store={store} connection={connection} onClose={close} />}
        </Sheet>
      )}
    </>
  );
}

/** The connection status on the left; the language and the light and dark switch on the right. */
function TopBar({ status }: { status: ConnectionStatus }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <div className="topbar">
      <span className={`pill ${status}`} role="status">
        {t(`status.${status}`)}
      </span>
      <div className="topbar-actions">
        <LanguageToggle />
        <button
          className="icon-btn theme-toggle"
          onClick={() => setTheme(next)}
          aria-label={t(next === "dark" ? "theme.toDark" : "theme.toLight")}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </div>
    </div>
  );
}

/** Shows the current language; a tap moves the whole app (both devices, and the conversation) to the next one. */
function LanguageToggle() {
  const locale = useCadence((s) => s.locale);
  const supported = useCadence((s) => s.supportedLocales).filter(isLocale);
  if (supported.length < 2) return null; // not connected yet, or nothing to switch to
  const next = supported[(supported.indexOf(locale) + 1) % supported.length]!;
  return (
    <button
      className="icon-btn language-toggle"
      onClick={() => connection.send("language.set", { locale: next })}
      aria-label={t("language.switchTo", { language: LANGUAGES[next] })}
    >
      {locale.toUpperCase()}
    </button>
  );
}

function Start({
  inert,
  onStart,
  onSetupVoice,
  onPhrases,
}: {
  inert: boolean;
  onStart: () => void;
  onSetupVoice: () => void;
  onPhrases: () => void;
}) {
  const status = useCadence((s) => s.connection);
  return (
    <main className="start" inert={inert}>
      <TopBar status={status} />
      <header className="brand">
        <div className="mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <h1>Cadence</h1>
        <p className="subtitle">{t("phone.tagline")}</p>
      </header>
      <div className="start-action">
        <button className="btn btn-primary btn-large" onClick={onStart}>
          {t("phone.start")}
        </button>
        <p className="hint">{t("phone.startHint")}</p>
      </div>
      <nav className="list">
        <button className="list-row" onClick={onSetupVoice}>
          <span className="list-icon">
            <Icon name="mic" size={18} />
          </span>
          {t("phone.setupVoice")}
          <span className="chevron">
            <Icon name="chevron" />
          </span>
        </button>
        <button className="list-row" onClick={onPhrases}>
          <span className="list-icon">
            <Icon name="message" size={18} />
          </span>
          {t("phone.managePhrases")}
          <span className="chevron">
            <Icon name="chevron" />
          </span>
        </button>
      </nav>
    </main>
  );
}

function Main({ micError }: { micError: string | null }) {
  const state = useCadence((s) => s.state);
  const status = useCadence((s) => s.connection);
  const captions = useCadence((s) => s.captions);
  const partial = useCadence((s) => s.partial);
  const playing = useStore(playback, (s) => s.playing);
  const playError = useStore(playback, (s) => s.error);

  const recent = captions.slice(-4);
  const answering = state === "CHOOSING" || state === "COMPOSING";
  // The dock shows what the other person needs to know: the reply being spoken, that one is coming, or that we're listening.
  const mode = playing ? "speaking" : answering ? "answering" : "listening";
  return (
    <main className="listening">
      <TopBar status={status} />
      {micError && (
        <p className="notice" role="alert">
          {t("phone.micError", { error: micError })}
        </p>
      )}
      {playError && (
        <p className="notice" role="alert">
          {t("phone.playError", { error: playError })}
        </p>
      )}
      <section className="captions" aria-live="polite">
        {recent.length === 0 && !partial && <p className="placeholder">{t("phone.captionsPlaceholder")}</p>}
        {recent.map((line, i) => (
          <p key={captions.length - recent.length + i}>{line}</p>
        ))}
        {partial && <p className="partial">{partial}</p>}
      </section>
      <div key={mode} className={`dock ${mode}`}>
        {mode === "speaking" && <p>“{playing?.text}”</p>}
        {mode === "answering" && (
          <>
            <span className="orb" aria-hidden="true" />
            <p>{t("phone.answering")}</p>
          </>
        )}
        {mode === "listening" && (
          <>
            <span className="bars" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            <p>{t("phone.listening")}</p>
          </>
        )}
      </div>
    </main>
  );
}
