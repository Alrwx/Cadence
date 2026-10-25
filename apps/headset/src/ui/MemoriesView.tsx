// Quick memories the gateway passes to suggestions, each deletable.
import { Text } from "@react-three/drei";
import { useEffect, useState } from "react";
import { layout } from "../config.ts";
import { useMemories } from "../memories.ts";
import { send } from "../session.ts";
import { t } from "../strings.ts";
import { DeleteButton, ListTabs } from "./ConversationsView.tsx";
import { Pager } from "./controls.tsx";
import { GlassPanel } from "./GlassPanel.tsx";
import { TEXT_HALO } from "./glass.ts";

const PAGE_SIZE = 4;
// Two lines at most, so a long summary can't spill out of its card or under "Really delete?".
const SUMMARY_CHARS = 90;
const CARD_STEP = 0.084;

export function MemoriesView() {
  const items = useMemories((s) => s.items);
  const [page, setPage] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const shown = Math.min(page, pages - 1);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), layout.confirmMs);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <>
      <ListTabs tab="memories" />
      <Text position={[-0.347, 0.27, 0]} fontSize={0.019} anchorX="left" color="white" {...TEXT_HALO}>
        {items.length ? t("memories.heading") : t("memories.empty")}
      </Text>
      {items.slice(shown * PAGE_SIZE, (shown + 1) * PAGE_SIZE).map((m, i) => (
        <GlassPanel key={m.id} width={0.694} height={0.072} radius={0.026} position={[0, 0.215 - i * CARD_STEP, 0]}>
          <Text position={[-0.32, 0, 0.004]} fontSize={0.018} maxWidth={0.46} anchorX="left" color="white" {...TEXT_HALO}>
            {m.summary.length > SUMMARY_CHARS ? `${m.summary.slice(0, SUMMARY_CHARS)}…` : m.summary}
          </Text>
          <DeleteButton
            confirming={confirming === m.id}
            label={t("memories.delete")}
            confirmLabel={t("memories.confirmDelete")}
            x={0.308}
            onPress={() => {
              if (confirming !== m.id) return setConfirming(m.id);
              setConfirming(null);
              send("memory.delete", { memoryId: m.id });
            }}
          />
        </GlassPanel>
      ))}
      <Pager page={shown} pages={pages} onPage={setPage} halfSpan={0.402} y={0.089} dotsY={-0.1} />
    </>
  );
}
