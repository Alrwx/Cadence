import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Euler, Quaternion, Vector3 } from "three";
import { anchorFromHead } from "./anchor.ts";

const DEG = Math.PI / 180;
const head = (pitchDeg: number, yawDeg: number, rollDeg = 0) => ({
  position: new Vector3(0.1, 1.2, 0.3),
  quaternion: new Quaternion().setFromEuler(new Euler(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, "YXZ")),
});
const close = (a: Vector3, b: Vector3) => assert.ok(a.distanceTo(b) < 1e-6, `${a.toArray()} vs ${b.toArray()}`);

/** Where a point `offset` in front of the anchor ends up in the world. */
const place = (anchor: ReturnType<typeof anchorFromHead>, offset: Vector3) =>
  offset.clone().applyQuaternion(anchor.quaternion).add(anchor.position);

test("the anchor sits at the head and turns with its yaw", () => {
  const anchor = anchorFromHead(head(0, 90));
  close(anchor.position, new Vector3(0.1, 1.2, 0.3));
  close(place(anchor, new Vector3(0, 0, -1)), new Vector3(-0.9, 1.2, 0.3));
});

test("a reclined head looking up gets the panels along its line of sight", () => {
  const anchor = anchorFromHead(head(50, 0));
  const ahead = place(anchor, new Vector3(0, 0, -1)).sub(anchor.position);
  assert.ok(Math.abs(ahead.angleTo(new Vector3(0, Math.sin(50 * DEG), -Math.cos(50 * DEG)))) < 1e-6);
});

test("head roll is ignored, so the panels stay level", () => {
  const anchor = anchorFromHead(head(10, 30, 25));
  const right = new Vector3(1, 0, 0).applyQuaternion(anchor.quaternion);
  assert.ok(Math.abs(right.y) < 1e-6);
  close(new Vector3(0, 0, -1).applyQuaternion(anchor.quaternion), new Vector3(0, 0, -1).applyQuaternion(head(10, 30).quaternion));
});
