import { strict as assert } from "node:assert";
import { test } from "node:test";
import { oculusHandConfig } from "iwer/lib/device/XRHandInput.js";
import { Matrix4, Quaternion, Vector3 } from "three";
import { gestures as cfg } from "../config.ts";
import { classify, GestureDebouncer, JOINT_NAMES, type Gesture, type HandFrame, type HandJoints } from "./classify.ts";

// IWER's captured poses are left hands in wrist-local space; mirroring x gives the right hand, as IWER does.
const MIRROR = new Matrix4().makeScale(-1, 1, 1);
const HEAD = new Vector3(0, 1.6, 0);
const HAND_AT = new Vector3(0.1, 1.35, -0.35);

type Hand = "left" | "right";

/** Places IWER pose `poseId` so the wrist's fingers (-Z) and palm (-Y) point along the given world directions. */
function frame(poseId: string, hand: Hand, fingers: Vector3, palm: Vector3): HandFrame {
  const pose = (oculusHandConfig.poses as Record<string, (typeof oculusHandConfig.poses)["default"]>)[poseId]!;
  const local = (joint: XRHandJoint) => {
    const m = new Matrix4().fromArray(pose.jointTransforms[joint].offsetMatrix);
    return hand === "right" ? MIRROR.clone().multiply(m).multiply(MIRROR) : m;
  };
  const wristLocal = local("wrist");
  const target = new Matrix4().makeBasis(
    new Vector3().crossVectors(palm.clone().negate(), fingers.clone().negate()).normalize(),
    palm.clone().negate().normalize(),
    fingers.clone().negate().normalize(),
  );
  const xx = new Vector3(), yy = new Vector3(), zz = new Vector3();
  wristLocal.extractBasis(xx, yy, zz);
  const wristRot = new Matrix4().makeBasis(xx.normalize(), yy.normalize(), zz.normalize());
  const toWorld = new Matrix4()
    .setPosition(HAND_AT)
    .multiply(target)
    .multiply(wristRot.clone().invert())
    .multiply(new Matrix4().setPosition(new Vector3().setFromMatrixPosition(wristLocal).negate()));
  const joints = Object.fromEntries(
    Object.entries(JOINT_NAMES).map(([key, name]) => [key, new Vector3().setFromMatrixPosition(local(name)).applyMatrix4(toWorld)]),
  ) as unknown as HandJoints;
  const wristOrientation = new Quaternion().setFromRotationMatrix(new Matrix4().multiplyMatrices(toWorld, wristRot));
  return { joints, wristOrientation, head: HEAD };
}

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const FORWARD = new Vector3(0, 0, -1);
const BACK = new Vector3(0, 0, 1);
const INWARD: Record<Hand, Vector3> = { left: new Vector3(1, 0, 0), right: new Vector3(-1, 0, 0) };

/** Orientation that points the extended thumb of `poseId` along `dir`. */
function thumbAlong(poseId: string, hand: Hand, dir: Vector3): HandFrame {
  const f = frame(poseId, hand, FORWARD, DOWN);
  const thumb = new Vector3().copy(f.joints.thumbTip).sub(new Vector3().copy(f.joints.thumbProximal)).normalize();
  const turn = new Quaternion().setFromUnitVectors(thumb, dir);
  const fingers = FORWARD.clone().applyQuaternion(turn);
  const palm = DOWN.clone().applyQuaternion(turn);
  return frame(poseId, hand, fingers, palm);
}

for (const hand of ["left", "right"] as const) {
  const cases: [string, HandFrame, Gesture | null][] = [
    ["thumbs-up, thumb up", thumbAlong("thumbs-up", hand, UP), "thumbsUp"],
    ["thumbs-up, thumb down", thumbAlong("thumbs-up", hand, DOWN), "thumbsDown"],
    ["thumbs-up, thumb sideways", thumbAlong("thumbs-up", hand, INWARD[hand]), null],
    ["fist turned thumb-up", thumbAlong("fist", hand, UP), null],
    ["open palm toward the listener", frame("open", hand, UP, FORWARD), "openPalm"],
    ["flat palm toward the listener", frame("flat", hand, UP, FORWARD), "openPalm"],
    ["open palm facing the user", frame("open", hand, UP, BACK), null],
    ["relaxed hand resting palm down", frame("default", hand, FORWARD, DOWN), null],
    ["relaxed hand palm in", frame("default", hand, FORWARD, INWARD[hand]), null],
    ["pinch held up toward the listener", frame("pinch", hand, UP, FORWARD), null],
    ["pointing", frame("point", hand, FORWARD, DOWN), null],
    ["fist", frame("fist", hand, FORWARD, DOWN), null],
    ["grip", frame("grip", hand, UP, FORWARD), null],
  ];
  for (const [name, f, expected] of cases) {
    test(`${hand} hand: ${name} → ${expected ?? "nothing"}`, () => assert.equal(classify(f), expected));
  }
}

test("debouncer needs a hold and respects cooldown", () => {
  const d = new GestureDebouncer();
  assert.equal(d.update("thumbsUp", 0), null);
  assert.equal(d.update("thumbsUp", cfg.holdMs - 1), null);
  assert.equal(d.update("thumbsUp", cfg.holdMs), "thumbsUp");
  assert.equal(d.update("thumbsUp", cfg.holdMs + 10), null, "cooldown");
  assert.equal(d.update(null, cfg.holdMs + 20), null);
});
