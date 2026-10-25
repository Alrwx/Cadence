// A stand-in headset for desktop testing: the same shared client and store the real headset uses,
// connected as role=headset, with every event in and out kept for the log.
import type { CadenceEvent, EventDataMap, EventType } from "@cadence/protocol";
import { createCadenceStore, GatewayConnection, sessionIdFromUrl } from "@cadence/shared";
import { createStore } from "zustand/vanilla";

export interface LogEntry {
  dir: "in" | "out";
  type: string;
  data: unknown;
  at: number;
}

const MAX_LOG = 60;

export const store = createCadenceStore();
export const log = createStore<{ entries: LogEntry[] }>()(() => ({ entries: [] }));

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
    record({ dir: "in", type: event.type, data: event.data });
  },
  onStatus: (status) => store.getState().setConnection(status),
});

/** Sends like the headset does, and logs it. Returns false when the socket isn't open. */
export function send<T extends EventType>(type: T, data: EventDataMap[T], turnId?: string): boolean {
  const ok = connection.send(type, data, turnId);
  record({ dir: "out", type: ok ? type : `${type} (not sent: offline)`, data });
  return ok;
}
