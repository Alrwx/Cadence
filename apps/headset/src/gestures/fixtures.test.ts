// Replays hand recordings captured on the Quest (open the app with ?debug, then Record) through the classifier.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { Recording, RecordingLabel } from "../dev/handRecorder.ts";
import { classify, type Gesture } from "./classify.ts";

const DIR = new URL("../../fixtures/hands/", import.meta.url);
const EXPECTED: Record<RecordingLabel, Gesture | null> = {
  thumbsUp: "thumbsUp",
  thumbsDown: "thumbsDown",
  openPalm: "openPalm",
  relaxed: null,
  pinch: null,
};
/** Share of frames in a gesture recording that must classify as that gesture (the debouncer absorbs the rest). */
const MIN_HIT_RATE = 0.8;
/** Share of frames in a non-gesture recording that must classify as nothing; any slip could speak by mistake. */
const MIN_QUIET_RATE = 0.98;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const rec = JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as Recording;
  const expected = EXPECTED[rec.label];
  test(`${file} classifies as ${expected ?? "nothing"}`, () => {
    const rate = rec.frames.filter((f) => classify(f) === expected).length / rec.frames.length;
    assert.ok(rate >= (expected ? MIN_HIT_RATE : MIN_QUIET_RATE), `${(rate * 100).toFixed(0)}% of ${rec.frames.length} frames`);
  });
}
