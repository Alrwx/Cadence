// Save the current conversation, and attach saved ones as context for this session's suggestions.
import { Text } from "@react-three/drei";
import { useEffect, useState } from "react";
import { layout } from "../config.ts";
import { toggleAttached, useConversations } from "../conversations.ts";
import { send } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { BackButton, HEADER_Y, Pager, Segmented } from "./controls.tsx";
import { ACCENT, TEXT_HALO } from "./glass.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { Icon3D } from "./Icon3D.tsx";
import { showView } from "./views.ts";
import { getLocale } from "@cadence/shared/i18n";

// Typing a label in XR is slow, so a save is one press: a preset plus today's date.
const PAGE_SIZE = 3;
// Two lines at most within TEXT_WIDTH, so a long summary can't run under the Attach pill.
const SUMMARY_CHARS = 60;
const TEXT_X = -0.32;
const TEXT_WIDTH = 0.27;
const CARD_HEIGHT = 0.088;
const CARD_STEP = 0.102;
const CHIP_HEIGHT = 0.05;
const SMALL_FONT = 0.018;
const DELETE_SIZE = 0.052;
const CONFIRM_WIDTH = 0.18;

/** The header both list tabs share: Back, and the Conversations | Memories switch. */
export function ListTabs({ tab }: { tab: "conversations" | "memories" }) {
  return (
    <>
      <BackButton />
      <Segmented
        options={[
          { value: "conversations", label: t("top.conversations"), icon: "message" },
          { value: "memories", label: t("memories.tab"), icon: "bookOpen" },
        ]}
        value={tab}
        onChange={(next) => showView(next === "memories" ? { kind: "conversations", tab: "memories" } : { kind: "conversations" })}
        position={[0, HEADER_Y, 0]}
        optionWidth={0.21}
      />
    </>
  );
}

interface DeleteProps {
  confirming: boolean;
  label: string;
  confirmLabel: string;
  /** Center of the Delete circle; the wider confirm pill keeps its right edge. */
  x: number;
  onPress: () => void;
}

/** A trash circle that becomes the danger pill asking to confirm. */
export function DeleteButton({ confirming, label, confirmLabel, x, onPress }: DeleteProps) {
  return confirming ? (
    <Button3D
      label={confirmLabel}
      variant="danger"
      width={CONFIRM_WIDTH}
      height={DELETE_SIZE}
      fontSize={SMALL_FONT}
      position={[x + (DELETE_SIZE - CONFIRM_WIDTH) / 2, 0, 0]}
      onPress={onPress}
    />
  ) : (
    <Button3D label={label} icon="trash" iconOnly width={DELETE_SIZE} height={DELETE_SIZE} position={[x, 0, 0]} onPress={onPress} />
  );
}

export function ConversationsView() {
  const items = useConversations((s) => s.items);
  const attached = useConversations((s) => s.attached);
  const [page, setPage] = useState(0);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const shown = Math.min(page, pages - 1);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), layout.confirmMs);
    return () => clearTimeout(timer);
  }, [confirming]);

  const save = (preset: string) => {
    const date = new Date().toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
    const label = t("conversations.label", { preset, date });
    send("conversation.save", { label });
    setSavedAs(label);
  };

  return (
    <>
      <ListTabs tab="conversations" />
      <Text position={[-0.19, 0.26, 0]} fontSize={0.019} anchorX="right" color="white" {...TEXT_HALO}>
        {t("conversations.saveAs")}
      </Text>
      {t("conversations.presets")
        .split("|")
        .map((preset, i) => (
          <Button3D
            key={preset}
            label={preset}
            width={0.11}
            height={CHIP_HEIGHT}
            fontSize={SMALL_FONT}
            position={[-0.12 + i * 0.13, 0.26, 0]}
            onPress={() => save(preset)}
          />
        ))}
      {savedAs && <Icon3D name="check" size={0.02} color={ACCENT} position={[-0.337, 0.205, 0]} />}
      <Text position={[savedAs ? -0.32 : -0.347, 0.205, 0]} fontSize={SMALL_FONT} anchorX="left" color="white" {...TEXT_HALO}>
        {savedAs ? t("conversations.savedAs", { label: savedAs }) : items.length ? t("conversations.useAsContext") : t("conversations.empty")}
      </Text>
      {items.slice(shown * PAGE_SIZE, (shown + 1) * PAGE_SIZE).map((c, i) => {
        const isAttached = attached.includes(c.id);
        const summary = c.summary && c.summary.length > SUMMARY_CHARS ? `${c.summary.slice(0, SUMMARY_CHARS)}…` : c.summary;
        return (
          <GlassPanel key={c.id} width={0.694} height={CARD_HEIGHT} radius={0.026} position={[0, 0.145 - i * CARD_STEP, 0]}>
            <Text
              position={[TEXT_X, summary ? 0.03 : 0, 0.004]}
              fontSize={0.02}
              maxWidth={TEXT_WIDTH}
              anchorX="left"
              anchorY={summary ? "top" : "middle"}
              color="white"
              {...TEXT_HALO}
            >
              {c.label}
            </Text>
            {summary && (
              <Text
                position={[TEXT_X, 0.004, 0.004]}
                fontSize={0.015}
                maxWidth={TEXT_WIDTH}
                anchorX="left"
                anchorY="top"
                color="white"
                fillOpacity={0.88}
                {...TEXT_HALO}
              >
                {summary}
              </Text>
            )}
            <Button3D
              label={isAttached ? t("conversations.attached") : t("conversations.attach")}
              icon={isAttached ? "check" : "paperclip"}
              selected={isAttached}
              width={0.16}
              height={DELETE_SIZE}
              fontSize={SMALL_FONT}
              position={[0.05, 0, 0]}
              onPress={() => send("conversation.attach", { conversationIds: toggleAttached(c.id) })}
            />
            <DeleteButton
              confirming={confirming === c.id}
              label={t("conversations.delete")}
              confirmLabel={t("conversations.confirmDelete")}
              x={0.308}
              onPress={() => {
                if (confirming !== c.id) return setConfirming(c.id);
                setConfirming(null);
                send("conversation.delete", { conversationId: c.id });
              }}
            />
          </GlassPanel>
        );
      })}
      <Pager page={shown} pages={pages} onPage={setPage} halfSpan={0.402} y={0.043} dotsY={-0.12} />
    </>
  );
}
