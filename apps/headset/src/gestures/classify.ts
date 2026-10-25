// Pure hand-pose classification from WebXR joint poses, so it can be unit-tested off-device.
import { gestures as cfg } from "../config.ts";

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };
export type Gesture = "thumbsUp" | "thumbsDown" | "openPalm";

/** The subset of the 25 WebXR hand joints the classifier needs, in one reference space. */
export interface HandJoints {
  wrist: Vec3;
  thumbProximal: Vec3;
  thumbTip: Vec3;
  middleKnuckle: Vec3;
  indexTip: Vec3;
  middleTip: Vec3;
  ringTip: Vec3;
  pinkyTip: Vec3;
}

export interface HandFrame {
  joints: HandJoints;
  /** Wrist joint orientation: WebXR points its -Z along the fingers and its -Y out of the palm. */
  wristOrientation: Quat;
  head: Vec3;
}

export const JOINT_NAMES: Record<keyof HandJoints, XRHandJoint> = {
  wrist: "wrist",
  thumbProximal: "thumb-phalanx-proximal",
  thumbTip: "thumb-tip",
  middleKnuckle: "middle-finger-phalanx-proximal",
  indexTip: "index-finger-tip",
  middleTip: "middle-finger-tip",
  ringTip: "ring-finger-tip",
  pinkyTip: "pinky-finger-tip",
};

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

function rotate(v: Vec3, q: Quat): Vec3 {
  // v' = v + 2w(q×v) + 2q×(q×v)
  const cx = q.y * v.z - q.z * v.y;
  const cy = q.z * v.x - q.x * v.z;
  const cz = q.x * v.y - q.y * v.x;
  return {
    x: v.x + 2 * (q.w * cx + q.y * cz - q.z * cy),
    y: v.y + 2 * (q.w * cy + q.z * cx - q.x * cz),
    z: v.z + 2 * (q.w * cz + q.x * cy - q.y * cx),
  };
}

/** Hand-size-independent features of one hand: reaches in palm lengths, directions as cosines. */
export interface HandMeasures {
  /** Index, middle, ring, pinky. */
  fingerReach: number[];
  thumbReach: number;
  pinchGap: number;
  /** Cosine between the thumb and world up. */
  thumbUp: number;
  /** Cosine between the fingers and world up. */
  fingersUp: number;
  /** Cosine between the palm and the direction away from the head. */
  palmAway: number;
}

export function measure({ joints: j, wristOrientation, head }: HandFrame): HandMeasures {
  const palm = dist(j.wrist, j.middleKnuckle) || 1;
  const reach = (tip: Vec3) => dist(tip, j.wrist) / palm;
  return {
    fingerReach: [j.indexTip, j.middleTip, j.ringTip, j.pinkyTip].map(reach),
    thumbReach: reach(j.thumbTip),
    pinchGap: dist(j.thumbTip, j.indexTip) / palm,
    thumbUp: unit(sub(j.thumbTip, j.thumbProximal)).y,
    fingersUp: rotate({ x: 0, y: 0, z: -1 }, wristOrientation).y,
    palmAway: dot(rotate({ x: 0, y: -1, z: 0 }, wristOrientation), unit(sub(j.wrist, head))),
  };
}

export function classify(hand: HandFrame): Gesture | null {
  const m = measure(hand);
  if (m.fingerReach.every((r) => r < cfg.curledReach) && m.thumbReach > cfg.thumbOutReach) {
    if (m.thumbUp > cfg.pointingCos) return "thumbsUp";
    if (m.thumbUp < -cfg.pointingCos) return "thumbsDown";
  }
  if (
    m.fingerReach.every((r) => r > cfg.extendedReach) &&
    m.pinchGap > cfg.minPinchGap &&
    m.fingersUp > cfg.pointingCos &&
    m.palmAway > cfg.palmAwayCos
  ) {
    return "openPalm";
  }
  return null;
}

/** Fires a gesture once it has been held for holdMs, then waits cooldownMs before firing again. */
export class GestureDebouncer {
  private current: Gesture | null = null;
  private since = 0;
  private lastFired = -Infinity;

  update(gesture: Gesture | null, now: number): Gesture | null {
    if (gesture !== this.current) {
      this.current = gesture;
      this.since = now;
      return null;
    }
    if (!gesture || now - this.since < cfg.holdMs || now - this.lastFired < cfg.cooldownMs) return null;
    this.lastFired = now;
    return gesture;
  }
}
