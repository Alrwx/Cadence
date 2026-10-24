// Hands-free selection: a reticle at the center of view; holding it on a button presses it.
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Quaternion, Vector3, type Mesh } from "three";
import { selection } from "../config.ts";
import { headEnabled, useSettings } from "../settings.ts";
import { DwellTracker, pickTarget, type Rect } from "./dwell.ts";
import { dwellTargets, useHeadHover, type DwellTarget } from "./targets.ts";

const DEG = Math.PI / 180;
const RING_OUTER = 0.012;
const RING_INNER = 0.009;

export function HeadPointer() {
  const mode = useSettings((s) => s.inputMode);
  return headEnabled(mode) ? <Reticle /> : null;
}

function Reticle() {
  const { camera, scene } = useThree();
  const tracker = useRef(new DwellTracker());
  const lastIds = useRef(new Set<string>());
  const fill = useRef<Mesh>(null);

  // The reticle is a child of the camera so it moves with the head in the same frame; the camera has to be
  // in the scene for its children to render.
  useEffect(() => {
    if (camera.parent) return;
    scene.add(camera);
    return () => void scene.remove(camera);
  }, [camera, scene]);

  useEffect(
    () => () => {
      useHeadHover.setState({ id: null });
    },
    [],
  );

  useFrame(() => {
    const origin = camera.getWorldPosition(new Vector3());
    const dir = camera.getWorldDirection(new Vector3());
    const rects: [string, Rect][] = [];
    for (const [id, target] of dwellTargets) if (target.selectable()) rects.push([id, rectOf(target)]);
    const hover = pickTarget(origin, dir, rects, selection.snapDeg * DEG);
    const appeared = hover !== null && !lastIds.current.has(hover);
    lastIds.current = new Set(rects.map(([id]) => id));
    const { dwellMs } = useSettings.getState();
    const update = tracker.current.update(
      hover,
      dir,
      performance.now(),
      { dwellMs, maxHeadSpeed: selection.maxHeadSpeedDegPerSec * DEG },
      appeared,
    );
    if (useHeadHover.getState().id !== update.hover) useHeadHover.setState({ id: update.hover });
    if (update.fired) dwellTargets.get(update.fired)?.press();
    fill.current?.scale.setScalar(Math.max(update.progress, 1e-3));
  });

  return createPortal(
    <group position={[0, 0, -selection.reticleDistance]}>
      <mesh renderOrder={1000}>
        <ringGeometry args={[RING_INNER, RING_OUTER, 32]} />
        <meshBasicMaterial color="white" depthTest={false} transparent opacity={0.9} />
      </mesh>
      <mesh ref={fill} renderOrder={1001}>
        <circleGeometry args={[RING_INNER, 32]} />
        <meshBasicMaterial color="#7fd1ff" depthTest={false} transparent opacity={0.9} />
      </mesh>
    </group>,
    camera,
  );
}

const scratch = { position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3() };

function rectOf({ object, width, height }: DwellTarget): Rect {
  object.updateWorldMatrix(true, false);
  object.matrixWorld.decompose(scratch.position, scratch.quaternion, scratch.scale);
  return {
    center: scratch.position.clone(),
    right: new Vector3(1, 0, 0).applyQuaternion(scratch.quaternion),
    up: new Vector3(0, 1, 0).applyQuaternion(scratch.quaternion),
    normal: new Vector3(0, 0, 1).applyQuaternion(scratch.quaternion),
    halfWidth: (width / 2) * scratch.scale.x,
    halfHeight: (height / 2) * scratch.scale.y,
  };
}
