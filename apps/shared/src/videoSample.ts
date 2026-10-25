// Turns a picked video into a voice sample: only the audio, only the first ~30 s, as a small mono WAV.
// A phone video is easily larger than the 25 MB upload cap; 30 s of 24 kHz mono PCM16 is about 1.4 MB.

/** How much of a video's audio is kept. Matches the longest recording the phone takes. */
export const VIDEO_SAMPLE_SECONDS = 30;

/** Qwen3-TTS works at 24 kHz, so decoding straight to it means the model service never resamples. */
export const VIDEO_SAMPLE_RATE = 24000;

/** Mixes channels down to mono and keeps at most the first maxSeconds. */
export function trimToMono(channels: Float32Array[], sampleRate: number, maxSeconds: number): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const length = Math.min(channels[0]!.length, Math.floor(maxSeconds * sampleRate));
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i]! += channel[i]! / channels.length;
  }
  return mono;
}

/** Encodes mono float samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return bytes;
}
