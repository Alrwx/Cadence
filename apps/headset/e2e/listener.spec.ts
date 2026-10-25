import { expect, test, type Page } from "@playwright/test";
import { angleFromGaze, enterAR, lookAt, remote, selectedSuggestions, startScenario, targetCenter } from "./harness.ts";

// Presses go through head dwell: the emulated hand ray misses small buttons too often to pinch them reliably.
const REPLY = "A little tired.";
const LISTENER = { x: -0.9, y: 1.5, z: -1.2 };

test.beforeEach(async ({ page }, info) => {
  await enterAR(page, info.testId, "head");
  await startScenario(page);
  await targetCenter(page, REPLY);
});

const labels = (page: Page) => page.evaluate(() => window.cadence.targets().map((t) => t.label));
const replyToYes = async (page: Page) => {
  const [reply, yes] = await Promise.all([targetCenter(page, REPLY), targetCenter(page, "Yes")]);
  return Math.hypot(reply.x - yes.x, reply.y - yes.y, reply.z - yes.z);
};

/** Presses Place listener, then turns to the listener while the countdown runs. */
async function placeListener(page: Page, button: string) {
  await lookAt(page, button);
  await page.waitForFunction(() => window.cadence.useListener.getState().at !== null);
  await remote(page, "look_at", { device: "headset", target: LISTENER });
}

test("after the countdown, the replies float beside where the head looked", async ({ page }) => {
  await placeListener(page, "Place listener");
  // The middle reply sits at the stack's center, layout.listenerSideDeg to the right of the listener.
  await expect.poll(() => angleFromGaze(page, REPLY), { timeout: 5000 }).toBeLessThan(16);
  expect(await angleFromGaze(page, REPLY)).toBeGreaterThan(8);
});

test("a reply beside the listener is selected by dwell", async ({ page }) => {
  await placeListener(page, "Place listener");
  await expect.poll(() => angleFromGaze(page, REPLY), { timeout: 5000 }).toBeLessThan(16);
  await lookAt(page, REPLY);
  await expect.poll(() => selectedSuggestions(page)).toEqual(["sg_2"]);
});

test("Clear in Settings puts the replies back on the panel", async ({ page }) => {
  const onPanel = await replyToYes(page);
  await lookAt(page, "Settings");
  await placeListener(page, "Place");
  await page.waitForFunction(() => window.cadence.useListener.getState().spot !== null);
  await lookAt(page, "Clear");
  await lookAt(page, "Done");
  await expect.poll(() => replyToYes(page)).toBeCloseTo(onPanel, 2);
});

test("Skip hides the prompt", async ({ page }) => {
  await lookAt(page, "Skip");
  await expect.poll(async () => (await labels(page)).includes("Place listener")).toBe(false);
});
