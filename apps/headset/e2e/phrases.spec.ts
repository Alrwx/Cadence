import { expect, test, type Page } from "@playwright/test";
import { enterAR, pinch, sent, startScenario, targetCenter } from "./harness.ts";

const lastSent = async (page: Page, type: string) => (await sent(page)).filter((e) => e.type === type).at(-1)?.data;
const hasSaveChip = async (page: Page) =>
  (await page.evaluate(() => window.cadence.targets().map((t) => t.label))).some((l) => l.startsWith("Save to"));

test.beforeEach(async ({ page }, info) => {
  await enterAR(page, info.testId);
  await pinch(page, "Phrases");
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

test("the save chip saves the last reply to the group last opened", async ({ page }) => {
  await pinch(page, "Home");
  await pinch(page, "Back");
  await startScenario(page);
  await pinch(page, "A little tired.");
  await pinch(page, "Save to Home: “A little tired.”");
  await expect.poll(() => lastSent(page, "phrase.save")).toEqual({ text: "A little tired.", groupId: "pg_home" });
});

test("the save chip appears only once a reply is spoken", async ({ page }) => {
  await pinch(page, "Back");
  await startScenario(page);
  await targetCenter(page, "A little tired.");
  expect(await hasSaveChip(page)).toBe(false);
  await pinch(page, "A little tired.");
  await expect.poll(() => hasSaveChip(page)).toBe(true);
});

test("Type my own speaks words from the board", async ({ page }) => {
  await pinch(page, "Back");
  await pinch(page, "Type my own");
  for (const word of ["need", "water"]) await pinch(page, word);
  await pinch(page, "Speak");
  await expect.poll(() => lastSent(page, "compose.submit")).toEqual({ text: "Need water" });
});
