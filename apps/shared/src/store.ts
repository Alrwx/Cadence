// Client state shared by the headset and phone apps. Every gateway event goes through applyEvent.
import type { AudioPlayData, CadenceEvent, ErrorData, PhrasesGroup, StateData, SuggestionsItem } from "@cadence/protocol";
import { createStore } from "zustand/vanilla";
import type { ConnectionStatus } from "./connection.ts";

export type SessionState = StateData["state"];

export interface CadenceState {
  connection: ConnectionStatus;
  state: SessionState;
  turnId: string | undefined;
  partial: string;
  captions: string[];
  suggestions: SuggestionsItem[];
  phraseGroups: PhrasesGroup[];
  nowPlaying: AudioPlayData | null;
  lastError: ErrorData | null;
  setConnection: (status: ConnectionStatus) => void;
  applyEvent: (event: CadenceEvent) => void;
}

const MAX_CAPTIONS = 20;

export const createCadenceStore = () =>
  createStore<CadenceState>()((set) => ({
    connection: "connecting",
    state: "IDLE",
    turnId: undefined,
    partial: "",
    captions: [],
    suggestions: [],
    phraseGroups: [],
    nowPlaying: null,
    lastError: null,
    setConnection: (connection) => set({ connection }),
    applyEvent: (event) =>
      set((s) => {
        switch (event.type) {
          case "state":
            return { state: event.data.state, turnId: event.turnId ?? s.turnId };
          case "transcript.partial":
            return { partial: event.data.text };
          case "transcript.final":
            return { partial: "", captions: [...s.captions, event.data.text].slice(-MAX_CAPTIONS) };
          case "suggestions":
            // Suggestions for an older turn are stale; drop them.
            if (event.turnId && s.turnId && event.turnId !== s.turnId) return {};
            return { suggestions: event.data.items, turnId: event.turnId ?? s.turnId };
          case "suggestion.audioReady":
            return {
              suggestions: s.suggestions.map((it) => (it.id === event.data.id ? { ...it, audioReady: true } : it)),
            };
          case "phrases":
            return { phraseGroups: event.data.groups };
          case "audio.play":
            return { nowPlaying: event.data };
          case "error":
            return { lastError: event.data };
          default:
            return {};
        }
      }),
  }));

export type CadenceStore = ReturnType<typeof createCadenceStore>;
