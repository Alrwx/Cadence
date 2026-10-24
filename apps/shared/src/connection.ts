// WebSocket client for the gateway: reconnect with backoff, hello on connect, typed send/receive.
import {
  isEventType,
  PROTOCOL_VERSION,
  type CadenceEvent,
  type EventDataMap,
  type EventType,
} from "@cadence/protocol";

export type Role = "headset" | "phone";
export type ConnectionStatus = "connecting" | "open" | "closed";

export interface ConnectionOptions {
  role: Role;
  sessionId: string;
  url?: string;
  clientVersion?: string;
  onEvent: (event: CadenceEvent) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Runs after `hello` on every connect and reconnect, e.g. to re-send state the gateway lost (phone.unlock). */
  onOpen?: () => void;
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

export function gatewayUrl(role: Role, sessionId: string, loc: Pick<Location, "protocol" | "host"> = location): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/ws?role=${role}&session=${encodeURIComponent(sessionId)}`;
}

export function nextBackoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
}

export class GatewayConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: ConnectionOptions) {}

  connect(): void {
    if (this.ws) return; // already connecting or open
    clearTimeout(this.retryTimer);
    this.closedByUser = false;
    this.opts.onStatus?.("connecting");
    const ws = new WebSocket(this.opts.url ?? gatewayUrl(this.opts.role, this.opts.sessionId));
    ws.binaryType = "arraybuffer";
    // Handlers check `this.ws === ws` so a socket we already replaced or closed can't touch the current one
    // (React StrictMode connects, closes, and connects again on mount).
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      // hello goes first so the gateway knows who we are before anything else arrives.
      this.send("hello", { role: this.opts.role, clientVersion: this.opts.clientVersion ?? "0.1.0" });
      this.opts.onStatus?.("open");
      this.opts.onOpen?.();
    };
    ws.onmessage = (msg) => {
      if (this.ws !== ws || typeof msg.data !== "string") return;
      const event = parse(msg.data);
      if (event) this.opts.onEvent(event);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.onStatus?.("closed");
      if (!this.closedByUser) this.retryTimer = setTimeout(() => this.connect(), nextBackoff(this.attempt++));
    };
    this.ws = ws;
  }

  send<T extends EventType>(type: T, data: EventDataMap[T], turnId?: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(
      JSON.stringify({ type, v: PROTOCOL_VERSION, sessionId: this.opts.sessionId, turnId, ts: Date.now(), data }),
    );
    return true;
  }

  /** Phone mic audio: PCM16 mono 16 kHz, one 20 ms chunk per frame. */
  sendAudio(frame: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if (ws) this.opts.onStatus?.("closed");
  }
}

/** Parses one event; unknown types and malformed frames are logged and dropped, never thrown. */
export function parse(raw: string): CadenceEvent | null {
  try {
    const event = JSON.parse(raw) as { type?: unknown; data?: unknown };
    if (typeof event.type !== "string" || !isEventType(event.type) || typeof event.data !== "object") {
      console.warn("ignoring unknown event", event.type);
      return null;
    }
    return event as CadenceEvent;
  } catch (err) {
    console.warn("ignoring malformed event", err);
    return null;
  }
}
