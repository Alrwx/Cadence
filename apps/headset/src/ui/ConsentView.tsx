// Asks for store_chat consent at start when it's off, and when "Remember this" is pressed without it.
import { Text } from "@react-three/drei";
import { expectMemory } from "../memories.ts";
import { send } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { ACCENT, TEXT_HALO } from "./glass.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { Icon3D } from "./Icon3D.tsx";
import { notify, showView, useView } from "./views.ts";

export function remember(): void {
  expectMemory();
  send("memory.save", {});
  notify(t("memories.remembering"));
}

const CARD_Y = 0.2;
const BUTTON_Y = -0.105;
const BUTTON_GAP = 0.02;
const NOT_NOW_WIDTH = 0.18;

export function ConsentView() {
  const atStart = useView((s) => s.view.kind === "consent" && !!s.view.atStart);
  const allowWidth = atStart ? 0.18 : 0.29;
  const pairLeft = -(allowWidth + BUTTON_GAP + NOT_NOW_WIDTH) / 2;
  // Without the "later" line the rest moves down, to stay centered on the card.
  const shift = atStart ? 0 : -0.02;
  return (
    <>
      <GlassPanel width={0.64} height={0.24} radius={0.034} position={[0, CARD_Y, 0]}>
        <Icon3D name="bookOpen" size={0.036} color={ACCENT} position={[0, 0.08 + shift, 0]} />
        <Text position={[0, 0.038 + shift, 0]} fontSize={0.026} maxWidth={0.56} textAlign="center" anchorY="middle" color="white" {...TEXT_HALO}>
          {t("memories.consentQuestion")}
        </Text>
        <Text
          position={[0, -0.018 + shift, 0]}
          fontSize={0.018}
          maxWidth={0.56}
          textAlign="center"
          anchorY="middle"
          color="white"
          fillOpacity={0.9}
          {...TEXT_HALO}
        >
          {t("memories.consentDetail")}
        </Text>
        {atStart && (
          <Text position={[0, -0.076, 0]} fontSize={0.015} maxWidth={0.56} textAlign="center" anchorY="middle" color="white" fillOpacity={0.8} {...TEXT_HALO}>
            {t("memories.consentLater")}
          </Text>
        )}
      </GlassPanel>
      <Button3D
        label={atStart ? t("memories.allowAtStart") : t("memories.allow")}
        icon="check"
        variant="primary"
        width={allowWidth}
        position={[pairLeft + allowWidth / 2, BUTTON_Y, 0]}
        onPress={() => {
          send("consent.set", { kind: "store_chat", granted: true });
          // At start there is nothing yet to remember.
          if (!atStart) remember();
          showView({ kind: "main" });
        }}
      />
      <Button3D
        label={t("memories.notNow")}
        width={NOT_NOW_WIDTH}
        position={[-pairLeft - NOT_NOW_WIDTH / 2, BUTTON_Y, 0]}
        onPress={() => showView({ kind: "main" })}
      />
    </>
  );
}
