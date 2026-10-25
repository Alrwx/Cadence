// Dev server only, before the app renders.
import { Vector3 } from "three";
import { useConsent } from "../consent.ts";
import { useListener } from "../layout/ListenerAnchor.tsx";
import { useRecenter } from "../layout/UIAnchor.tsx";
import { dwellTargets } from "../selection/targets.ts";
import { store, useHeadset } from "../session.ts";
import { useSettings } from "../settings.ts";
import { useView } from "../ui/views.ts";
import { xrStore } from "../xr.ts";
import { installEmulator } from "./emulator.ts";
import { forwardConsole } from "./remoteConsole.ts";

export async function setupDev(): Promise<void> {
  forwardConsole();
  const emulator = await installEmulator();
  // Handles for poking at the app from the browser console and from the end-to-end tests.
  Object.assign(window, {
    cadence: {
      store,
      useHeadset,
      useSettings,
      useRecenter,
      useConsent,
      useListener,
      useView,
      xrStore,
      emulator,
      /** Every pressable button: its label and world-space center. */
      targets: () =>
        [...dwellTargets.values()].map((t) => ({ label: t.label, center: t.object.getWorldPosition(new Vector3()) })),
    },
  });
}
