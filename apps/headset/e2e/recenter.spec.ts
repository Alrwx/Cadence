import { expect, test } from "@playwright/test";
import { angleFromGaze, enterAR, pinch, remote } from "./harness.ts";

test("Recenter moves the panels in front of a reclined user after a countdown", async ({ page }, info) => {
  await enterAR(page, info.testId);
  // Lying back in bed: head lower and further back, looking almost straight up.
  await remote(page, "set_transform", { device: "headset", position: { x: 0, y: 0.9, z: 0.4 } });
  await remote(page, "look_at", { device: "headset", target: { x: 0, y: 2.9, z: 0.2 } });
  expect(await angleFromGaze(page, "Yes")).toBeGreaterThan(60);

  await pinch(page, "More");
  await pinch(page, "Recenter");
  await page.waitForTimeout(1000);
  expect(await angleFromGaze(page, "Yes"), "still counting down").toBeGreaterThan(60);
  // The panels sit about 30 degrees below the line of sight by design (layout.panelOffset).
  await expect.poll(() => angleFromGaze(page, "Yes"), { timeout: 5000 }).toBeLessThan(45);
});
