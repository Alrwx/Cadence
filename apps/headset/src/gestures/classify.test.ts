import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gestures as cfg } from "../config.ts";
import { classify, GestureDebouncer, type HandJoints } from "./classify.ts";

const wrist = { x: 0, y: 1, z: 0 };
const curled = { x: 0.05, y: 1, z: -0.03 };
const extended = { x: 0, y: 1.17, z: 0 };

const hand = (thumbTip: HandJoints["thumbTip"], tip: HandJoints["indexTip"]): HandJoints => ({
  wrist, thumbTip, indexTip: tip, middleTip: tip, ringTip: tip, pinkyTip: tip,
});

test("classifies thumbs up, thumbs down, open palm", () => {
  assert.equal(classify(hand({ x: 0.03, y: 1.08, z: 0 }, curled)), "thumbsUp");
  assert.equal(classify(hand({ x: 0.03, y: 0.92, z: 0 }, curled)), "thumbsDown");
  assert.equal(classify(hand({ x: 0.1, y: 1.05, z: 0 }, extended)), "openPalm");
  assert.equal(classify(hand({ x: 0.03, y: 1.0, z: 0 }, curled)), null, "fist is not a gesture");
});

test("debouncer needs a hold and respects cooldown", () => {
  const d = new GestureDebouncer();
  assert.equal(d.update("thumbsUp", 0), null);
  assert.equal(d.update("thumbsUp", cfg.holdMs - 1), null);
  assert.equal(d.update("thumbsUp", cfg.holdMs), "thumbsUp");
  assert.equal(d.update("thumbsUp", cfg.holdMs + 10), null, "cooldown");
  assert.equal(d.update(null, cfg.holdMs + 20), null);
});
