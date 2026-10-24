// A large pinch/poke target with a text label. Hands, controllers, and the desktop emulator all fire onClick.
import { RoundedBox, Text } from "@react-three/drei";
import { useRef, useState } from "react";
import { layout } from "../config.ts";

interface Props {
  label: string;
  onPress: () => void;
  position?: [number, number, number];
  width?: number;
  height?: number;
  color?: string;
  disabled?: boolean;
}

export function Button3D({
  label,
  onPress,
  position = [0, 0, 0],
  width = layout.buttonWidth,
  height = layout.buttonHeight,
  color = "#2b5d9c",
  disabled = false,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const lastPress = useRef(0);

  const press = () => {
    const now = performance.now();
    if (disabled || now - lastPress.current < layout.pressDebounceMs) return;
    lastPress.current = now;
    onPress();
  };

  return (
    <group position={position}>
      <RoundedBox
        args={[width, height, 0.015]}
        radius={0.012}
        onClick={press}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
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
