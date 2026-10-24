// Reads hand joints every frame and sends instant phrases for held gestures.
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { create } from "zustand";
import { gesturePhrases } from "../config.ts";
import { debugEnabled } from "../dev/debug.ts";
import { recordFrame } from "../dev/handRecorder.ts";
import { send } from "../session.ts";
import {
  classify,
  GestureDebouncer,
  JOINT_NAMES,
  measure,
  type Gesture,
  type HandFrame,
  type HandJoints,
  type HandMeasures,
} from "./classify.ts";

interface HandReadout {
  hands: Partial<Record<XRHandedness, { gesture: Gesture | null; measures: HandMeasures }>>;
}

/** Live per-hand classification for the debug panel; only updated with ?debug. */
export const useHandReadout = create<HandReadout>(() => ({ hands: {} }));

const READOUT_INTERVAL_MS = 100;

export function fireGesture(gesture: Gesture): void {
  send("instant", { phraseId: gesturePhrases[gesture] });
}

export function HandGestures() {
  const debouncers = useRef(new Map<XRHandedness, GestureDebouncer>());
  const lastReadout = useRef(0);

  useFrame((state, _delta, frame?: XRFrame) => {
    const refSpace = state.gl.xr.getReferenceSpace();
    const head = refSpace && frame?.getViewerPose(refSpace)?.transform.position;
    if (!frame || !refSpace || !head) return;
    const now = performance.now();
    const readout: HandReadout["hands"] = {};
    for (const source of frame.session.inputSources) {
      if (!source.hand) continue;
      const hand = readHand(frame, source.hand, refSpace, head);
      const gesture = hand ? classify(hand) : null;
      let debouncer = debouncers.current.get(source.handedness);
      if (!debouncer) debouncers.current.set(source.handedness, (debouncer = new GestureDebouncer()));
      const fired = debouncer.update(gesture, now);
      if (fired) fireGesture(fired);
      if (debugEnabled && hand) {
        recordFrame(source.handedness, hand);
        readout[source.handedness] = { gesture, measures: measure(hand) };
      }
    }
    if (debugEnabled && now - lastReadout.current > READOUT_INTERVAL_MS) {
      lastReadout.current = now;
      useHandReadout.setState({ hands: readout });
    }
  });

  return null;
}

function readHand(frame: XRFrame, hand: XRHand, refSpace: XRReferenceSpace, head: DOMPointReadOnly): HandFrame | null {
  const joints: Partial<HandJoints> = {};
  let wristOrientation: DOMPointReadOnly | undefined;
  for (const [key, name] of Object.entries(JOINT_NAMES) as [keyof HandJoints, XRHandJoint][]) {
    const space = hand.get(name);
    const pose = space && frame.getJointPose?.(space, refSpace);
    if (!pose) return null;
    joints[key] = pose.transform.position;
    if (key === "wrist") wristOrientation = pose.transform.orientation;
  }
  return { joints: joints as HandJoints, wristOrientation: wristOrientation!, head };
}
