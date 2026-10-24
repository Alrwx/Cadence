// Voice setup: consent first, then record or pick a sample, then upload (docs/proposals/2026-10-24-voice-upload-endpoints.md).
import { createConsent, recordingFileName, sessionIdFromUrl, uploadVoice } from "@cadence/shared";
import { t } from "@cadence/shared/i18n";
import { useEffect, useRef, useState } from "react";
import { MAX_SAMPLE_SECONDS, startRecording, type Recording } from "./recorder.ts";

type Step =
  | { kind: "consent" }
  | { kind: "sample"; consentId: string }
  | { kind: "uploading" }
  | { kind: "done" }
  | { kind: "error"; message: string; consentId: string | null };

interface Sample {
  blob: Blob;
  fileName: string;
  label: string;
}

const CONSENT_STATEMENT = "voice.consentCheck";

export function VoiceSetup({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "consent" });
  const sessionId = sessionIdFromUrl();

  const giveConsent = async (voiceOwner: string) => {
    try {
      const consentId = await createConsent({ sessionId, voiceOwner, statement: CONSENT_STATEMENT });
      setStep({ kind: "sample", consentId });
    } catch (err) {
      setStep({ kind: "error", message: errorText(err), consentId: null });
    }
  };

  const upload = async (consentId: string, sample: Sample) => {
    setStep({ kind: "uploading" });
    try {
      await uploadVoice({ sessionId, consentId, sample: sample.blob, fileName: sample.fileName });
      setStep({ kind: "done" });
    } catch (err) {
      setStep({ kind: "error", message: errorText(err), consentId });
    }
  };

  return (
    <div className="voice">
      <h1>{t("voice.title")}</h1>
      {step.kind === "consent" && <ConsentStep onConsent={giveConsent} onCancel={onClose} />}
      {step.kind === "sample" && <SampleStep onUse={(s) => upload(step.consentId, s)} onCancel={onClose} />}
      {step.kind === "uploading" && <p className="busy">{t("voice.uploading")}</p>}
      {step.kind === "done" && (
        <>
          <p className="ok">{t("voice.done")}</p>
          <button className="primary" onClick={onClose}>
            {t("voice.back")}
          </button>
        </>
      )}
      {step.kind === "error" && (
        <>
          <p className="error">{t("voice.error", { error: step.message })}</p>
          <button
            className="primary"
            onClick={() =>
              setStep(step.consentId ? { kind: "sample", consentId: step.consentId } : { kind: "consent" })
            }
          >
            {t("voice.tryAgain")}
          </button>
          <button onClick={onClose}>{t("voice.cancel")}</button>
        </>
      )}
    </div>
  );
}

function ConsentStep({ onConsent, onCancel }: { onConsent: (owner: string) => void; onCancel: () => void }) {
  const [owner, setOwner] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = owner.trim();
  return (
    <>
      <p>{t("voice.consentIntro")}</p>
      <label className="field">
        {t("voice.ownerLabel")}
        <input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder={t("voice.ownerPlaceholder")}
          autoComplete="name"
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={!name} />
        <span>{t("voice.consentCheck", { name: name || "…" })}</span>
      </label>
      <button
        className="primary"
        disabled={!name || !agreed || busy}
        onClick={() => {
          setBusy(true);
          onConsent(name);
        }}
      >
        {t("voice.continue")}
      </button>
      <button onClick={onCancel}>{t("voice.cancel")}</button>
    </>
  );
}

function SampleStep({ onUse, onCancel }: { onUse: (sample: Sample) => void; onCancel: () => void }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useObjectUrl(sample?.blob ?? null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Countdown while recording.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording]);

  const record = async () => {
    setError(null);
    setSample(null);
    setElapsed(0);
    try {
      const rec = await startRecording();
      setRecording(rec);
      const started = Date.now();
      const blob = await rec.done;
      const seconds = Math.round((Date.now() - started) / 1000);
      setSample({ blob, fileName: recordingFileName(blob.type), label: t("voice.recorded", { seconds }) });
    } catch (err) {
      setError(t("phone.micError", { error: errorText(err) }));
    } finally {
      setRecording(null);
    }
  };

  const pick = (file: File | undefined) => {
    if (file) setSample({ blob: file, fileName: file.name, label: t("voice.selected", { name: file.name }) });
  };

  return (
    <>
      <p>{t("voice.sampleIntro")}</p>
      <div className="reading">
        <p className="muted">{t("voice.readThis")}</p>
        <p>{t("voice.readingText")}</p>
      </div>
      {recording ? (
        <button className="primary recording" onClick={() => recording.stop()}>
          {t("voice.stop", { seconds: Math.max(0, MAX_SAMPLE_SECONDS - elapsed) })}
        </button>
      ) : (
        <div className="row">
          <button className="primary" onClick={record}>
            {sample ? t("voice.recordAgain") : t("voice.record")}
          </button>
          <button onClick={() => fileInput.current?.click()}>{t("voice.pickFile")}</button>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,video/*"
            hidden
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {sample && !recording && (
        <>
          <p className="muted">{sample.label}</p>
          {preview && <audio controls src={preview} />}
          <button className="primary" onClick={() => onUse(sample)}>
            {t("voice.use")}
          </button>
        </>
      )}
      <button onClick={onCancel} disabled={!!recording}>
        {t("voice.cancel")}
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
