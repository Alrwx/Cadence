// Per-user settings, kept on the headset (localStorage).
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { selection } from "./config.ts";

export type InputMode = "hands" | "head" | "both";

interface Settings {
  inputMode: InputMode;
  dwellMs: number;
  /** Opaque buttons instead of see-through glass. */
  solidPanels: boolean;
}

// Hands by default: with head selection on, merely looking down to read the panel rests the reticle on a
// button and speaks it. Turn head selection on in Settings, or preset it for a bedside setup with ?input=head.
export const useSettings = create<Settings>()(
  persist((): Settings => ({ inputMode: "hands", dwellMs: selection.dwellMs, solidPanels: false }), {
    name: "cadence-settings",
    storage: createJSONStorage(() => localStorage),
  }),
);

const fromUrl = new URLSearchParams(location.search).get("input");
if (fromUrl === "hands" || fromUrl === "head" || fromUrl === "both") useSettings.setState({ inputMode: fromUrl });

export const handsEnabled = (mode: InputMode) => mode !== "head";
export const headEnabled = (mode: InputMode) => mode !== "hands";
