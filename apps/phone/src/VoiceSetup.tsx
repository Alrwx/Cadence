// Voice setup, one idea per screen: consent, record, listen back, then create. Lives inside a Sheet.
import { createConsent, recordingFileName, sessionIdFromUrl, uploadVoice } from "@cadence/shared";
import { t } from "@cadence/shared/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LevelMeter } from "./LevelMeter.tsx";
import { MAX_SAMPLE_SECONDS, startRecording, type Recording } from "./recorder.ts";
import { Icon, Switch } from "./ui.tsx";

interface Sample {
  blob: Blob;
  fileName: string;
  label: string;
}

type Step =
  | { kind: "consent" }
  | { kind: "record"; consentId: string }
  | { kind: "review"; consentId: string; sample: Sample }
  | { kind: "creating" }
  | { kind: "done" }
  | { kind: "error"; message: string; back: Step };

const CONSENT_STATEMENT = "voice.consentCheck";

/** Which of the three progress dots a step belongs to. */
function dotOf(step: Step): number {
  switch (step.kind) {
    case "consent":
      return 0;
    case "record":
    case "review":
      return 1;
    case "creating":
    case "done":
      return 2;
    case "error":
      return dotOf(step.back);
  }
}

export function VoiceSetup({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "consent" });
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const sessionId = sessionIdFromUrl();

  const go = (next: Step, direction: "forward" | "back" = "forward") => {
    setDir(direction);
    setStep(next);
  };

  const giveConsent = async (voiceOwner: string) => {
    try {
      const consentId = await createConsent({ sessionId, voiceOwner, statement: CONSENT_STATEMENT });
      go({ kind: "record", consentId });
    } catch (err) {
      go({ kind: "error", message: errorText(err), back: step });
    }
  };

  const create = async (consentId: string, sample: Sample) => {
    go({ kind: "creating" });
    try {
      await uploadVoice({ sessionId, consentId, sample: sample.blob, fileName: sample.fileName });
      go({ kind: "done" });
    } catch (err) {
      go({ kind: "error", message: errorText(err), back: { kind: "review", consentId, sample } });
    }
  };

  return (
    <>
      <header className="sheet-head">
        {step.kind === "creating" || step.kind === "done" ? (
          <span />
        ) : (
          <button className="btn btn-text" onClick={onClose}>
            {t("voice.cancel")}
          </button>
        )}
        <div className="dots" role="img" aria-label={t("voice.stepOf", { n: dotOf(step) + 1 })}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={i <= dotOf(step) ? "on" : ""} />
          ))}
        </div>
        <span />
      </header>

      <div key={step.kind} className={`step ${dir}`}>
        {step.kind === "consent" && <ConsentStep onConsent={giveConsent} />}
        {step.kind === "record" && (
          <RecordStep onSample={(sample) => go({ kind: "review", consentId: step.consentId, sample })} />
        )}
        {step.kind === "review" && (
          <ReviewStep
            sample={step.sample}
            onUse={() => create(step.consentId, step.sample)}
            onAgain={() => go({ kind: "record", consentId: step.consentId }, "back")}
          />
        )}
        {step.kind === "creating" && (
          <Step title={t("voice.creatingTitle")} subtitle={t("voice.uploading")}>
            <div className="center">
              <span className="orb" />
            </div>
          </Step>
        )}
        {step.kind === "done" && (
          <Step
            title={t("voice.doneTitle")}
            subtitle={t("voice.doneBody")}
            actions={
              <button className="btn btn-primary" onClick={onClose}>
                {t("voice.finish")}
              </button>
            }
          >
            <div className="center">
              <span className="done-mark">
                <Icon name="check" size={52} />
              </span>
            </div>
          </Step>
        )}
        {step.kind === "error" && (
          <Step
            title={t("voice.errorTitle")}
            subtitle={t("voice.error", { error: step.message })}
            actions={
              <button className="btn btn-primary" onClick={() => go(step.back, "back")}>
                {t("voice.tryAgain")}
              </button>
            }
          />
        )}
      </div>
    </>
  );
}

