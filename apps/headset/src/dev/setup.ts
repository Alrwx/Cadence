// Dev server only, before the app renders.
import { store, useHeadset } from "../session.ts";
import { xrStore } from "../xr.ts";
import { installEmulator } from "./emulator.ts";
import { forwardConsole } from "./remoteConsole.ts";

export async function setupDev(): Promise<void> {
  forwardConsole();
  const emulator = await installEmulator();
  // Handles for poking at the app from the browser console and from the end-to-end tests.
  Object.assign(window, { cadence: { store, useHeadset, xrStore, emulator } });
}
