// Input mode and dwell time. Every control works by hand and by head, except switching to hands-only,
// which a user who can't pinch must not be able to trigger by looking.
import { Text } from "@react-three/drei";
import { layout, selection } from "../config.ts";
import { useSettings, type InputMode } from "../settings.ts";
import { Button3D } from "./Button3D.tsx";

const MODES: [InputMode, string][] = [
  ["hands", "Hands"],
  ["head", "Head"],
  ["both", "Both"],
];
const ACTIVE = "#b07a1f";
const IDLE = "#3d4a5c";
const LABEL_X = -0.47;

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const mode = useSettings((s) => s.inputMode);
  const dwellMs = useSettings((s) => s.dwellMs);
  const row = layout.buttonHeight + 0.03;

  return (
    <group position={[0, 0.12, 0]}>
      <Text position={[LABEL_X, 0, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        Select with
      </Text>
      {MODES.map(([m, label], i) => (
        <Button3D
          key={m}
          label={label}
          width={0.16}
          color={m === mode ? ACTIVE : IDLE}
          headSelectable={m !== "hands"}
          position={[-0.12 + i * 0.18, 0, 0]}
          onPress={() => useSettings.setState({ inputMode: m })}
        />
      ))}
      <Text position={[LABEL_X, -row, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        Hold time
      </Text>
      {selection.dwellChoicesMs.map((ms, i) => (
        <Button3D
          key={ms}
          label={`${ms / 1000} s`}
          width={0.12}
          color={ms === dwellMs ? ACTIVE : IDLE}
          position={[-0.14 + i * 0.135, -row, 0]}
          onPress={() => useSettings.setState({ dwellMs: ms })}
        />
      ))}
      <Button3D label="Done" width={0.2} color="#2b5d9c" position={[0, -2 * row, 0]} onPress={onClose} />
    </group>
  );
}