/** One screen: a large title, a line of explanation, the content, and the main action pinned to the bottom. */
function Step({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="step-body">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
        {children}
      </div>
      {actions && <div className="step-footer">{actions}</div>}
    </>
  );
}

function ConsentStep({ onConsent }: { onConsent: (owner: string) => void }) {
  const [owner, setOwner] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = owner.trim();
  return (
    <Step
      title={t("voice.consentTitle")}
      subtitle={t("voice.consentIntro")}
      actions={
        <button
          className="btn btn-primary"
          disabled={!name || !agreed || busy}
          onClick={() => {
            setBusy(true);
            onConsent(name);
          }}
        >
          {t("voice.continue")}
        </button>
      }
    >
      <label>
        <span className="field-label">{t("voice.ownerLabel")}</span>
        <input
          className="input"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder={t("voice.ownerPlaceholder")}
          autoComplete="name"
        />
      </label>
      <label className="card switch-row">
        <span>{t("voice.consentCheck", { name: name || "…" })}</span>
        <Switch checked={agreed} onChange={setAgreed} disabled={!name} />
      </label>
    </Step>
  );
}

function RecordStep({ onSample }: { onSample: (sample: Sample) => void }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording]);

  const record = async () => {
    setError(null);
    setElapsed(0);
    try {
      const rec = await startRecording();
      setRecording(rec);
      const started = Date.now();
      const blob = await rec.done;
      const seconds = Math.round((Date.now() - started) / 1000);
      onSample({ blob, fileName: recordingFileName(blob.type), label: t("voice.recorded", { seconds }) });
    } catch (err) {
      setError(t("phone.micError", { error: errorText(err) }));
    } finally {
      setRecording(null);
    }
  };

  const pick = (file: File | undefined) => {
    if (file) onSample({ blob: file, fileName: file.name, label: t("voice.selected", { name: file.name }) });
  };

  return (
    <Step
      title={t("voice.recordTitle")}
      subtitle={t("voice.sampleIntro")}
      actions={
        // Hidden, not removed, while recording, so the record button doesn't move.
        <button
          className="btn btn-text"
          style={{ visibility: recording ? "hidden" : "visible" }}
          onClick={() => fileInput.current?.click()}
        >
          {t("voice.pickFile")}
        </button>
      }
    >
      <p className="card reading">{t("voice.readingText")}</p>
      <div className="recorder">
        <div className={`live${recording ? " on" : ""}`} aria-hidden="true">
          <span className="timer">{formatTime(elapsed)}</span>
          {recording ? <LevelMeter level={recording.level} /> : <div className="meter" />}
        </div>
        <button
          className={`rec${recording ? " on" : ""}`}
          aria-label={recording ? t("voice.stop") : t("voice.record")}
          onClick={() => (recording ? recording.stop() : record())}
        >
          {recording && (
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="47" pathLength="1" style={{ animationDuration: `${MAX_SAMPLE_SECONDS}s` }} />
            </svg>
          )}
        </button>
        <p className="muted small">{recording ? t("voice.meterHint") : t("voice.recordHint")}</p>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <input ref={fileInput} type="file" accept="audio/*,video/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </Step>
  );
}

function ReviewStep({ sample, onUse, onAgain }: { sample: Sample; onUse: () => void; onAgain: () => void }) {
  return (
    <Step
      title={t("voice.reviewTitle")}
      subtitle={sample.label}
      actions={
        <>
          <button className="btn btn-primary" onClick={onUse}>
            {t("voice.use")}
          </button>
          <button className="btn btn-text" onClick={onAgain}>
            {t("voice.recordAgain")}
          </button>
        </>
      }
    >
      <div className="center">
        <Preview blob={sample.blob} />
      </div>
    </Step>
  );
}

/** A round play and pause button for the recording, in place of the browser's own player. */
function Preview({ blob }: { blob: Blob }) {
  const url = useObjectUrl(blob);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <>
      <audio
        ref={audio}
        src={url ?? undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button
        className="play"
        aria-label={playing ? t("voice.pause") : t("voice.play")}
        onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}
      >
        <Icon name={playing ? "pause" : "play"} size={36} filled />
      </button>
    </>
  );
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
