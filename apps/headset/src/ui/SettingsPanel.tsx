// Input mode, dwell time, glass or solid buttons, memories and the listener, a row card each. Every control works by hand
// and by head, except switching to hands-only, which a user who can't pinch must not be able to trigger by looking.
import { Text } from "@react-three/drei";
import { useEffect, useState } from "react";
import { layout, selection } from "../config.ts";
import { useConsent } from "../consent.ts";
import { clearListener, requestPlaceListener, useListener } from "../layout/ListenerAnchor.tsx";
import { send } from "../session.ts";
import { useSettings, type InputMode } from "../settings.ts";
import { t } from "../strings.ts";
import { BackButton, HEADER_Y, Segmented, segmentedWidth, type SegmentedOption } from "./controls.tsx";
import { GlassPanel } from "./GlassPanel.tsx";
import { TEXT_HALO } from "./glass.ts";

const CARD_WIDTH = 0.76;
const CARD_HEIGHT = 0.068;
const CARD_RADIUS = 0.026;
const CARD_STEP = CARD_HEIGHT + 0.012;
const TOP_CARD_Y = 0.26;
const LABEL_X = -0.355;
/** Where every row's choices end, so their right edges line up (meters). */
const TRACK_RIGHT = 0.368;

const cardY = (row: number) => TOP_CARD_Y - row * CARD_STEP;

export function SettingsPanel() {
  const mode = useSettings((s) => s.inputMode);
  const dwellMs = useSettings((s) => s.dwellMs);
  const solid = useSettings((s) => s.solidPanels);

  const modes: SegmentedOption<InputMode>[] = [
    { value: "hands", label: t("settings.hands"), icon: "hand", headSelectable: false },
    { value: "head", label: t("settings.head"), icon: "eye" },
    { value: "both", label: t("settings.both") },
  ];

  return (
    <>
      <BackButton />
      <Text position={[0, HEADER_Y, 0]} fontSize={0.026} anchorX="center" anchorY="middle" color="white" {...TEXT_HALO}>
        {t("settings.title")}
      </Text>
      <Row
        y={cardY(0)}
        label={t("settings.selectWith")}
        hint={t("settings.selectWithHint")}
        options={modes}
        value={mode}
        optionWidth={0.14}
        onChange={(inputMode) => useSettings.setState({ inputMode })}
      />
      <Row
        y={cardY(1)}
        label={t("settings.holdTime")}
        hint={t("settings.holdTimeHint")}
        options={selection.dwellChoicesMs.map((ms) => ({ value: ms, label: t("settings.seconds", { n: ms / 1000 }) }))}
        value={dwellMs}
        optionWidth={0.096}
        onChange={(ms) => useSettings.setState({ dwellMs: ms })}
      />
      <Row
        y={cardY(2)}
        label={t("settings.panels")}
        options={[
          { value: "glass", label: t("settings.glass") },
          { value: "solid", label: t("settings.solid") },
        ]}
        value={solid ? "solid" : "glass"}
        optionWidth={0.096}
        onChange={(look) => useSettings.setState({ solidPanels: look === "solid" })}
      />
      <MemoriesRow y={cardY(3)} />
      <ListenerRow y={cardY(4)} />
    </>
  );
}

interface RowProps<T> {
  y: number;
  label: string;
  hint?: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  optionWidth: number;
}

function Row<T extends string | number | null>({ y, label, hint, options, value, onChange, optionWidth }: RowProps<T>) {
  const trackX = TRACK_RIGHT - segmentedWidth(options.length, optionWidth) / 2;
  return (
    <GlassPanel width={CARD_WIDTH} height={CARD_HEIGHT} radius={CARD_RADIUS} position={[0, y, 0]}>
      <Text position={[LABEL_X, hint ? 0.011 : 0, 0]} fontSize={0.02} anchorX="left" anchorY="middle" color="white" {...TEXT_HALO}>
        {label}
      </Text>
      {hint && (
        <Text position={[LABEL_X, -0.013, 0]} fontSize={0.015} anchorX="left" anchorY="middle" color="white" fillOpacity={0.85} {...TEXT_HALO}>
          {hint}
        </Text>
      )}
      {/* Just in front of the card: at the same depth the card could draw over the tray. */}
      <Segmented options={options} value={value} onChange={onChange} position={[trackX, 0, 0.001]} optionWidth={optionWidth} />
    </GlassPanel>
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
    <Row
      y={y}
      label={t("memories.setting")}
      hint={t("memories.settingHint")}
      options={[
        { value: "on", label: t("memories.on") },
        { value: "off", label: confirming ? t("memories.confirmOff") : t("memories.off"), danger: confirming },
      ]}
      value={storeChat ? "on" : "off"}
      optionWidth={0.16}
      onChange={(choice) => {
        if (choice === "on") return send("consent.set", { kind: "store_chat", granted: true });
        if (!storeChat) return;
        if (!confirming) return setConfirming(true);
        setConfirming(false);
        send("consent.set", { kind: "store_chat", granted: false });
      }}
    />
  );
}

/** Where the reply bubbles float; placing stays on this view, so the head can turn to the listener freely. */
function ListenerRow({ y }: { y: number }) {
  const placed = useListener((s) => s.spot !== null);
  const placing = useListener((s) => s.at !== null);
  return (
    <Row<"place" | "clear" | null>
      y={y}
      label={t("listener.setting")}
      hint={t("listener.settingHint")}
      options={[
        { value: "place", label: t("listener.placeShort"), icon: "crosshair" },
        { value: "clear", label: t("listener.clear"), icon: "close", disabled: !placed && !placing },
      ]}
      value={placed ? "place" : null}
      optionWidth={0.13}
      onChange={(choice) => (choice === "place" ? requestPlaceListener() : clearListener())}
    />
  );
}
