// Drives the headset app through the window.cadence handles that src/dev/setup.ts exposes.
import type { EventType } from "@cadence/protocol";
import type { CadenceStore } from "@cadence/shared";
import type { Page } from "@playwright/test";
import type { XRStore } from "@react-three/xr";
import type { XRDevice } from "iwer";
import type { useHeadset } from "../src/session.ts";
import type { useRecenter } from "../src/layout/UIAnchor.tsx";
import type { InputMode, useSettings } from "../src/settings.ts";
import type { useView } from "../src/ui/views.ts";

declare global {
  interface Window {
    cadence: {
      store: CadenceStore;
      useHeadset: typeof useHeadset;
      useSettings: typeof useSettings;
      useRecenter: typeof useRecenter;
      useView: typeof useView;
      xrStore: XRStore;
      emulator: XRDevice;
      targets: () => { label: string; center: Vec3 }[];
    };
  }
}

export type Vec3 = { x: number; y: number; z: number };

/** Opens the app on its own mock-gateway session, enters emulated AR, and waits for the UI to settle in front of the head. */
export async function enterAR(page: Page, session: string, input: InputMode = "hands"): Promise<void> {
  await page.goto(`/headset/?session=${encodeURIComponent(session)}&input=${input}`);
  await page.waitForFunction(() => window.cadence?.store.getState().connection === "open");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.waitForFunction(() => !!window.cadence.xrStore.getState().session);
  await page.waitForFunction(() => window.cadence.useRecenter.getState().at === null);
}

export function remote(page: Page, method: string, params: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(([m, p]) => window.cadence.emulator.remote.dispatch(m, p), [method, params] as const);
}

export function sent(page: Page): Promise<{ type: EventType; data: unknown }[]> {
  return page.evaluate(() => window.cadence.useHeadset.getState().sent.map(({ type, data }) => ({ type, data })));
}

/** Plays the phone's Start tap, which makes the mock gateway run its scenario. */
export async function startScenario(page: Page): Promise<void> {
  // The emulated XR view covers the page once a session starts, so click the HUD button directly.
  await page.getByRole("button", { name: "Phone: Start" }).dispatchEvent("click");
}

export async function targetCenter(page: Page, label: string): Promise<Vec3> {
  await page.waitForFunction((l) => window.cadence.targets().some((t) => t.label === l), label);
  return page.evaluate((l) => {
    const { x, y, z } = window.cadence.targets().find((t) => t.label === l)!.center;
    return { x, y, z };
  }, label);
}

export async function lookAt(page: Page, label: string): Promise<void> {
  await remote(page, "look_at", { device: "headset", target: await targetCenter(page, label) });
}

/** Points the right hand's ray at a button from a comfortable spot in front of the user, then pinches. */
export async function pinch(page: Page, label: string, holdSeconds = 0.2): Promise<void> {
  const target = await targetCenter(page, label);
  // look_at aims a hand's target ray, which starts near the shoulder and isn't parallel to the fingers.
  await remote(page, "set_transform", { device: "hand-right", position: { x: 0.15, y: 1.25, z: -0.2 } });
  await remote(page, "look_at", { device: "hand-right", target });
  // Pointer hits come from the ray of earlier frames, so pinching in the frame that aims can miss.
  await waitFrames(page, 3);
  await remote(page, "select", { device: "hand-right", duration: holdSeconds });
}

export async function selectedSuggestions(page: Page): Promise<string[]> {
  return (await sent(page)).filter((e) => e.type === "select").map((e) => (e.data as { suggestionId: string }).suggestionId);
}

/** Waits for XR frames rather than wall-clock time: software-rendered emulators can drop to a few fps. */
export function waitFrames(page: Page, count: number): Promise<void> {
  return page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        const session = window.cadence.xrStore.getState().session!;
        let seen = 0;
        const tick = () => (++seen >= n ? resolve() : session.requestAnimationFrame(tick));
        session.requestAnimationFrame(tick);
      }),
    count,
  );
}
