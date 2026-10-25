// A stand-in headset for desktop testing: the same shared client and store the real headset uses,
// connected as role=headset, with every event in and out kept for the log.
import type { CadenceEvent, ErrorData, EventDataMap, EventType } from "@cadence/protocol";
import { createCadenceStore, GatewayConnection, sessionIdFromUrl } from "@cadence/shared";
import { createStore } from "zustand/vanilla";

export interface LogEntry {
  dir: "in" | "out";
  type: string;
  data: unknown;
  at: number;
}

const MAX_LOG = 60;
/** A state change this soon after an error is part of the same failure (e.g. tts_failed, then LISTENING). */
const ERROR_MIN_MS = 1500;

export const store = createCadenceStore();
export const log = createStore<{ entries: LogEntry[] }>()(() => ({ entries: [] }));

/**
 * The error shown on the page. It goes away once it's been dealt with: when the next command is sent (if that one
 * fails too, its own error replaces it), or when the session moves to a new state afterwards (say, "Tap Start
 * first", then Start). The full history stays in the event log.
 */
export const shownError = createStore<{ error: ErrorData | null; at: number }>()(() => ({ error: null, at: 0 }));

export function dismissError(): void {
  shownError.setState({ error: null, at: 0 });
}

function trackError(event: CadenceEvent): void {
  if (event.type === "error") {
    shownError.setState({ error: event.data, at: Date.now() });
  } else if (event.type === "state" && shownError.getState().error) {
    if (Date.now() - shownError.getState().at >= ERROR_MIN_MS) dismissError();
  }
}

function record(entry: Omit<LogEntry, "at">): void {
  log.setState((s) => ({ entries: [...s.entries, { ...entry, at: Date.now() }].slice(-MAX_LOG) }));
}

export const sessionId = sessionIdFromUrl();

export const connection = new GatewayConnection({
  role: "headset",
  sessionId,
  clientVersion: "testbench",
  onEvent: (event: CadenceEvent) => {
    store.getState().applyEvent(event);
    trackError(event);
    record({ dir: "in", type: event.type, data: event.data });
  },
  onStatus: (status) => store.getState().setConnection(status),
});

/** Sends like the headset does, and logs it. Returns false when the socket isn't open. */
export function send<T extends EventType>(type: T, data: EventDataMap[T], turnId?: string): boolean {
  const ok = connection.send(type, data, turnId);
  if (ok) dismissError(); // a new command went out: the last error has been acted on
  record({ dir: "out", type: ok ? type : `${type} (not sent: offline)`, data });
  return ok;
}
