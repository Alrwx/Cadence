// The in-headset panel: status line, top bar, and whichever view is showing.
import { Text } from "@react-three/drei";
import { useEffect } from "react";
import { layout } from "../config.ts";
import { requestRecenter, useRecenter } from "../layout/UIAnchor.tsx";
import { useCadence, useHeadset } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { MainView } from "./MainView.tsx";
import { SavedPhrasesView } from "./SavedPhrasesView.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TextEntryView } from "./TextEntryView.tsx";
import { notify, showView, useView } from "./views.ts";

// Tilted back so the panel faces the eyes from below the line of sight.
const PANEL_TILT = Math.atan2(layout.panelOffset[1], -layout.panelOffset[2]);
const QUIET = "#3d4a5c";

export function Panels() {
  const sessionState = useCadence((s) => s.state);
  const view = useView((s) => s.view);
  const error = useCadence((s) => s.lastError);

  useEffect(() => {
    if (error) notify(error.message, "error");
  }, [error]);

  let content;
  if (sessionState === "COMPOSING") content = <TextEntryView />;
  else if (view.kind === "saved") content = <SavedPhrasesView />;
  else if (view.kind === "settings") content = <SettingsPanel onClose={() => showView({ kind: "main" })} />;
  else content = <MainView />;

  const showTopBar = sessionState !== "COMPOSING" && view.kind !== "settings";
  return (
    <group position={layout.panelOffset} rotation={[PANEL_TILT, 0, 0]}>
      <StatusLine />
      {showTopBar && (
        <>
          <Button3D label={t("top.recenter")} width={0.14} height={0.045} color={QUIET} position={[-0.4, 0.27, 0]} onPress={requestRecenter} />
          <Button3D
            label={t("top.settings")}
            width={0.14}
            height={0.045}
            color={QUIET}
            position={[0.4, 0.27, 0]}
            onPress={() => showView({ kind: "settings" })}
          />
        </>
      )}
      {content}
    </group>
  );
}

function StatusLine() {
  const state = useCadence((s) => s.state);
  const partial = useCadence((s) => s.partial);
  const caption = useCadence((s) => s.captions.at(-1) ?? "");
  const speaking = useHeadset((s) => s.speaking);
  const recentering = useRecenter((s) => s.announced);
  const notice = useView((s) => s.notice);

  let text: string;
  if (recentering) text = t("status.recentering");
  else if (notice) text = notice.text;
  else if (state === "SPEAKING" && speaking) text = t("status.speaking", { text: speaking });
  else if (partial || caption) text = partial || caption;
  else if (state === "IDLE") text = t("status.idle");
  else if (state === "SUGGESTING") text = t("status.suggesting");
  else text = t("status.listening");

  const color = !recentering && notice?.tone === "error" ? "#ffb4a8" : "#ddd";
  return (
    <Text position={[0, 0.2, 0]} fontSize={0.02} maxWidth={0.9} color={color} anchorY="bottom" textAlign="center">
      {text}
    </Text>
  );
}
