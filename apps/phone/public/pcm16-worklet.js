// AudioWorklet: downsample mic input to 16 kHz mono PCM16 and post one 20 ms chunk (320 samples) at a time.
// Plain JS in public/ because audioWorklet.addModule loads it as a separate script.
const TARGET_RATE = 16000;
const CHUNK = 320; // 20 ms at 16 kHz

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0; // fractional read position into the incoming stream
    this.out = new Int16Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Average the input samples that fall into each output sample (simple low-pass + decimate).
    while (this.pos < input.length) {
      const start = Math.floor(this.pos);
      const end = Math.min(input.length, Math.floor(this.pos + this.ratio));
      let sum = 0;
      for (let i = start; i < Math.max(end, start + 1); i++) sum += input[i];
      const sample = sum / Math.max(1, end - start);
      this.out[this.filled++] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(CHUNK);
        this.filled = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
