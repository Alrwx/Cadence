// Suggested replies, instant phrases, "Type my own", and the way into saved phrases.
import { Text } from "@react-three/drei";
import type { SuggestionsItem } from "@cadence/protocol";
import { gesturePhrases, layout } from "../config.ts";
import type { Gesture } from "../gestures/classify.ts";
import { fireGesture } from "../gestures/HandGestures.tsx";
import { rememberSpeech, send, useCadence, useHeadset } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { notify, showView, startCompose, useView } from "./views.ts";

const REPLY_Y = 0.12;
const REPLY_HEIGHT = layout.buttonHeight * 1.4;
const INSTANT_Y = -0.01;
const SAVED_Y = -0.105;

export function MainView() {
  return (
    <>
      <Replies />
      <InstantRow />
      <group position={[0, SAVED_Y, 0]}>
        <Button3D label={t("main.savedPhrases")} width={0.3} color="#8a6a2a" position={[-0.17, 0, 0]} onPress={() => showView({ kind: "saved" })} />
        <BookmarkButton />
      </group>
    </>
  );
}

function Replies() {
  const suggestions = useCadence((s) => s.suggestions);
  const turnId = useCadence((s) => s.turnId);
  const state = useCadence((s) => s.state);

  if (suggestions.length === 0) {
    return (
      <Text position={[0, REPLY_Y, 0]} fontSize={layout.fontSize} color="#9ab">
        {state === "SUGGESTING" ? t("status.suggesting") : ""}
      </Text>
    );
  }
  return (
    <group position={[0, REPLY_Y, 0]}>
      {suggestions.map((item, i) => (
        <Button3D
          key={item.id}
          label={item.text}
          position={[(i - (suggestions.length - 1) / 2) * (layout.buttonWidth + 0.02), 0, 0]}
          height={REPLY_HEIGHT}
          onPress={() => {
            rememberSpeech(item.text, true);
            send("select", { suggestionId: item.id }, turnId);
          }}
        >
          <ReplyBadges item={item} />
        </Button3D>
      ))}
    </group>
  );
}

const KIND_MARK: Record<SuggestionsItem["kind"], string> = { statement: "", question: "?", yes_no: "Y/N" };

/** A question mark or Y/N for the kind of reply, and a dot that turns green when its audio is ready. */
function ReplyBadges({ item }: { item: SuggestionsItem }) {
  const corner = [layout.buttonWidth / 2 - 0.018, REPLY_HEIGHT / 2 - 0.016, 0.01] as const;
  return (
    <>
      <mesh position={corner}>
        <circleGeometry args={[0.007, 16]} />
        <meshBasicMaterial color={item.audioReady ? "#5fd38d" : "#778"} />
      </mesh>
      {KIND_MARK[item.kind] && (
        <Text position={[-layout.buttonWidth / 2 + 0.02, REPLY_HEIGHT / 2 - 0.016, 0.01]} fontSize={0.014} color="#cde" anchorX="left">
          {KIND_MARK[item.kind]}
        </Text>
      )}
    </>
  );
}

function InstantRow() {
  return (
    <group position={[0, INSTANT_Y, 0]}>
      {(Object.keys(gesturePhrases) as Gesture[]).map((gesture, i) => (
        <Button3D
          key={gesture}
          label={t(gesturePhrases[gesture].label)}
          width={0.16}
          color="#2e7d4f"
          position={[(i - 1.5) * 0.18, 0, 0]}
          onPress={() => fireGesture(gesture)}
        />
      ))}
      <Button3D label={t("main.typeMyOwn")} width={0.2} color="#7a4fa0" position={[1.5 * 0.18 + 0.02, 0, 0]} onPress={() => startCompose()} />
    </group>
  );
}

/** Saves the last reply or typed message to the group last opened in Saved phrases (or the first group). */
function BookmarkButton() {
  const lastSpoken = useHeadset((s) => s.lastSpoken);
  const groups = useCadence((s) => s.phraseGroups);
  const groupId = useView((s) => s.groupId);
  const group = groups.find((g) => g.id === groupId) ?? groups[0];

  return (
    <Button3D
      label={t("main.bookmark")}
      width={0.3}
      color="#5a4a2a"
      position={[0.17, 0, 0]}
      disabled={!lastSpoken || !group}
      onPress={() => {
        if (!lastSpoken || !group) return;
        send("phrase.save", { text: lastSpoken, groupId: group.id });
        useHeadset.setState({ lastSpoken: null });
        notify(t("status.savedTo", { group: group.name }));
      }}
    />
  );
}
