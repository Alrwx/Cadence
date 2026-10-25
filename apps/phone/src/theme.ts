// Light or dark: the saved choice, otherwise the phone's own setting. The script in index.html applies it before
// the first paint; this module keeps it in sync afterwards and lets a screen switch it.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "cadence-theme";
/** The browser's address bar colour for each theme (matches --bg in styles/base.css). */
const BAR: Record<Theme, string> = { light: "#f3f4f1", dark: "#0d1211" };
const system = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function saved(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null; // private mode or blocked storage: the choice just won't be remembered
  }
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[theme]);
  listeners.forEach((notify) => notify());
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // not remembered; still applied for this visit
  }
  // A short fade, only while switching, so colours ease over instead of snapping.
  const root = document.documentElement;
  root.classList.add("theme-fade");
  setTimeout(() => root.classList.remove("theme-fade"), 350);
  apply(theme);
}

/** The current theme, re-rendering whoever asks when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
  );
}

apply(saved() ?? (system.matches ? "dark" : "light"));
// Until the user picks one, follow the phone when its setting changes.
system.addEventListener("change", () => saved() ?? apply(system.matches ? "dark" : "light"));
