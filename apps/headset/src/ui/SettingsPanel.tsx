// Input mode, dwell time, and glass or solid buttons. Every control works by hand and by head, except switching to hands-only,
// which a user who can't pinch must not be able to trigger by looking.
import { Text } from "@react-three/drei";
import { useEffect, useState } from "react";
import { layout, selection } from "../config.ts";
import { useConsent } from "../consent.ts";
import { clearListener, requestPlaceListener, useListener } from "../layout/ListenerAnchor.tsx";
import { send } from "../session.ts";
import { useSettings, type InputMode } from "../settings.ts";
import { t, type StringKey } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";

const MODES: [InputMode, StringKey][] = [
  ["hands", "settings.hands"],
  ["head", "settings.head"],
  ["both", "settings.both"],
];
const ACTIVE = "#b07a1f";
const IDLE = "#3d4a5c";
const LABEL_X = -0.47;

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const mode = useSettings((s) => s.inputMode);
  const dwellMs = useSettings((s) => s.dwellMs);
  const solid = useSettings((s) => s.solidPanels);
  const row = layout.buttonHeight + 0.03;

  return (
    <group position={[0, 0.12, 0]}>
      <Text position={[LABEL_X, 0, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        {t("settings.selectWith")}
      </Text>
      {MODES.map(([m, label], i) => (
        <Button3D
          key={m}
          label={t(label)}
          width={0.16}
          color={m === mode ? ACTIVE : IDLE}
          headSelectable={m !== "hands"}
          position={[-0.12 + i * 0.18, 0, 0]}
          onPress={() => useSettings.setState({ inputMode: m })}
        />
      ))}
      <Text position={[LABEL_X, -row, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        {t("settings.holdTime")}
      </Text>
      {selection.dwellChoicesMs.map((ms, i) => (
        <Button3D
          key={ms}
          label={t("settings.seconds", { n: ms / 1000 })}
          width={0.12}
          color={ms === dwellMs ? ACTIVE : IDLE}
          position={[-0.14 + i * 0.135, -row, 0]}
          onPress={() => useSettings.setState({ dwellMs: ms })}
        />
      ))}
      <Text position={[LABEL_X, -2 * row, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        {t("settings.panels")}
      </Text>
      <Button3D
        label={t("settings.glass")}
        width={0.12}
        color={!solid ? ACTIVE : IDLE}
        position={[-0.14, -2 * row, 0]}
        onPress={() => useSettings.setState({ solidPanels: false })}
      />
      <Button3D
        label={t("settings.solid")}
        width={0.16}
        color={solid ? ACTIVE : IDLE}
        position={[0.01, -2 * row, 0]}
        onPress={() => useSettings.setState({ solidPanels: true })}
      />
      <MemoriesRow y={-3 * row} />
      <ListenerRow y={-4 * row} />
      <Button3D label={t("settings.done")} width={0.2} color="#2b5d9c" position={[0, -5 * row, 0]} onPress={onClose} />
    </group>
  );
}

/** store_chat consent; turning it off deletes every memory, so it takes a second press. */
function MemoriesRow({ y }: { y: number }) {
  const storeChat = useConsent((s) => s.storeChat);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), layout.confirmMs);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <>
      <Text position={[LABEL_X, y, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        {t("memories.setting")}
      </Text>
      <Button3D
        label={t("memories.on")}
        width={0.12}
        color={storeChat ? ACTIVE : IDLE}
        position={[-0.14, y, 0]}
        onPress={() => send("consent.set", { kind: "store_chat", granted: true })}
      />
      <Button3D
        label={confirming ? t("memories.confirmOff") : t("memories.off")}
        width={0.16}
        color={!storeChat ? ACTIVE : confirming ? "#a33a2e" : IDLE}
        position={[0.01, y, 0]}
        onPress={() => {
          if (!storeChat) return;
          if (!confirming) return setConfirming(true);
          setConfirming(false);
          send("consent.set", { kind: "store_chat", granted: false });
        }}
      />
    </>
  );
}

/** Where the reply bubbles float; placing stays on this view, so the head can turn to the listener freely. */
function ListenerRow({ y }: { y: number }) {
  const placed = useListener((s) => s.spot !== null);
  const placing = useListener((s) => s.at !== null);
  return (
    <>
      <Text position={[LABEL_X, y, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        {t("listener.setting")}
      </Text>
      <Button3D label={t("listener.placeShort")} width={0.12} color={placed ? ACTIVE : IDLE} position={[-0.14, y, 0]} onPress={requestPlaceListener} />
      <Button3D label={t("listener.clear")} width={0.16} color={IDLE} disabled={!placed && !placing} position={[0.01, y, 0]} onPress={clearListener} />
    </>
  );
}
