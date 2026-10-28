// Suggested replies, instant phrases, "Type my own", the way into saved phrases, and the More menu.
import { Text } from "@react-three/drei";
import { useEffect } from "react";
import { gesturePhrases } from "../config.ts";
import { requestPlaceListener, useListener } from "../layout/ListenerAnchor.tsx";
import type { Gesture } from "../gestures/classify.ts";
import { fireGesture } from "../gestures/HandGestures.tsx";
import { useMemories } from "../memories.ts";
import { send, useCadence, useHeadset } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { ACCENT, TEXT_HALO, ignoreRays } from "./glass.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { Icon3D } from "./Icon3D.tsx";
import type { IconName } from "./icons.ts";
import { Replies } from "./ListenerReplies.tsx";
import { MoreMenu, useMoreMenu } from "./MoreMenu.tsx";
import { notify, NOTICE_MS, showView, startCompose, useView } from "./views.ts";

const PROMPT_Y = 0.348;
const CHIP_Y = 0.069;
const CHIP_HEIGHT = 0.05;
const CHIP_FONT = 0.018;
const INSTANT_Y = -0.01;
const BOTTOM_Y = -0.105;
const MORE_X = 0.238;
const MORE_SIZE = 0.07;

const GESTURE_ICONS: Record<Gesture, IconName> = { thumbsUp: "thumbsUp", thumbsDown: "thumbsDown", openPalm: "hand" };

export function MainView() {
  const listenerPlaced = useListener((s) => s.spot !== null);
  const menuOpen = useMoreMenu((s) => s.open);
  useEffect(() => () => useMoreMenu.setState({ open: false }), []);

  return (
    <>
      {!menuOpen && <ListenerPrompt />}
      {!listenerPlaced && <Replies />}
      <ChipSlot disabled={menuOpen} />
      <InstantRow disabled={menuOpen} />
      <group position={[0, BOTTOM_Y, 0]}>
        <Button3D label={t("main.typeMyOwn")} icon="keyboard" width={0.236} position={[-0.155, 0, 0]} disabled={menuOpen} onPress={() => startCompose()} />
        <Button3D
          label={t("main.phrases")}
          icon="bookmark"
          width={0.2}
          position={[0.083, 0, 0]}
          disabled={menuOpen}
          onPress={() => showView({ kind: "saved" })}
        />
        <Button3D
          label={menuOpen ? t("main.closeMenu") : t("main.more")}
          icon={menuOpen ? "close" : "more"}
          iconOnly
          width={MORE_SIZE}
          selected={menuOpen}
          position={[MORE_X, 0, 0]}
          onPress={() => useMoreMenu.setState({ open: !menuOpen })}
        />
      </group>
      {/* Clear of the More button, so the dwell that opened the menu can't land on a row. */}
      {menuOpen && <MoreMenu right={MORE_X + MORE_SIZE / 2} bottom={BOTTOM_Y + MORE_SIZE / 2 + 0.016} />}
    </>
  );
}

/** Asked once per page load, on the main view only. */
function ListenerPrompt() {
  const prompted = useListener((s) => s.prompted);
  if (prompted) return null;
  return (
    <GlassPanel width={0.64} height={0.07} position={[0, PROMPT_Y, 0]}>
      <Icon3D name="user" size={0.024} color={ACCENT} position={[-0.29, 0, 0.004]} />
      <Text
        raycast={ignoreRays}
        position={[-0.268, 0, 0.004]}
        fontSize={0.019}
        anchorX="left"
        anchorY="middle"
        color="white"
        {...TEXT_HALO}
      >
        {t("listener.prompt")}
      </Text>
      <Button3D
        label={t("listener.place")}
        icon="crosshair"
        variant="primary"
        width={0.2}
        height={CHIP_HEIGHT}
        fontSize={CHIP_FONT}
        position={[0.085, 0, 0.004]}
        onPress={requestPlaceListener}
      />
      <Button3D
        label={t("listener.skip")}
        width={0.1}
        height={CHIP_HEIGHT}
        fontSize={CHIP_FONT}
        position={[0.26, 0, 0.004]}
        onPress={() => useListener.setState({ prompted: true })}
      />
    </GlassPanel>
  );
}

function InstantRow({ disabled }: { disabled: boolean }) {
  return (
    <group position={[0, INSTANT_Y, 0]}>
      {(Object.keys(gesturePhrases) as Gesture[]).map((gesture, i) => (
        <Button3D
          key={gesture}
          label={t(gesturePhrases[gesture].label)}
          icon={GESTURE_ICONS[gesture]}
          width={0.172}
          position={[(i - 1) * 0.192, 0, 0]}
          disabled={disabled}
          onPress={() => fireGesture(gesture)}
        />
      ))}
    </group>
  );
}

/**
 * Undo for a memory just saved from the menu, while it is announced; else saving the last reply or typed message
 * to the group last opened in Saved phrases (or the first group); else empty, with its row kept.
 */
function ChipSlot({ disabled }: { disabled: boolean }) {
  const lastSpoken = useHeadset((s) => s.lastSpoken);
  const groups = useCadence((s) => s.phraseGroups);
  const groupId = useView((s) => s.groupId);
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const justSaved = useMemories((s) => s.justSaved);

  useEffect(() => {
    if (!justSaved) return;
    notify(t("memories.remembered", { summary: justSaved.summary }));
    // Undo lasts as long as the announcement, so it never shows without saying what it would undo.
    const timer = setTimeout(() => useMemories.setState({ justSaved: null }), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [justSaved]);

  if (justSaved) {
    return (
      <Button3D
        label={t("memories.undo")}
        icon="undo"
        width={0.16}
        height={CHIP_HEIGHT}
        fontSize={CHIP_FONT}
        position={[0, CHIP_Y, 0]}
        disabled={disabled}
        onPress={() => {
          send("memory.delete", { memoryId: justSaved.id });
          useMemories.setState({ justSaved: null });
        }}
      />
    );
  }
  if (!lastSpoken || !group) return null;
  return (
    <Button3D
      label={t("main.save", { group: group.name, text: lastSpoken })}
      icon="bookmarkPlus"
      width={0.56}
      height={CHIP_HEIGHT}
      fontSize={CHIP_FONT}
      position={[0, CHIP_Y, 0]}
      disabled={disabled}
      onPress={() => {
        send("phrase.save", { text: lastSpoken, groupId: group.id });
        useHeadset.setState({ lastSpoken: null });
        notify(t("status.savedTo", { group: group.name }));
      }}
    />
  );
}
