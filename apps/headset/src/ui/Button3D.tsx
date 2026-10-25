// A large pinch/poke target with a text label. Hands, controllers, and the desktop emulator press it by
// pointer; the head pointer presses it after a dwell, which fills the glass from the bottom as it runs.
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { MathUtils, type Group, type Mesh } from "three";
import { layout } from "../config.ts";
import { dwellProgress, dwellTargets, useHeadHover } from "../selection/targets.ts";
import { handsEnabled, useSettings } from "../settings.ts";
import { createGlassMaterial, GLASS_OPACITY, SOLID_OPACITY } from "./glass.ts";

const RADIUS = 0.014;
/** Hovered buttons rise toward the user; a held pinch pushes them back (meters). */
const HOVER_LIFT = 0.008;
const PINCH_DEPTH = 0.005;
/** A pinch release still counts as held for this long, in case the hand is lost before the release (ms). */
const PINCH_HOLD_LIMIT_MS = 2000;

interface Props {
  label: string;
  onPress: () => void;
  position?: [number, number, number];
  width?: number;
  height?: number;
  color?: string;
  disabled?: boolean;
  /** False for buttons that could lock a hands-free user out (e.g. switching to hands-only input). */
  headSelectable?: boolean;
  /** Extra marks drawn on the button face, positioned from its center. */
  children?: ReactNode;
}

export function Button3D({
  label,
  onPress,
  position = [0, 0, 0],
  width = layout.buttonWidth,
  height = layout.buttonHeight,
  color = "#2b5d9c",
  disabled = false,
  headSelectable = true,
  children,
}: Props) {
  const id = useId();
  const mesh = useRef<Mesh>(null);
  const face = useRef<Group>(null);
  const [pointerHover, setPointerHover] = useState(false);
  const headHover = useHeadHover((s) => s.id === id);
  const solid = useSettings((s) => s.solidPanels);
  const lastPress = useRef(0);
  /** When the current pinch on this button started, or 0. */
  const pinchedAt = useRef(0);
  const latest = useRef({ onPress, disabled, headSelectable });
  latest.current = { onPress, disabled, headSelectable };

  const material = useMemo(() => createGlassMaterial(width, height, RADIUS), [width, height]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    material.uniforms.uTint.value.set(disabled ? "#444" : color);
    material.uniforms.uOpacity.value = solid ? SOLID_OPACITY : disabled ? GLASS_OPACITY * 0.6 : GLASS_OPACITY;
    material.uniforms.uSheen.value = solid ? 0 : 1;
  }, [material, color, disabled, solid]);

  const press = () => {
    const now = performance.now();
    if (latest.current.disabled || now - lastPress.current < layout.pressDebounceMs) return;
    lastPress.current = now;
    latest.current.onPress();
  };

  useEffect(() => {
    if (!mesh.current) return;
    dwellTargets.set(id, {
      object: mesh.current,
      label,
      width,
      height,
      press,
      selectable: () => !latest.current.disabled && latest.current.headSelectable,
    });
    return () => void dwellTargets.delete(id);
    // press and selectable read the current props through `latest`, so they needn't re-register.
  }, [id, label, width, height]);

  const hovered = (pointerHover || headHover) && !disabled;
  useFrame(({ clock }, delta) => {
    const u = material.uniforms;
    u.uTime.value = clock.elapsedTime;
    u.uHover.value = MathUtils.damp(u.uHover.value, hovered ? 1 : 0, 14, delta);
    // The liquid tracks the dwell exactly on the way up, and drains smoothly once it fires or the head leaves.
    const fill = dwellProgress.id === id ? dwellProgress.value : 0;
    u.uFill.value = fill >= u.uFill.value ? fill : MathUtils.damp(u.uFill.value, 0, 10, delta);

    const now = performance.now();
    if (pinchedAt.current && now - pinchedAt.current > PINCH_HOLD_LIMIT_MS) pinchedAt.current = 0;
    const held = pinchedAt.current ? 1 : 0;
    // A press squashes the button and lets it spring back, so a slow or unsure pinch still feels it land.
    const since = (now - lastPress.current) / 1000;
    const wobble = lastPress.current ? Math.exp(-since * 9) * Math.cos(since * 28) : 0;
    const scale = u.uScale.value;
    scale.set(MathUtils.damp(scale.x, 1 + 0.04 * wobble - 0.03 * held, 30, delta), MathUtils.damp(scale.y, 1 - 0.09 * wobble - 0.03 * held, 30, delta));
    u.uLift.value = u.uHover.value * HOVER_LIFT - held * PINCH_DEPTH;
    face.current?.scale.set(scale.x, scale.y, 1);
    face.current?.position.setZ(u.uLift.value);
  });

  return (
    <group position={position}>
      <mesh
        ref={mesh}
        material={material}
        // Not onClick: pointer-events only clicks when the release comes within 300 ms, so a slow pinch
        // (common after a stroke) would never press. A release on the button that was pinched always does.
        onPointerDown={(e) => {
          pinchedOn.set(e.pointerId, id);
          if (!latest.current.disabled && handsEnabled(useSettings.getState().inputMode)) pinchedAt.current = performance.now();
        }}
        onPointerUp={(e) => {
          pinchedAt.current = 0;
          if (pinchedOn.get(e.pointerId) !== id) return;
          pinchedOn.delete(e.pointerId);
          if (handsEnabled(useSettings.getState().inputMode)) press();
        }}
        onPointerOver={() => setPointerHover(true)}
        onPointerOut={() => {
          setPointerHover(false);
          pinchedAt.current = 0;
        }}
      >
        <planeGeometry args={[width, height]} />
      </mesh>
      <group ref={face}>
        {/* The label must not catch rays: a pinch on the text would hit it instead of the button. A soft dark
            halo keeps it readable over whatever the glass lets through. */}
        <Text
          raycast={ignoreRays}
          position={[0, 0, 0.004]}
          fontSize={layout.fontSize}
          maxWidth={width - 0.03}
          textAlign="center"
          anchorX="center"
          anchorY="middle"
          color="white"
          fillOpacity={disabled ? 0.55 : 1}
          outlineBlur={0.004}
          outlineColor="black"
          outlineOpacity={0.5}
        >
          {label}
        </Text>
        {children}
      </group>
    </group>
  );
}

const ignoreRays = () => {};

// Shared across buttons, so a pinch that started on one button and was released elsewhere can't later press it.
const pinchedOn = new Map<number, string>();
