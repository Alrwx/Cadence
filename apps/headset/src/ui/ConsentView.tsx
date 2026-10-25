// Asks for store_chat consent the first time "Remember this" is pressed without it.
import { Text } from "@react-three/drei";
import { layout } from "../config.ts";
import { expectMemory } from "../memories.ts";
import { send } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { notify, showView } from "./views.ts";

export function remember(): void {
  expectMemory();
  send("memory.save", {});
  notify(t("memories.remembering"));
}

// Below every main-view button, so the head resting here after a choice can't dwell on one.
const BUTTON_Y = -0.35;

export function ConsentView() {
  const row = layout.buttonHeight + 0.03;
  return (
    <group position={[0, 0.12, 0]}>
      <Text fontSize={layout.fontSize} maxWidth={0.9} textAlign="center" color="white">
        {t("memories.consentQuestion")}
      </Text>
      <Text position={[0, -0.6 * row, 0]} fontSize={0.018} maxWidth={0.9} textAlign="center" color="#ddd">
        {t("memories.consentDetail")}
      </Text>
      <Button3D
        label={t("memories.allow")}
        width={0.3}
        color="#2e7d4f"
        position={[-0.17, BUTTON_Y, 0]}
        onPress={() => {
          send("consent.set", { kind: "store_chat", granted: true });
          remember();
          showView({ kind: "main" });
        }}
      />
      <Button3D label={t("memories.notNow")} width={0.3} color="#3d4a5c" position={[0.17, BUTTON_Y, 0]} onPress={() => showView({ kind: "main" })} />
    </group>
  );
}
