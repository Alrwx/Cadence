// Records a voice sample with MediaRecorder. Separate from the PCM16 mic stream, which only runs after Start.
import { pickRecordingType } from "@cadence/shared";

export const MAX_SAMPLE_SECONDS = 30;

export interface Recording {
  /** Stops early; the promise from startRecording resolves with what was captured. */
  stop: () => void;
  done: Promise<Blob>;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Cloning wants the voice as it is: no noise suppression or auto gain shaping it.
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const mimeType = pickRecordingType((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
    };
    recorder.onerror = (e) => {
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error(`recording failed: ${String((e as ErrorEvent).message ?? e.type)}`));
    };
  });
  const limit = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), MAX_SAMPLE_SECONDS * 1000);
  // Timeslice so Safari hands over data regularly instead of only at the end.
  recorder.start(1000);
  return {
    stop: () => {
      clearTimeout(limit);
      if (recorder.state !== "inactive") recorder.stop();
    },
    done,
  };
}
