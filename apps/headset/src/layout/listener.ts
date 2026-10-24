// Where the reply bubbles go once the user has looked at the listener: beside the face, not over it,
// level and facing back toward where the user's head was.
import { Quaternion, Vector3 } from "three";
import { layout } from "../config.ts";
import { anchorFromHead, type Pose } from "./anchor.ts";

const UP = new Vector3(0, 1, 0);

export function listenerSpot(head: Pose): Pose {
  // Turned about the head's own level up axis, not the world's: about the world's, the offset would shrink with
  // pitch and cover the face of a listener a reclined user looks up at.
  const side = new Quaternion().setFromAxisAngle(UP, (-layout.listenerSideDeg * Math.PI) / 180);
  const toSpot = anchorFromHead(head).quaternion.multiply(side);
  const position = new Vector3(0, 0, -layout.listenerDistance).applyQuaternion(toSpot).add(head.position);
  return { position, quaternion: anchorFromHead({ position, quaternion: toSpot }).quaternion };
}
