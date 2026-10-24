// Per-user settings, kept on the headset (localStorage).
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { selection } from "./config.ts";

export type InputMode = "hands" | "head" | "both";

interface Settings {
  inputMode: InputMode;
  dwellMs: number;
}

export const useSettings = create<Settings>()(
  persist((): Settings => ({ inputMode: "both", dwellMs: selection.dwellMs }), {
    name: "cadence-settings",
    storage: createJSONStorage(() => localStorage),
  }),
);

export const handsEnabled = (mode: InputMode) => mode !== "head";
export const headEnabled = (mode: InputMode) => mode !== "hands";
