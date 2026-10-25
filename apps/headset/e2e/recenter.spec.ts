import { expect, test } from "@playwright/test";
import { Quaternion, Vector3 } from "three";
import { enterAR, pinch, remote, targetCenter, type Vec3 } from "./harness.ts";

/** Angle in degrees between where the head looks and the direction from the head to a button. */
async function angleFromGaze(page: Parameters<typeof remote>[0], label: string): Promise<number> {
  const head = (await remote(page, "get_transform", { device: "headset" })) as {
    position: Vec3;
    orientation: { x: number; y: number; z: number; w: number };
  };
  const { x, y, z, w } = head.orientation;
  const gaze = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(x, y, z, w));
  const toButton = new Vector3().copy(await targetCenter(page, label)).sub(new Vector3().copy(head.position));
  return (gaze.angleTo(toButton) * 180) / Math.PI;
}

test("Recenter moves the panels in front of a reclined user after a countdown", async ({ page }, info) => {
  await enterAR(page, info.testId);
  // Lying back in bed: head lower and further back, looking almost straight up.
  await remote(page, "set_transform", { device: "headset", position: { x: 0, y: 0.9, z: 0.4 } });
  await remote(page, "look_at", { device: "headset", target: { x: 0, y: 2.9, z: 0.2 } });
  expect(await angleFromGaze(page, "Yes")).toBeGreaterThan(60);

  await pinch(page, "Recenter");
  await page.waitForTimeout(1000);
  expect(await angleFromGaze(page, "Yes"), "still counting down").toBeGreaterThan(60);
  // The panels sit about 30 degrees below the line of sight by design (layout.panelOffset).
  await expect.poll(() => angleFromGaze(page, "Yes"), { timeout: 5000 }).toBeLessThan(45);
});
