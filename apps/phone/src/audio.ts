// Mic capture (→ PCM16 16 kHz frames) and clip playback. Both need an AudioContext created inside a user tap.

export class PhoneAudio {
  readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private queue: Promise<void> = Promise.resolve();

  /** Call from the Start button's click handler; browsers block audio until a user gesture. */
  constructor() {
    this.ctx = new AudioContext();
    // Mobile browsers suspend audio when the page is hidden; resume when it comes back.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.ctx.state !== "running") void this.ctx.resume();
    });
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

  /** Plays clips one after another, so back-to-back clips are never dropped or overlapped. */
  enqueue(url: string): Promise<void> {
    const next = this.queue.then(() => this.play(url));
    this.queue = next.catch(() => {}); // one failed clip must not block the ones after it
    return next;
  }

  /** Plays a clip and resolves when it ends. */
  private async play(url: string): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume();
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
