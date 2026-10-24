// Mic capture (→ PCM16 16 kHz frames) and clip playback. Both need an AudioContext created inside a user tap.

const FETCH_TIMEOUT_MS = 10_000;
const PLAYBACK_MARGIN_MS = 3_000;

export class PhoneAudio {
  readonly ctx: AudioContext;
  private queue: Promise<void> = Promise.resolve();

  /** Call from the Start button's click handler; browsers block audio until a user gesture. */
  constructor() {
    this.ctx = new AudioContext();
    // Mobile browsers suspend audio when the page is hidden; resume when it comes back.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.ctx.state !== "running") void this.ctx.resume();
    });
  }

  /** Starts the mic. If the browser later ends the track, restarts it once the page is visible; onError gets a failed restart. */
  async startMic(onFrame: (frame: ArrayBuffer) => void, onError: (err: unknown) => void): Promise<void> {
    await this.ctx.resume();
    // getUserMedia needs a secure (HTTPS) origin.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    await this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm16-worklet.js`);
    const source = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, "pcm16-downsampler");
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onFrame(e.data);
    source.connect(node);
    // Not connected to the destination: we never want to hear the mic through the speaker.

    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      source.disconnect();
      node.port.onmessage = null;
      whenVisible(() => this.startMic(onFrame, onError).catch(onError));
    });
  }

  /**
   * Plays clips one after another, so back-to-back clips are never dropped or overlapped.
   * Each clip is fetched as soon as it's enqueued; onStart runs when its turn to play comes.
   */
  enqueue(url: string, onStart: () => void): Promise<void> {
    const loaded = this.load(url);
    loaded.catch(() => {}); // reported through `next`; this only avoids an unhandled rejection while queued
    const next = this.queue
      .then(() => loaded)
      .then((buffer) => {
        onStart();
        return this.playBuffer(buffer);
      });
    this.queue = next.catch(() => {}); // one failed clip must not block the ones after it
    return next;
  }

  private async load(url: string): Promise<AudioBuffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`clip ${url}: ${res.status}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  /** Resolves when the clip ends; rejects if it hasn't ended a few seconds after it should have. */
  private playBuffer(buffer: AudioBuffer): Promise<void> {
    if (this.ctx.state !== "running") void this.ctx.resume();
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    return new Promise((resolve, reject) => {
      // A suspended AudioContext (iOS in the background) never fires onended.
      const watchdog = setTimeout(() => {
        node.onended = null;
        node.stop();
        reject(new Error("clip playback stalled"));
      }, buffer.duration * 1000 + PLAYBACK_MARGIN_MS);
      node.onended = () => {
        clearTimeout(watchdog);
        resolve();
      };
      node.start();
    });
  }
}

function whenVisible(run: () => void): void {
  if (document.visibilityState === "visible") return run();
  const onChange = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onChange);
    run();
  };
  document.addEventListener("visibilitychange", onChange);
}
