// Consent + voice-sample upload over plain HTTPS (docs/proposals/2026-10-24-voice-upload-endpoints.md).
// Same-origin paths: the dev servers proxy /api to the gateway, and the gateway serves the built apps.

export class VoiceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.code === "string" ? body.code : "http_error";
    const message = typeof body.message === "string" ? body.message : `${res.status} ${res.statusText}`;
    throw new VoiceApiError(res.status, code, message);
  }
  return body as T;
}

/** Stores the consent record. `statement` is the locale key of the consent text that was shown. */
export async function createConsent(
  req: { sessionId: string; voiceOwner: string; statement: string },
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const res = await fetchImpl("/api/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "voice_clone", ...req }),
  });
  return (await readJson<{ consentId: string }>(res)).consentId;
}

/** Uploads a recorded or picked sample (audio, or video with audio) and returns the new voice ID. */
export async function uploadVoice(
  req: { sessionId: string; consentId: string; sample: Blob; fileName: string },
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.append("audio", req.sample, req.fileName);
  form.append("consentId", req.consentId);
  form.append("sessionId", req.sessionId);
  const res = await fetchImpl("/api/voices", { method: "POST", body: form });
  return (await readJson<{ voiceId: string }>(res)).voiceId;
}

/** Recording formats in preference order: Android Chrome records webm/opus, iOS Safari records mp4/aac. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** First recording format the browser supports, or undefined to let MediaRecorder choose. */
export function pickRecordingType(isSupported: (type: string) => boolean): string | undefined {
  return RECORDING_TYPES.find((type) => isSupported(type));
}

/** A file name with an extension ffmpeg recognizes, for a recorded blob's MIME type. */
export function recordingFileName(mimeType: string): string {
  if (mimeType.includes("mp4")) return "sample.m4a";
  if (mimeType.includes("ogg")) return "sample.ogg";
  return "sample.webm";
}
