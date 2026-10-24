// Mic capture (→ PCM16 16 kHz frames) and clip playback. Both need an AudioContext created inside a user tap.

export class PhoneAudio {
  readonly ctx: AudioContext;
  private stream: MediaStream | null = null;

  /** Call from the Start button's click handler; browsers block audio until a user gesture. */
  constructor() {
    this.ctx = new AudioContext();
  }

  async startMic(onFrame: (frame: ArrayBuffer) => void): Promise<void> {
    await this.ctx.resume();
    // getUserMedia needs a secure (HTTPS) origin.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    await this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm16-worklet.js`);
    const source = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, "pcm16-downsampler");
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onFrame(e.data);
    source.connect(node);
    // Not connected to the destination: we never want to hear the mic through the speaker.
  }

  /** Plays a clip and resolves when it ends. */
  async play(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`clip ${url}: ${res.status}`);
    const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    await new Promise<void>((resolve) => {
      node.onended = () => resolve();
      node.start();
    });
  }
}
