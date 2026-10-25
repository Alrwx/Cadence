// Save the current conversation, and attach saved ones as context for this session's suggestions.
import { Text } from "@react-three/drei";
import { useEffect, useState } from "react";
import { layout } from "../config.ts";
import { toggleAttached, useConversations } from "../conversations.ts";
import { send } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { showView } from "./views.ts";

// Typing a label in XR is slow, so a save is one press: a preset plus today's date.
const PAGE_SIZE = 3;
const SUMMARY_CHARS = 70;
const LABEL_X = -0.47;

export function ConversationsView() {
  const items = useConversations((s) => s.items);
  const attached = useConversations((s) => s.attached);
  const [page, setPage] = useState(0);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const row = layout.buttonHeight + 0.03;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const shown = Math.min(page, pages - 1);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), layout.confirmMs);
    return () => clearTimeout(timer);
  }, [confirming]);

  const save = (preset: string) => {
    const date = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const label = t("conversations.label", { preset, date });
    send("conversation.save", { label });
    setSavedAs(label);
  };

  return (
    <group position={[0, 0.12, 0]}>
      <Text position={[LABEL_X, 0, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        {t("conversations.saveAs")}
      </Text>
      {t("conversations.presets").split("|").map((preset, i) => (
        <Button3D key={preset} label={preset} width={0.15} position={[-0.24 + i * 0.17, 0, 0]} onPress={() => save(preset)} />
      ))}
      <Text position={[LABEL_X, -0.7 * row, 0]} fontSize={0.018} anchorX="left" color="#ddd">
        {savedAs ? t("conversations.savedAs", { label: savedAs }) : items.length ? t("conversations.useAsContext") : t("conversations.empty")}
      </Text>
      {items.slice(shown * PAGE_SIZE, (shown + 1) * PAGE_SIZE).map((c, i) => {
        const y = -(1.6 + i) * row;
        const isAttached = attached.includes(c.id);
        const summary = c.summary && c.summary.length > SUMMARY_CHARS ? `${c.summary.slice(0, SUMMARY_CHARS)}…` : c.summary;
        return (
          <group key={c.id} position={[0, y, 0]}>
            <Text position={[LABEL_X, 0.012, 0]} fontSize={0.02} maxWidth={0.55} anchorX="left" anchorY="bottom" color="white">
              {c.label}
            </Text>
            {summary && (
              <Text position={[LABEL_X, 0.006, 0]} fontSize={0.014} maxWidth={0.55} anchorX="left" anchorY="top" color="#bbb">
                {summary}
              </Text>
            )}
            <Button3D
              label={isAttached ? t("conversations.attached") : t("conversations.attach")}
              width={0.16}
              selected={isAttached}
              position={[0.2, 0, 0]}
              onPress={() => send("conversation.attach", { conversationIds: toggleAttached(c.id) })}
            />
            <Button3D
              label={confirming === c.id ? t("conversations.confirmDelete") : t("conversations.delete")}
              width={0.14}
              variant={confirming === c.id ? "danger" : "glass"}
              position={[0.37, 0, 0]}
              onPress={() => {
                if (confirming !== c.id) return setConfirming(c.id);
                setConfirming(null);
                send("conversation.delete", { conversationId: c.id });
              }}
            />
          </group>
        );
      })}
      <group position={[0, -(1.6 + PAGE_SIZE) * row, 0]}>
        <Button3D label={t("conversations.prev")} width={0.1} disabled={shown === 0} position={[-0.3, 0, 0]} onPress={() => setPage(shown - 1)} />
        <Button3D label={t("conversations.more")} width={0.1} disabled={shown >= pages - 1} position={[-0.18, 0, 0]} onPress={() => setPage(shown + 1)} />
        <Button3D label={t("conversations.back")} width={0.2} position={[0.05, 0, 0]} onPress={() => showView({ kind: "main" })} />
      </group>
    </group>
  );
}
