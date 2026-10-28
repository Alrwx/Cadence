// Hands-free selection: a reticle at the center of view; holding it on a button presses it.
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Quaternion, Vector3, type Mesh } from "three";
import { selection } from "../config.ts";
import { ACCENT } from "../ui/glass.ts";
import { headEnabled, useSettings } from "../settings.ts";
import { DwellTracker, pickTarget, type Rect } from "./dwell.ts";
import { dwellProgress, dwellTargets, useHeadHover, type DwellTarget } from "./targets.ts";

const DEG = Math.PI / 180;
const RING_OUTER = 0.012;
const RING_INNER = 0.009;
const ARC_SEGMENTS = 64;

export function HeadPointer() {
  const mode = useSettings((s) => s.inputMode);
  return headEnabled(mode) ? <Reticle /> : null;
}

function Reticle() {
  const { camera, scene } = useThree();
  const tracker = useRef(new DwellTracker());
  const lastIds = useRef(new Set<string>());
  const arc = useRef<Mesh>(null);

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
      Object.assign(dwellProgress, { id: null, value: 0 });
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
    Object.assign(dwellProgress, { id: update.hover, value: update.progress });
    if (update.fired) dwellTargets.get(update.fired)?.press();
    // Each ring segment is 6 indices, so the draw range shows the arc up to the progress.
    arc.current?.geometry.setDrawRange(0, 6 * Math.round(update.progress * ARC_SEGMENTS));
  });

  return createPortal(
    <group position={[0, 0, -selection.reticleDistance]}>
      <mesh renderOrder={1000}>
        <ringGeometry args={[RING_INNER, RING_OUTER, 32]} />
        <meshBasicMaterial color="white" depthTest={false} transparent opacity={0.9} />
      </mesh>
      {/* Mirrored, so the arc runs clockwise from the top. */}
      <mesh ref={arc} renderOrder={1001} scale={[-1, 1, 1]}>
        <ringGeometry args={[RING_INNER, RING_OUTER, ARC_SEGMENTS, 1, Math.PI / 2]} />
        <meshBasicMaterial color={ACCENT} depthTest={false} transparent opacity={0.95} />
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
