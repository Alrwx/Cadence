// Reads hand joints every frame and sends instant phrases for held gestures.
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { gesturePhrases } from "../config.ts";
import { connection } from "../session.ts";
import { classify, GestureDebouncer, JOINT_NAMES, type HandFrame, type HandJoints } from "./classify.ts";

export function HandGestures() {
  const debouncers = useRef(new Map<XRHandedness, GestureDebouncer>());

  useFrame((state, _delta, frame?: XRFrame) => {
    const refSpace = state.gl.xr.getReferenceSpace();
    const head = refSpace && frame?.getViewerPose(refSpace)?.transform.position;
    if (!frame || !refSpace || !head) return;
    for (const source of frame.session.inputSources) {
      if (!source.hand) continue;
      const hand = readHand(frame, source.hand, refSpace, head);
      let debouncer = debouncers.current.get(source.handedness);
      if (!debouncer) debouncers.current.set(source.handedness, (debouncer = new GestureDebouncer()));
      const fired = debouncer.update(hand ? classify(hand) : null, performance.now());
      if (fired) connection.send("instant", { phraseId: gesturePhrases[fired] });
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
