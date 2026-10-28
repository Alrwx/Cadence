import { expect, test } from "@playwright/test";
import { enterAR, lookAt, sent } from "./harness.ts";

// The mock gateway starts every session without store_chat consent, so the app asks as soon as it hears that.
test("consent is asked at start, and Allow turns it on without saving a memory", async ({ page }, info) => {
  await enterAR(page, info.testId, "head", { keepConsentPrompt: true });
  await expect.poll(() => page.evaluate(() => window.cadence.useView.getState().view)).toEqual({ kind: "consent", atStart: true });
  await lookAt(page, "Allow");
  await expect.poll(() => page.evaluate(() => window.cadence.useView.getState().view.kind)).toBe("main");
  const consentAndMemory = (await sent(page)).filter((e) => e.type === "consent.set" || e.type === "memory.save");
  expect(consentAndMemory).toEqual([{ type: "consent.set", data: { kind: "store_chat", granted: true } }]);
});
