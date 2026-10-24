import { strict as assert } from "node:assert";
import { test } from "node:test";
import { angularMiss, DwellTracker, pickTarget, type Rect, type Vec3 } from "./dwell.ts";

const HEAD: Vec3 = { x: 0, y: 1.6, z: 0 };
const FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
const DEG = Math.PI / 180;

/** A 0.3 x 0.1 m button 1 m in front of the head, facing it, offset by (x, y). */
const button = (x: number, y: number): Rect => ({
  center: { x, y: 1.6 + y, z: -1 },
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  halfWidth: 0.15,
  halfHeight: 0.05,
});

const towards = (yawDeg: number, pitchDeg = 0): Vec3 => ({
  x: Math.sin(yawDeg * DEG) * Math.cos(pitchDeg * DEG),
  y: Math.sin(pitchDeg * DEG),
  z: -Math.cos(yawDeg * DEG) * Math.cos(pitchDeg * DEG),
});

test("a ray through the button misses by nothing; one beside it misses by the gap's angle", () => {
  assert.equal(angularMiss(HEAD, FORWARD, button(0, 0)), 0);
  const gap = Math.tan(10 * DEG) - 0.15;
  assert.ok(Math.abs(angularMiss(HEAD, towards(10), button(0, 0)) - Math.atan2(gap, 1)) < 1e-3);
  assert.equal(angularMiss(HEAD, { x: 0, y: 0, z: 1 }, button(0, 0)), Infinity, "behind the head");
});

test("pickTarget prefers a hit, snaps to a near miss, and ignores far misses", () => {
  const targets: [string, Rect][] = [
    ["left", button(-0.4, 0)],
    ["right", button(0.4, 0)],
  ];
  assert.equal(pickTarget(HEAD, towards(Math.atan2(0.4, 1) / DEG), targets, 3 * DEG), "right");
  // 2 cm past the right button's outer edge at 1 m is about 1.1 degrees: inside a 3 degree snap.
  assert.equal(pickTarget(HEAD, towards(Math.atan2(0.57, 1) / DEG), targets, 3 * DEG), "right");
  assert.equal(pickTarget(HEAD, FORWARD, targets, 3 * DEG), null, "the gap between the buttons is too wide to snap");
});

const OPTS = { dwellMs: 800, maxHeadSpeed: 60 * DEG };

test("holding on a target fires once after the dwell time", () => {
  const d = new DwellTracker();
  assert.deepEqual(d.update("a", FORWARD, 0, OPTS), { hover: "a", progress: 0, fired: null });
  assert.equal(d.update("a", FORWARD, 400, OPTS).progress, 0.5);
  assert.equal(d.update("a", FORWARD, 800, OPTS).fired, "a");
  assert.equal(d.update("a", FORWARD, 2000, OPTS).fired, null, "staying on it does not fire again");
});

test("leaving and coming back starts over and can fire again", () => {
  const d = new DwellTracker();
  d.update("a", FORWARD, 0, OPTS);
  d.update("a", FORWARD, 800, OPTS);
  d.update(null, FORWARD, 900, OPTS);
  d.update("a", FORWARD, 1000, OPTS);
  assert.equal(d.update("a", FORWARD, 1700, OPTS).fired, null);
  assert.equal(d.update("a", FORWARD, 1800, OPTS).fired, "a");
});

test("a fast head turn restarts the dwell", () => {
  const d = new DwellTracker();
  d.update("a", towards(0), 0, OPTS);
  d.update("a", towards(0), 700, OPTS);
  // 10 degrees in 50 ms is 200 degrees per second.
  assert.equal(d.update("a", towards(10), 750, OPTS).progress, 0);
  assert.equal(d.update("a", towards(10), 1500, OPTS).fired, null);
  assert.equal(d.update("a", towards(10), 1550, OPTS).fired, "a");
});
