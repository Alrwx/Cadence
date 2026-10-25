// Records a voice sample with MediaRecorder. Separate from the PCM16 mic stream, which only runs after Start.
import { pickRecordingType } from "@cadence/shared";

export const MAX_SAMPLE_SECONDS = 30;

export interface Recording {
  /** Stops early; the promise from startRecording resolves with what was captured. */
  stop: () => void;
  done: Promise<Blob>;
  /** How loud the voice is right now, from 0 (silence) to 1 (loud), for the live meter. */
  level: () => number;
}

export async function startRecording(): Promise<Recording> {
  // Made before the first await, so it's still inside the tap that started the recording (iOS needs that).
  const ctx = new AudioContext();
  void ctx.resume();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Cloning wants the voice as it is: no noise suppression or auto gain shaping it.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    void ctx.close();
    throw err;
  }
  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
    void ctx.close();
  };
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser); // not connected to the speaker
  const samples = new Float32Array(analyser.fftSize);
  const level = () => {
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
    return Math.min(1, Math.max(0, (20 * Math.log10(rms || 1e-6) + 60) / 50)); // -60 dB to -10 dB
  };
  const mimeType = pickRecordingType((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      release();
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
    };
    recorder.onerror = (e) => {
      release();
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
    level,
  };
}
