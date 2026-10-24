// Reads hand joints every frame and sends instant phrases for held gestures.
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { gesturePhrases } from "../config.ts";
import { connection } from "../session.ts";
import { classify, GestureDebouncer, JOINT_NAMES, type HandJoints } from "./classify.ts";

export function HandGestures() {
  const debouncers = useRef(new Map<XRHandedness, GestureDebouncer>());

  useFrame((state, _delta, frame?: XRFrame) => {
    const refSpace = state.gl.xr.getReferenceSpace();
    if (!frame || !refSpace) return;
    for (const source of frame.session.inputSources) {
      if (!source.hand) continue;
      const joints = readJoints(frame, source.hand, refSpace);
      let debouncer = debouncers.current.get(source.handedness);
      if (!debouncer) debouncers.current.set(source.handedness, (debouncer = new GestureDebouncer()));
      const fired = debouncer.update(joints ? classify(joints) : null, performance.now());
      if (fired) connection.send("instant", { phraseId: gesturePhrases[fired] });
    }
  });

  return null;
}

function readJoints(frame: XRFrame, hand: XRHand, refSpace: XRReferenceSpace): HandJoints | null {
  const out: Partial<HandJoints> = {};
  for (const [key, name] of Object.entries(JOINT_NAMES) as [keyof HandJoints, XRHandJoint][]) {
    const space = hand.get(name);
    const pose = space && frame.getJointPose?.(space, refSpace);
    if (!pose) return null;
    out[key] = pose.transform.position;
  }
  return out as HandJoints;
}
