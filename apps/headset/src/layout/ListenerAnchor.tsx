// Holds the reply bubbles beside the listener once the user has shown where the listener is (see listener.ts).
// WebXR gives the page no camera frames, so the app can't find the listener's face itself.
import { useFrame, useThree } from "@react-three/fiber";
import { useXR } from "@react-three/xr";
import { useEffect, type ReactNode } from "react";
import { Quaternion, Vector3 } from "three";
import { create } from "zustand";
import { layout } from "../config.ts";
import type { Pose } from "./anchor.ts";
import { listenerSpot } from "./listener.ts";

interface ListenerState {
  spot: Pose | null;
  /** performance.now() time at which to take the head's direction as the listener's; null when not placing. */
  at: number | null;
  /** The first-run prompt was answered, by placing or skipping. */
  prompted: boolean;
}

export const useListener = create<ListenerState>(() => ({ spot: null, at: null, prompted: false }));

/** Places the listener after the same countdown as Recenter, so the user can turn to them first. */
export function requestPlaceListener(): void {
  useListener.setState({ at: performance.now() + layout.recenterCountdownMs, prompted: true });
}

export const clearListener = () => useListener.setState({ spot: null, at: null });

// Bubbles 1 m away look as big as they would on the panel.
const SCALE = layout.listenerDistance / new Vector3(...layout.panelOffset).length();

export function ListenerAnchor({ children }: { children: ReactNode }) {
  const { camera, gl } = useThree();
  const session = useXR((s) => s.session);
  const spot = useListener((s) => s.spot);

  // A new session or a system recenter changes the reference space, so the old spot points nowhere.
  useEffect(() => {
    if (!session) return;
    clearListener();
    const space = gl.xr.getReferenceSpace();
    space?.addEventListener("reset", clearListener);
    return () => space?.removeEventListener("reset", clearListener);
  }, [session, gl]);

  useFrame(() => {
    const { at } = useListener.getState();
    if (at === null || performance.now() < at) return;
    const head = { position: camera.getWorldPosition(new Vector3()), quaternion: camera.getWorldQuaternion(new Quaternion()) };
    useListener.setState({ spot: listenerSpot(head), at: null });
  });

  if (!spot) return null;
  return (
    <group position={spot.position} quaternion={spot.quaternion} scale={SCALE}>
      {children}
    </group>
  );
}
