// Quick memories the gateway passes to suggestions, each deletable.
import { Text } from "@react-three/drei";
import { useEffect, useState } from "react";
import { layout } from "../config.ts";
import { useMemories } from "../memories.ts";
import { send } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { showView } from "./views.ts";

const PAGE_SIZE = 4;
const LABEL_X = -0.47;
const IDLE = "#3d4a5c";

export function MemoriesView() {
  const items = useMemories((s) => s.items);
  const [page, setPage] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const row = layout.buttonHeight + 0.03;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const shown = Math.min(page, pages - 1);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), layout.confirmMs);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <group position={[0, 0.12, 0]}>
      <Text position={[LABEL_X, 0, 0]} fontSize={layout.fontSize} anchorX="left" color="white">
        {items.length ? t("memories.heading") : t("memories.empty")}
      </Text>
      {items.slice(shown * PAGE_SIZE, (shown + 1) * PAGE_SIZE).map((m, i) => (
        <group key={m.id} position={[0, -(0.9 + i) * row, 0]}>
          <Text position={[LABEL_X, 0, 0]} fontSize={0.018} maxWidth={0.72} anchorX="left" color="white">
            {m.summary}
          </Text>
          <Button3D
            label={confirming === m.id ? t("memories.confirmDelete") : t("memories.delete")}
            width={0.14}
            color={confirming === m.id ? "#a33a2e" : IDLE}
            position={[0.37, 0, 0]}
            onPress={() => {
              if (confirming !== m.id) return setConfirming(m.id);
              setConfirming(null);
              send("memory.delete", { memoryId: m.id });
            }}
          />
        </group>
      ))}
      <group position={[0, -(0.9 + PAGE_SIZE) * row, 0]}>
        <Button3D label={t("memories.prev")} width={0.1} color={IDLE} disabled={shown === 0} position={[-0.3, 0, 0]} onPress={() => setPage(shown - 1)} />
        <Button3D label={t("memories.more")} width={0.1} color={IDLE} disabled={shown >= pages - 1} position={[-0.18, 0, 0]} onPress={() => setPage(shown + 1)} />
        <Button3D label={t("memories.back")} width={0.2} color={IDLE} position={[0.05, 0, 0]} onPress={() => showView({ kind: "main" })} />
      </group>
    </group>
  );
}
