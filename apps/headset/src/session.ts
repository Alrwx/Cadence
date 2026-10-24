// One store and one gateway connection for the headset app.
import { createCadenceStore, GatewayConnection, sessionIdFromUrl } from "@cadence/shared";
import { useStore } from "zustand";
import type { CadenceState } from "@cadence/shared";

export const store = createCadenceStore();

export const connection = new GatewayConnection({
  role: "headset",
  sessionId: sessionIdFromUrl(),
  onEvent: (event) => store.getState().applyEvent(event),
  onStatus: (status) => store.getState().setConnection(status),
});

export const useCadence = <T,>(select: (s: CadenceState) => T): T => useStore(store, select);

/** Text of the last reply the user spoke, so it can be bookmarked as a saved phrase. */
export let lastSpokenText: string | null = null;
export function rememberSpoken(text: string): void {
  lastSpokenText = text;
}
