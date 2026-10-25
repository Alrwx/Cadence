import { expect, test } from "@playwright/test";
import { enterAR, remote, sent, type Vec3 } from "./harness.ts";

const IN_FRONT: Vec3 = { x: 0.15, y: 1.35, z: -0.35 };

async function holdRightHand(page: Parameters<typeof remote>[0], poseId: string, fingers: number[], palm: number[]) {
  await remote(page, "set_transform", { device: "hand-right", position: IN_FRONT, orientation: { fingers, palm } });
  await remote(page, "set_hand_pose", { device: "hand-right", poseId });
}

const instants = async (page: Parameters<typeof sent>[0]) =>
  (await sent(page)).filter((e) => e.type === "instant").map((e) => (e.data as { phraseId: string }).phraseId);

test.beforeEach(async ({ page }, info) => enterAR(page, info.testId));

test("thumbs-up says yes", async ({ page }) => {
  await holdRightHand(page, "thumbs-up", [0, 0, -1], [-1, 0, 0]);
  await expect.poll(() => instants(page)).toEqual(["yes"]);
});

test("thumbs-down says no", async ({ page }) => {
  await holdRightHand(page, "thumbs-up", [0, 0, -1], [1, 0, 0]);
  await expect.poll(() => instants(page)).toEqual(["no"]);
});

test("open palm toward the listener says wait", async ({ page }) => {
  await holdRightHand(page, "open", [0, 1, 0], [0, 0, -1]);
  await expect.poll(() => instants(page)).toEqual(["wait"]);
});

test("relaxed hands and pinches say nothing", async ({ page }) => {
  await holdRightHand(page, "default", [0, 0, -1], [0, -1, 0]);
  await page.waitForTimeout(1500);
  await holdRightHand(page, "pinch", [0, 1, 0], [0, 0, -1]);
  await page.waitForTimeout(1500);
  expect(await instants(page)).toEqual([]);
});
