// Where the UI goes when it is recentered: at the head, turned to the head's yaw and pitch but never its roll,
// so the panels face a seated or reclined user along their line of sight and stay level.
import { Euler, Quaternion, Vector3 } from "three";

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
}

export function anchorFromHead(head: Pose): Pose {
  const forward = new Vector3(0, 0, -1).applyQuaternion(head.quaternion);
  const yaw = Math.atan2(-forward.x, -forward.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
  return { position: head.position.clone(), quaternion: new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, "YXZ")) };
}
