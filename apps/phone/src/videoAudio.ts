// Pulls the audio track out of a picked video, in the browser, before anything is uploaded.
import { encodeWav, trimToMono, VIDEO_SAMPLE_RATE, VIDEO_SAMPLE_SECONDS } from "@cadence/shared";

export interface VideoAudio {
  wav: Blob;
  seconds: number;
}

/** Decodes the video's audio, keeps the first VIDEO_SAMPLE_SECONDS as mono, and returns it as a WAV. */
export async function extractVideoAudio(file: File): Promise<VideoAudio> {
  // decodeAudioData reads the audio track of mp4/mov/webm containers and resamples to the context's rate.
  const context = new OfflineAudioContext(1, 1, VIDEO_SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("the video has no audio track this browser can read");
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const mono = trimToMono(channels, decoded.sampleRate, VIDEO_SAMPLE_SECONDS);
  if (mono.length === 0) throw new Error("the video has no audio");
  return {
    wav: new Blob([encodeWav(mono, decoded.sampleRate)], { type: "audio/wav" }),
    seconds: Math.round(mono.length / decoded.sampleRate),
  };
}
