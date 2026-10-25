// The in-headset panel: the status pill, and whichever view is showing.
import { Text } from "@react-three/drei";
import { useEffect, useState } from "react";
import { layout } from "../config.ts";
import { useListener } from "../layout/ListenerAnchor.tsx";
import { useRecenter } from "../layout/UIAnchor.tsx";
import { useCadence, useHeadset } from "../session.ts";
import { t } from "../strings.ts";
import { ConsentView } from "./ConsentView.tsx";
import { ConversationsView } from "./ConversationsView.tsx";
import { ACCENT, ignoreRays } from "./glass.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { Icon3D } from "./Icon3D.tsx";
import { MainView } from "./MainView.tsx";
import { MemoriesView } from "./MemoriesView.tsx";
import { SavedPhrasesView } from "./SavedPhrasesView.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TextEntryView } from "./TextEntryView.tsx";
import { notify, showView, useConsentAtStart, useView } from "./views.ts";

// Tilted back so the panel faces the eyes from below the line of sight.
const PANEL_TILT = Math.atan2(layout.panelOffset[1], -layout.panelOffset[2]);

/** On the main view the status sits between the replies and the instant row; elsewhere, above the header. */
const STATUS_MAIN_Y = 0.139;
const STATUS_Y = 0.41;
const STATUS_HEIGHT = 0.052;
const STATUS_FONT = 0.019;
const STATUS_MAX_TEXT = 0.78;
const STATUS_PAD = 0.024;
const MIC = 0.022;
const MIC_GAP = 0.01;

export function Panels() {
  const sessionState = useCadence((s) => s.state);
  const view = useView((s) => s.view);
  const error = useCadence((s) => s.lastError);
  useConsentAtStart();

  useEffect(() => {
    if (error) notify(error.message, "error");
  }, [error]);

  let content;
  if (sessionState === "COMPOSING") content = <TextEntryView />;
  else if (view.kind === "saved") content = <SavedPhrasesView />;
  else if (view.kind === "conversations") content = view.tab === "memories" ? <MemoriesView /> : <ConversationsView />;
  else if (view.kind === "consent") content = <ConsentView />;
  else if (view.kind === "settings") content = <SettingsPanel onClose={() => showView({ kind: "main" })} />;
  else content = <MainView />;

  const onMain = sessionState !== "COMPOSING" && view.kind === "main";
  return (
    <group position={layout.panelOffset} rotation={[PANEL_TILT, 0, 0]}>
      <StatusPill y={onMain ? STATUS_MAIN_Y : STATUS_Y} />
      {content}
    </group>
  );
}

function StatusPill({ y }: { y: number }) {
  const state = useCadence((s) => s.state);
  const partial = useCadence((s) => s.partial);
  const caption = useCadence((s) => s.captions.at(-1) ?? "");
  const speaking = useHeadset((s) => s.speaking);
  const recentering = useRecenter((s) => s.announced);
  const notice = useView((s) => s.notice);
  const placing = useListener((s) => s.at !== null);
  const [textSize, setTextSize] = useState<[number, number]>([0, 0]);

  let text: string;
  let heard = false;
  if (recentering) text = t("status.recentering");
  else if (placing) text = t("listener.placing");
  else if (notice) text = notice.text;
  else if (state === "SPEAKING" && speaking) text = t("status.speaking", { text: speaking });
  else if (partial || caption) {
    text = partial || caption;
    heard = true;
  } else if (state === "IDLE") text = t("status.idle");
  else if (state === "SUGGESTING") text = t("status.suggesting");
  else text = t("status.listening");

  const color = !recentering && !placing && notice?.tone === "error" ? "#ffb4a8" : "white";
  const lead = heard ? MIC + MIC_GAP : 0;
  const [textWidth, textHeight] = textSize;
  return (
    <GlassPanel
      width={textWidth + lead + 2 * STATUS_PAD}
      // A long caption wraps, and the pill grows to hold it.
      height={Math.max(STATUS_HEIGHT, textHeight + 0.02)}
      radius={STATUS_HEIGHT / 2}
      position={[0, y, 0]}
    >
      {heard && <Icon3D name="mic" size={MIC} color={ACCENT} position={[-(textWidth + lead) / 2 + MIC / 2, 0, 0.004]} />}
      <Text
        raycast={ignoreRays}
        position={[lead / 2, 0, 0.004]}
        fontSize={STATUS_FONT}
        maxWidth={STATUS_MAX_TEXT}
        textAlign="center"
        anchorY="middle"
        color={color}
        outlineBlur={0.004}
        outlineColor="black"
        outlineOpacity={0.5}
        onSync={(troika: { textRenderInfo?: { blockBounds: [number, number, number, number] } }) => {
          const bounds = troika.textRenderInfo?.blockBounds;
          if (bounds) setTextSize([bounds[2] - bounds[0], bounds[3] - bounds[1]]);
        }}
      >
        {text}
      </Text>
    </GlassPanel>
  );
}
