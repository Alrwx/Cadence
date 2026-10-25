// The in-headset panel: status line, top bar, and whichever view is showing.
import { Text } from "@react-three/drei";
import { useEffect } from "react";
import { layout } from "../config.ts";
import { requestPlaceListener, useListener } from "../layout/ListenerAnchor.tsx";
import { requestRecenter, useRecenter } from "../layout/UIAnchor.tsx";
import { useCadence, useHeadset } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { ConsentView } from "./ConsentView.tsx";
import { ConversationsView } from "./ConversationsView.tsx";
import { MainView } from "./MainView.tsx";
import { MemoriesView } from "./MemoriesView.tsx";
import { SavedPhrasesView } from "./SavedPhrasesView.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TextEntryView } from "./TextEntryView.tsx";
import { notify, showView, useView } from "./views.ts";

// Tilted back so the panel faces the eyes from below the line of sight.
const PANEL_TILT = Math.atan2(layout.panelOffset[1], -layout.panelOffset[2]);
const QUIET = "#3d4a5c";
const ACTIVE = "#b07a1f";

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
  else if (view.kind === "conversations") content = view.tab === "memories" ? <MemoriesView /> : <ConversationsView />;
  else if (view.kind === "consent") content = <ConsentView />;
  else if (view.kind === "settings") content = <SettingsPanel onClose={() => showView({ kind: "main" })} />;
  else content = <MainView />;

  const showTopBar = sessionState !== "COMPOSING" && view.kind !== "settings";
  return (
    <group position={layout.panelOffset} rotation={[PANEL_TILT, 0, 0]}>
      <StatusLine />
      {showTopBar && <ListenerPrompt />}
      {showTopBar && (
        <>
          <Button3D label={t("top.recenter")} width={0.14} height={0.045} color={QUIET} position={[-0.4, 0.27, 0]} onPress={requestRecenter} />
          <Button3D
            label={t("top.conversations")}
            width={0.2}
            height={0.045}
            color={view.kind === "conversations" && !view.tab ? ACTIVE : QUIET}
            position={[0, 0.27, 0]}
            onPress={() => showView({ kind: "conversations" })}
          />
          {/* Beside Conversations, not splitting its spot, so a dwell that just opened it can't land on Memories. */}
          {view.kind === "conversations" && (
            <Button3D
              label={t("memories.tab")}
              width={0.16}
              height={0.045}
              color={view.tab === "memories" ? ACTIVE : QUIET}
              position={[0.2, 0.27, 0]}
              onPress={() => showView({ kind: "conversations", tab: "memories" })}
            />
          )}
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

/** Asked once per page load; the top bar's gap above keeps a dwell on Recenter or Settings from landing here. */
function ListenerPrompt() {
  const prompted = useListener((s) => s.prompted);
  if (prompted) return null;
  return (
    <group position={[0, 0.36, 0]}>
      <Text position={[-0.12, 0, 0]} fontSize={0.02} anchorX="right" color="#ddd">
        {t("listener.prompt")}
      </Text>
      <Button3D label={t("listener.place")} width={0.2} height={0.045} color="#2e6b7d" position={[0, 0, 0]} onPress={requestPlaceListener} />
      <Button3D label={t("listener.skip")} width={0.12} height={0.045} color={QUIET} position={[0.18, 0, 0]} onPress={() => useListener.setState({ prompted: true })} />
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
  const placing = useListener((s) => s.at !== null);

  let text: string;
  if (recentering) text = t("status.recentering");
  else if (placing) text = t("listener.placing");
  else if (notice) text = notice.text;
  else if (state === "SPEAKING" && speaking) text = t("status.speaking", { text: speaking });
  else if (partial || caption) text = partial || caption;
  else if (state === "IDLE") text = t("status.idle");
  else if (state === "SUGGESTING") text = t("status.suggesting");
  else text = t("status.listening");

  const color = !recentering && !placing && notice?.tone === "error" ? "#ffb4a8" : "#ddd";
  return (
    <Text position={[0, 0.2, 0]} fontSize={0.02} maxWidth={0.9} color={color} anchorY="bottom" textAlign="center">
      {text}
    </Text>
  );
}
