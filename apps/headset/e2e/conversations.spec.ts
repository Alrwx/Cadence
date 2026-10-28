import { expect, test, type Page } from "@playwright/test";
import { enterAR, lookAt, lookAway, sent, targetCenter } from "./harness.ts";

// Presses go through head dwell: the emulated hand ray misses small buttons too often to pinch them reliably.
// The mock gateway starts every session with one saved conversation, cv_lee.
test.beforeEach(async ({ page }, info) => {
  await enterAR(page, info.testId, "head");
  await lookAt(page, "More");
  await lookAt(page, "Conversations");
  await targetCenter(page, "Attach");
});

const sentData = async (page: Page, type: string) => (await sent(page)).filter((e) => e.type === type).map((e) => e.data);
const labels = (page: Page) => page.evaluate(() => window.cadence.targets().map((t) => t.label));

test("saving sends a dated label and the new conversation is listed", async ({ page }) => {
  await lookAt(page, "Doctor");
  await expect.poll(() => sentData(page, "conversation.save")).toEqual([{ label: expect.stringMatching(/^Doctor – \w+ \d+$/) }]);
  await expect.poll(async () => (await labels(page)).filter((l) => l === "Attach").length).toBe(2);
});

test("attach and detach each send the whole attached set", async ({ page }) => {
  await lookAt(page, "Attach");
  await expect.poll(() => sentData(page, "conversation.attach")).toEqual([{ conversationIds: ["cv_lee"] }]);
  await lookAway(page);
  await lookAt(page, "Attached");
  await expect
    .poll(() => sentData(page, "conversation.attach"))
    .toEqual([{ conversationIds: ["cv_lee"] }, { conversationIds: [] }]);
});

test("deleting takes a second press", async ({ page }) => {
  await lookAt(page, "Delete");
  await targetCenter(page, "Really delete?");
  await page.waitForTimeout(1200);
  expect(await sentData(page, "conversation.delete")).toEqual([]);
  await lookAway(page);
  await lookAt(page, "Really delete?");
  await expect.poll(() => sentData(page, "conversation.delete")).toEqual([{ conversationId: "cv_lee" }]);
  await expect.poll(async () => (await labels(page)).includes("Attach")).toBe(false);
});

test("Back leads home", async ({ page }) => {
  await lookAt(page, "Back");
  await expect.poll(async () => (await labels(page)).includes("Phrases")).toBe(true);
  expect(await labels(page)).not.toContain("Back");
});

test("Conversation shift resets in one press and detaches what was attached", async ({ page }) => {
  await lookAt(page, "Attach");
  await targetCenter(page, "Attached");
  await lookAt(page, "Back");
  await lookAt(page, "More");
  await lookAt(page, "Conversation shift");
  await expect.poll(() => sentData(page, "conversation.reset")).toEqual([{}]);
  await lookAt(page, "More");
  await lookAt(page, "Conversations");
  await targetCenter(page, "Attach");
  expect(await labels(page)).not.toContain("Attached");
});
