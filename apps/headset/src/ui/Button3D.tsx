// A large pinch/poke target with a text label. Hands, controllers, and the desktop emulator fire onClick;
// the head pointer presses it after a dwell.
import { RoundedBox, Text } from "@react-three/drei";
import { useEffect, useId, useRef, useState } from "react";
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
        onClick={() => handsEnabled(useSettings.getState().inputMode) && press()}
        onPointerOver={() => setPointerHover(true)}
        onPointerOut={() => setPointerHover(false)}
      >
        <meshStandardMaterial color={disabled ? "#444" : hovered ? "#4a86d0" : color} />
      </RoundedBox>
      <Text
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
    </group>
  );
}
