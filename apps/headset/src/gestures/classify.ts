// Pure hand-pose classification from WebXR joint positions, so it can be unit-tested off-device.
import { gestures as cfg } from "../config.ts";

export type Vec3 = { x: number; y: number; z: number };
export type Gesture = "thumbsUp" | "thumbsDown" | "openPalm";

/** The subset of the 25 WebXR hand joints the classifier needs. */
export interface HandJoints {
  wrist: Vec3;
  thumbTip: Vec3;
  indexTip: Vec3;
  middleTip: Vec3;
  ringTip: Vec3;
  pinkyTip: Vec3;
}

export const JOINT_NAMES: Record<keyof HandJoints, XRHandJoint> = {
  wrist: "wrist",
  thumbTip: "thumb-tip",
  indexTip: "index-finger-tip",
  middleTip: "middle-finger-tip",
  ringTip: "ring-finger-tip",
  pinkyTip: "pinky-finger-tip",
};

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function classify(j: HandJoints): Gesture | null {
  const fingers = [j.indexTip, j.middleTip, j.ringTip, j.pinkyTip].map((tip) => dist(tip, j.wrist));
  const allCurled = fingers.every((d) => d < cfg.curledTipToWrist);
  const allExtended = fingers.every((d) => d > cfg.extendedTipToWrist) && dist(j.thumbTip, j.wrist) > cfg.curledTipToWrist;
  const thumbRise = j.thumbTip.y - j.wrist.y;

  if (allCurled && thumbRise > cfg.thumbVertical) return "thumbsUp";
  if (allCurled && thumbRise < -cfg.thumbVertical) return "thumbsDown";
  if (allExtended) return "openPalm";
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
