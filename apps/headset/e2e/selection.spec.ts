import { expect, test } from "@playwright/test";
import { enterAR, lookAt, pinch, remote, selectedSuggestions, startScenario, targetCenter } from "./harness.ts";

const REPLY = "A little tired.";

test.beforeEach(async ({ page }, info) => {
  await enterAR(page, info.testId);
  await startScenario(page);
  await targetCenter(page, REPLY);
});

test("holding the head on a reply selects it after the dwell, once", async ({ page }) => {
  await lookAt(page, REPLY);
  await page.waitForTimeout(400);
  expect(await selectedSuggestions(page)).toEqual([]);
  await expect.poll(() => selectedSuggestions(page)).toEqual(["sg_2"]);
  await page.waitForTimeout(1500);
  expect(await selectedSuggestions(page)).toEqual(["sg_2"]);
});

test("sweeping the head across the replies selects nothing", async ({ page }) => {
  const left = await targetCenter(page, "Better than yesterday, thanks.");
  const right = await targetCenter(page, "Is the doctor coming today?");
  await remote(page, "look_at", { device: "headset", target: { ...left, x: left.x - 0.4 } });
  for (const target of [{ ...right, x: right.x + 0.4 }, { ...left, x: left.x - 0.4 }]) {
    const { orientation } = (await remote(page, "look_at", { device: "headset", target })) as { orientation: object };
    await remote(page, "look_at", { device: "headset", target: { ...left, x: left.x - 0.4 } });
    await remote(page, "animate_to", { device: "headset", orientation, duration: 0.6 });
    await page.waitForTimeout(700);
  }
  expect(await selectedSuggestions(page)).toEqual([]);
});

test("pinching a reply selects it", async ({ page }) => {
  await pinch(page, REPLY);
  await expect.poll(() => selectedSuggestions(page)).toEqual(["sg_2"]);
});

test("head-only mode ignores pinches but still selects by looking", async ({ page }) => {
  await page.evaluate(() => window.cadence.useSettings.setState({ inputMode: "head" }));
  await pinch(page, REPLY);
  await page.waitForTimeout(1000);
  expect(await selectedSuggestions(page)).toEqual([]);
  await lookAt(page, REPLY);
  await expect.poll(() => selectedSuggestions(page)).toEqual(["sg_2"]);
});

test("looking at Hands in Settings does not switch to hands-only", async ({ page }) => {
  await lookAt(page, "Settings");
  await lookAt(page, "Hands");
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.cadence.useSettings.getState().inputMode)).toBe("both");
  await lookAt(page, "Head");
  await expect.poll(() => page.evaluate(() => window.cadence.useSettings.getState().inputMode)).toBe("head");
});
