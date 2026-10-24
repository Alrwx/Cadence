import { expect, test, type Page } from "@playwright/test";
import { enterAR, lookAt, remote, sent, startScenario, targetCenter } from "./harness.ts";

// Presses go through head dwell: the emulated hand ray misses small buttons too often to pinch them reliably.
// The mock gateway starts every session without store_chat consent and with one memory, mem_visit.
test.beforeEach(async ({ page }, info) => {
  await enterAR(page, info.testId, "head");
});

const sentData = async (page: Page, type: string) => (await sent(page)).filter((e) => e.type === type).map((e) => e.data);
const labels = (page: Page) => page.evaluate(() => window.cadence.targets().map((t) => t.label));
const notice = (page: Page) => page.evaluate(() => window.cadence.useView.getState().notice);
/** A dwell fires once per visit, so pressing the same button again means looking away first. */
const lookAway = (page: Page) => remote(page, "look_at", { device: "headset", target: { x: 0, y: 3, z: -1 } });

/** Lets the scenario say something, so the mock has a line from the last minute to remember. */
async function hearSomething(page: Page) {
  await startScenario(page);
  await page.waitForFunction(() => window.cadence.store.getState().captions.length > 0);
}

async function allowAndRemember(page: Page) {
  await lookAt(page, "Remember this");
  await lookAt(page, "Allow and remember");
}

/** Waits until the Conversations tab is gone: both tabs have Delete and Back buttons. */
async function openMemories(page: Page) {
  await lookAt(page, "Conversations");
  await lookAt(page, "Memories");
  await expect.poll(async () => (await labels(page)).includes("Attach")).toBe(false);
}

test("without consent, Remember this asks first, and allowing sends the consent before the save", async ({ page }) => {
  await hearSomething(page);
  await allowAndRemember(page);
  await expect
    .poll(async () => (await sent(page)).filter((e) => e.type === "consent.set" || e.type === "memory.save"))
    .toEqual([
      { type: "consent.set", data: { kind: "store_chat", granted: true } },
      { type: "memory.save", data: {} },
    ]);
});

test("the new memory is announced and listed", async ({ page }) => {
  await hearSomething(page);
  await allowAndRemember(page);
  await expect.poll(async () => (await notice(page))?.text).toBe("Remembered: “How are you feeling today?”");
  await openMemories(page);
  await expect.poll(async () => (await labels(page)).filter((l) => l === "Delete").length).toBe(2);
});

test("Undo deletes the memory just saved", async ({ page }) => {
  await hearSomething(page);
  await allowAndRemember(page);
  await lookAt(page, "Undo");
  await expect.poll(() => sentData(page, "memory.delete")).toEqual([{ memoryId: expect.stringMatching(/^mem_(?!visit)/) }]);
});

test("deleting a memory takes a second press", async ({ page }) => {
  await openMemories(page);
  await lookAt(page, "Delete");
  await targetCenter(page, "Really delete?");
  await page.waitForTimeout(1200);
  expect(await sentData(page, "memory.delete")).toEqual([]);
  await lookAway(page);
  await lookAt(page, "Really delete?");
  await expect.poll(() => sentData(page, "memory.delete")).toEqual([{ memoryId: "mem_visit" }]);
  await expect.poll(async () => (await labels(page)).includes("Delete")).toBe(false);
});

test("turning Save memories off takes a second press and deletes every memory", async ({ page }) => {
  await lookAt(page, "Settings");
  await lookAt(page, "On");
  await expect.poll(() => sentData(page, "consent.set")).toEqual([{ kind: "store_chat", granted: true }]);
  await lookAt(page, "Off");
  await targetCenter(page, "Delete all?");
  await page.waitForTimeout(1200);
  expect(await sentData(page, "consent.set")).toHaveLength(1);
  await lookAway(page);
  await lookAt(page, "Delete all?");
  await expect.poll(async () => (await sentData(page, "consent.set")).at(-1)).toEqual({ kind: "store_chat", granted: false });
  await lookAt(page, "Done");
  await openMemories(page);
  expect(await labels(page)).not.toContain("Delete");
});

test("the gateway's rejection shows in the status line", async ({ page }) => {
  await allowAndRemember(page);
  await expect.poll(() => notice(page)).toEqual({ text: "Nothing to remember from the last minute.", tone: "error" });
});
