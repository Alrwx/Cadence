// Holds the UI in front of the user and moves it there again when asked (see anchor.ts): on entering AR,
// when the Quest's own recenter resets the reference space, and from the Recenter button.
import { useFrame, useThree } from "@react-three/fiber";
import { useXR } from "@react-three/xr";
import { useEffect, useRef, type ReactNode } from "react";
import { Quaternion, Vector3, type Group } from "three";
import { create } from "zustand";
import { layout } from "../config.ts";
import { anchorFromHead } from "./anchor.ts";

interface RecenterState {
  /** performance.now() time at which to move the UI to the head; null when nothing is pending. */
  at: number | null;
  /** True while counting down after the user asked, so the status line can tell them where to look. */
  announced: boolean;
}

export const useRecenter = create<RecenterState>(() => ({ at: 0, announced: false }));

/** Recenters after a countdown, so a user who pressed the button by looking at it can look ahead first. */
export function requestRecenter(): void {
  useRecenter.setState({ at: performance.now() + layout.recenterCountdownMs, announced: true });
}

function recenterSoon(): void {
  // XR head poses take a few frames to settle after a session starts or the reference space resets.
  useRecenter.setState({ at: performance.now() + layout.recenterSettleMs, announced: false });
}

export function UIAnchor({ children }: { children: ReactNode }) {
  const group = useRef<Group>(null);
  const { camera, gl } = useThree();
  const session = useXR((s) => s.session);

  useEffect(() => {
    if (!session) return;
    recenterSoon();
    const space = gl.xr.getReferenceSpace();
    space?.addEventListener("reset", recenterSoon);
    return () => space?.removeEventListener("reset", recenterSoon);
  }, [session, gl]);

  useFrame(() => {
    const { at } = useRecenter.getState();
    if (at === null || performance.now() < at || !group.current) return;
    const anchor = anchorFromHead({
      position: camera.getWorldPosition(new Vector3()),
      quaternion: camera.getWorldQuaternion(new Quaternion()),
    });
    group.current.position.copy(anchor.position);
    group.current.quaternion.copy(anchor.quaternion);
    useRecenter.setState({ at: null, announced: false });
  });

  return <group ref={group}>{children}</group>;
}
