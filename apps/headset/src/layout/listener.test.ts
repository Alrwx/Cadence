import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Euler, Quaternion, Vector3 } from "three";
import { layout } from "../config.ts";
import { listenerSpot } from "./listener.ts";

const DEG = Math.PI / 180;
const head = (pitchDeg: number, yawDeg: number, rollDeg = 0) => ({
  position: new Vector3(0.1, 1.2, 0.3),
  quaternion: new Quaternion().setFromEuler(new Euler(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, "YXZ")),
});
const gaze = (h: ReturnType<typeof head>) => new Vector3(0, 0, -1).applyQuaternion(h.quaternion);

test("the bubbles sit at the set distance, to the right of where the head looked", () => {
  const h = head(10, 40);
  const spot = listenerSpot(h);
  const toSpot = spot.position.clone().sub(h.position);
  assert.ok(Math.abs(toSpot.length() - layout.listenerDistance) < 1e-6);
  assert.ok(Math.abs(toSpot.angleTo(gaze(h)) / DEG - layout.listenerSideDeg) < 0.5);
  const right = new Vector3(1, 0, 0).applyQuaternion(h.quaternion);
  assert.ok(toSpot.dot(right) > 0);
});

test("the bubbles face the head", () => {
  const h = head(-15, -70);
  const spot = listenerSpot(h);
  const facing = new Vector3(0, 0, 1).applyQuaternion(spot.quaternion);
  assert.ok(facing.angleTo(h.position.clone().sub(spot.position)) < 1e-6);
});

test("head roll is ignored, so the bubbles stay level", () => {
  const right = new Vector3(1, 0, 0).applyQuaternion(listenerSpot(head(10, 30, 25)).quaternion);
  assert.ok(Math.abs(right.y) < 1e-6);
});
