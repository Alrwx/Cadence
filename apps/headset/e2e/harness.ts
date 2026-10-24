// Drives the headset app through the window.cadence handles that src/dev/setup.ts exposes.
import type { EventType } from "@cadence/protocol";
import type { CadenceStore } from "@cadence/shared";
import type { Page } from "@playwright/test";
import type { XRStore } from "@react-three/xr";
import type { XRDevice } from "iwer";
import type { useHeadset } from "../src/session.ts";

declare global {
  interface Window {
    cadence: { store: CadenceStore; useHeadset: typeof useHeadset; xrStore: XRStore; emulator: XRDevice };
  }
}

export type Vec3 = { x: number; y: number; z: number };

/** Opens the app on its own mock-gateway session and enters emulated AR. */
export async function enterAR(page: Page, session: string): Promise<void> {
  await page.goto(`/headset/?session=${encodeURIComponent(session)}`);
  await page.waitForFunction(() => window.cadence?.store.getState().connection === "open");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.waitForFunction(() => !!window.cadence.xrStore.getState().session);
}

export function remote(page: Page, method: string, params: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(([m, p]) => window.cadence.emulator.remote.dispatch(m, p), [method, params] as const);
}

export function sent(page: Page): Promise<{ type: EventType; data: unknown }[]> {
  return page.evaluate(() => window.cadence.useHeadset.getState().sent.map(({ type, data }) => ({ type, data })));
}

/** Plays the phone's Start tap, which makes the mock gateway run its scenario. */
export async function startScenario(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Phone: Start" }).click();
}
