import { expect, test } from "@playwright/test";
import { enterAR, pinch, sent, startScenario } from "./harness.ts";

const lastSent = async (page: Parameters<typeof sent>[0], type: string) => (await sent(page)).filter((e) => e.type === type).at(-1)?.data;

test.beforeEach(async ({ page }, info) => {
  await enterAR(page, info.testId);
  await pinch(page, "Saved phrases");
});

test("a saved phrase speaks in one pinch", async ({ page }) => {
  await pinch(page, "I'm in pain");
  await expect.poll(() => lastSent(page, "phrase.speak")).toEqual({ phraseId: "ph_pain" });
});

test("Edit first opens the phrase in the keyboard, and the edit is spoken as typed", async ({ page }) => {
  await pinch(page, "Edit first");
  await pinch(page, "I'm in pain");
  await pinch(page, "please");
  await pinch(page, "Speak");
  await expect.poll(() => lastSent(page, "compose.submit")).toEqual({ text: "I'm in pain please" });
  expect(await lastSent(page, "phrase.speak")).toBeUndefined();
});

test("the last reply is bookmarked to the group last opened", async ({ page }) => {
  await pinch(page, "Home");
  await pinch(page, "Back");
  await startScenario(page);
  await pinch(page, "A little tired.");
  await pinch(page, "Bookmark last reply");
  await expect.poll(() => lastSent(page, "phrase.save")).toEqual({ text: "A little tired.", groupId: "pg_home" });
});

test("Type my own speaks words from the board", async ({ page }) => {
  await pinch(page, "Back");
  await pinch(page, "Type my own");
  for (const word of ["need", "water"]) await pinch(page, word);
  await pinch(page, "Speak");
  await expect.poll(() => lastSent(page, "compose.submit")).toEqual({ text: "Need water" });
});
