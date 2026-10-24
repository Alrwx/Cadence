// A large pinch/poke target with a text label. Hands, controllers, and the desktop emulator press it by
// pointer; the head pointer presses it after a dwell.
import { RoundedBox, Text } from "@react-three/drei";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Mesh } from "three";
import { layout } from "../config.ts";
import { dwellTargets, useHeadHover } from "../selection/targets.ts";
import { handsEnabled, useSettings } from "../settings.ts";

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
  const [pointerHover, setPointerHover] = useState(false);
  const headHover = useHeadHover((s) => s.id === id);
  const lastPress = useRef(0);
  const latest = useRef({ onPress, disabled, headSelectable });
  latest.current = { onPress, disabled, headSelectable };

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

  const hovered = pointerHover || headHover;
  return (
    <group position={position}>
      <RoundedBox
        ref={mesh}
        args={[width, height, 0.015]}
        radius={0.012}
        // Not onClick: pointer-events only clicks when the release comes within 300 ms, so a slow pinch
        // (common after a stroke) would never press. A release on the button that was pinched always does.
        onPointerDown={(e) => void pinchedOn.set(e.pointerId, id)}
        onPointerUp={(e) => {
          if (pinchedOn.get(e.pointerId) !== id) return;
          pinchedOn.delete(e.pointerId);
          if (handsEnabled(useSettings.getState().inputMode)) press();
        }}
        onPointerOver={() => setPointerHover(true)}
        onPointerOut={() => setPointerHover(false)}
      >
        <meshStandardMaterial color={disabled ? "#444" : hovered ? "#4a86d0" : color} />
      </RoundedBox>
      {/* The label must not catch rays: a pinch on the text would hit it instead of the button. */}
      <Text
        raycast={ignoreRays}
        position={[0, 0, 0.009]}
        fontSize={layout.fontSize}
        maxWidth={width - 0.03}
        textAlign="center"
        anchorX="center"
        anchorY="middle"
        color="white"
      >
        {label}
      </Text>
      {children}
    </group>
  );
}

const ignoreRays = () => {};

// Shared across buttons, so a pinch that started on one button and was released elsewhere can't later press it.
const pinchedOn = new Map<number, string>();
