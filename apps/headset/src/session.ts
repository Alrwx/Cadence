// One store and one gateway connection for the headset app.
import { createCadenceStore, GatewayConnection, sessionIdFromUrl } from "@cadence/shared";
import type { CadenceState } from "@cadence/shared";
import type { EventDataMap, EventType } from "@cadence/protocol";
import { create, useStore } from "zustand";
import { receiveConversations } from "./conversations.ts";

export const store = createCadenceStore();

export const connection = new GatewayConnection({
  role: "headset",
  sessionId: sessionIdFromUrl(),
  onEvent: (event) => {
    store.getState().applyEvent(event);
    if (event.type === "conversations") receiveConversations(event.data.items);
  },
  onStatus: (status) => store.getState().setConnection(status),
});

export const useCadence = <T,>(select: (s: CadenceState) => T): T => useStore(store, select);

export interface SentEvent {
  type: EventType;
  data: unknown;
  at: number;
  delivered: boolean;
}

interface HeadsetState {
  /** Text of the last reply or typed message the user spoke, so it can be bookmarked as a saved phrase. */
  lastSpoken: string | null;
  /** What the user last chose to say, shown while the phone speaks it. */
  speaking: string | null;
  /** Recent outgoing events, for the debug views and end-to-end tests. */
  sent: SentEvent[];
}

export const useHeadset = create<HeadsetState>(() => ({ lastSpoken: null, speaking: null, sent: [] }));

const MAX_SENT = 50;

export function send<T extends EventType>(type: T, data: EventDataMap[T], turnId?: string): void {
  const delivered = connection.send(type, data, turnId);
  useHeadset.setState((s) => ({ sent: [...s.sent, { type, data, at: Date.now(), delivered }].slice(-MAX_SENT) }));
}

/** Records a choice to speak; only replies and typed messages are worth bookmarking. */
export function rememberSpeech(text: string, bookmarkable: boolean): void {
  useHeadset.setState((s) => ({ speaking: text, lastSpoken: bookmarkable ? text : s.lastSpoken }));
}
