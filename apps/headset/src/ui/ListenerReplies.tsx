// Suggested replies: on the panel, or beside the listener once the user has shown where they are.
import { Text } from "@react-three/drei";
import type { SuggestionsItem } from "@cadence/protocol";
import { layout } from "../config.ts";
import { ListenerAnchor } from "../layout/ListenerAnchor.tsx";
import { rememberSpeech, send, useCadence } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { ACCENT, ignoreRays } from "./glass.ts";
import { useMoreMenu } from "./MoreMenu.tsx";
import { useView } from "./views.ts";

const REPLY_Y = 0.239;
const REPLY_HEIGHT = layout.buttonHeight * 1.4;

/** The bubbles show when the panel would show its replies; the anchor stays mounted to keep its spot and countdown. */
export function ListenerReplies() {
  const onMain = useView((s) => s.view.kind === "main");
  const composing = useCadence((s) => s.state === "COMPOSING");
  return <ListenerAnchor>{onMain && !composing && <Replies stacked />}</ListenerAnchor>;
}

/** On the panel, a row above the instant phrases; beside the listener, a column, top reply first. */
export function Replies({ stacked = false }: { stacked?: boolean }) {
  const suggestions = useCadence((s) => s.suggestions);
  const turnId = useCadence((s) => s.turnId);
  const state = useCadence((s) => s.state);
  const menuOpen = useMoreMenu((s) => s.open);
  const y = stacked ? 0 : REPLY_Y;

  if (suggestions.length === 0) {
    return (
      <Text position={[0, y, 0]} fontSize={layout.fontSize} color="#9ab">
        {state === "SUGGESTING" ? t("status.suggesting") : ""}
      </Text>
    );
  }
  return (
    <group position={[0, y, 0]}>
      {suggestions.map((item, i) => (
        <Button3D
          key={item.id}
          label={item.text}
          position={stacked ? [0, ((suggestions.length - 1) / 2 - i) * (REPLY_HEIGHT + 0.02), 0] : [(i - (suggestions.length - 1) / 2) * (layout.buttonWidth + 0.02), 0, 0]}
          height={REPLY_HEIGHT}
          radius={0.028}
          align="start"
          disabled={menuOpen}
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

/** A question mark or Y/N for the kind of reply, and a dot that lights up when its audio is ready. */
function ReplyBadges({ item }: { item: SuggestionsItem }) {
  const top = REPLY_HEIGHT / 2 - 0.016;
  return (
    <>
      <mesh position={[layout.buttonWidth / 2 - 0.021, top, 0.004]} raycast={ignoreRays}>
        <circleGeometry args={[0.005, 16]} />
        <meshBasicMaterial color={item.audioReady ? ACCENT : "white"} transparent opacity={item.audioReady ? 1 : 0.4} depthWrite={false} />
      </mesh>
      {KIND_MARK[item.kind] && (
        <Text
          raycast={ignoreRays}
          position={[-layout.buttonWidth / 2 + 0.024, top, 0.004]}
          fontSize={0.014}
          color="white"
          fillOpacity={0.8}
          anchorX="left"
        >
          {KIND_MARK[item.kind]}
        </Text>
      )}
    </>
  );
}
