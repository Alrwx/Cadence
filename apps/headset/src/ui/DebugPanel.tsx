// In-headset debug panel (?debug): frame rate, live hand measures for tuning gesture thresholds,
// recent outgoing events, and the hand recorder.
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import { layout } from "../config.ts";
import { RECORDING_LABELS, startRecording, useRecorder } from "../dev/handRecorder.ts";
import { useHandReadout } from "../gestures/HandGestures.tsx";
import { useCadence, useHeadset } from "../session.ts";
import { Button3D } from "./Button3D.tsx";

export function DebugPanel() {
  const fps = useFps();
  const hands = useHandReadout((s) => s.hands);
  const connection = useCadence((s) => s.connection);
  const state = useCadence((s) => s.state);
  const sent = useHeadset((s) => s.sent);
  const recorder = useRecorder();

  const lines = [
    `${fps} fps · gateway ${connection} · ${state}`,
    ...(["left", "right"] as const).map((side) => {
      const h = hands[side];
      if (!h) return `${side}: not tracked`;
      const m = h.measures;
      return `${side}: ${h.gesture ?? "–"}  fingers ${m.fingerReach.map((r) => r.toFixed(2)).join(" ")}  thumb ${m.thumbReach.toFixed(2)}  pinch ${m.pinchGap.toFixed(2)}  thumbUp ${m.thumbUp.toFixed(2)}  fingersUp ${m.fingersUp.toFixed(2)}  palmAway ${m.palmAway.toFixed(2)}`;
    }),
    ...sent.slice(-4).reverse().map((e) => `sent ${e.type} ${JSON.stringify(e.data)}`),
    recorder.status,
  ];

  return (
    <group position={layout.debugPanelOffset} rotation={[0, layout.debugPanelYaw, 0]}>
      {RECORDING_LABELS.map((label, i) => (
        <Button3D
          key={label}
          label={`Rec ${SHORT[label]}`}
          width={0.14}
          height={0.045}
          disabled={recorder.label !== null}
          position={[-0.3 + i * 0.15, 0, 0]}
          onPress={() => startRecording(label)}
        />
      ))}
      <Text position={[-0.37, -0.04, 0]} fontSize={0.013} lineHeight={1.4} anchorX="left" anchorY="top" color="#cfe" maxWidth={0.74}>
        {lines.join("\n")}
      </Text>
    </group>
  );
}

const SHORT: Record<(typeof RECORDING_LABELS)[number], string> = {
  thumbsUp: "up",
  thumbsDown: "down",
  openPalm: "palm",
  relaxed: "rest",
  pinch: "pinch",
};

function useFps(): number {
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  const since = useRef(performance.now());
  useFrame(() => {
    frames.current++;
    const now = performance.now();
    if (now - since.current >= 1000) {
      setFps(Math.round((frames.current * 1000) / (now - since.current)));
      frames.current = 0;
      since.current = now;
    }
  });
  return fps;
}
