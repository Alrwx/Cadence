// Saved phrases: a tab per group and big phrase buttons a page at a time. A phrase speaks as-is, or,
// after "Edit first", opens in the compose keyboard. Adding and organizing phrases happens on the phone.
import { Text } from "@react-three/drei";
import type { PhrasesGroup } from "@cadence/protocol";
import { useState } from "react";
import { layout } from "../config.ts";
import { rememberSpeech, send, useCadence } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { showView, startCompose, useView } from "./views.ts";

const TABS_Y = 0.12;
const GRID_TOP = 0.035;
const ROW = 0.085;
const COLUMNS = 2;
const PAGE_SIZE = 6;
const PHRASE_WIDTH = 0.44;
const ACTIONS_Y = -0.225;

export function SavedPhrasesView() {
  const groups = useCadence((s) => s.phraseGroups);
  const groupId = useView((s) => s.groupId);
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const [page, setPage] = useState(0);
  const [editFirst, setEditFirst] = useState(false);

  const openGroup = (id: string) => {
    useView.setState({ groupId: id });
    setPage(0);
  };

  const items = group?.items ?? [];
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const shownPage = Math.min(page, pages - 1);
  const shown = items.slice(shownPage * PAGE_SIZE, (shownPage + 1) * PAGE_SIZE);

  return (
    <>
      <GroupTabs groups={groups} activeId={group?.id} onOpen={openGroup} />
      {shown.length === 0 && (
        <Text position={[0, GRID_TOP - ROW, 0]} fontSize={layout.fontSize} color="#9ab">
          {group ? t("saved.empty") : t("saved.noGroups")}
        </Text>
      )}
      {shown.map((item, i) => (
        <Button3D
          key={item.id}
          label={item.text}
          width={PHRASE_WIDTH}
          position={[((i % COLUMNS) - (COLUMNS - 1) / 2) * (PHRASE_WIDTH + 0.02), GRID_TOP - Math.floor(i / COLUMNS) * ROW, 0]}
          onPress={() => {
            if (editFirst) return startCompose(item.text);
            rememberSpeech(item.text, false);
            send("phrase.speak", { phraseId: item.id });
          }}
        />
      ))}
      {pages > 1 && (
        <>
          <Button3D label={t("saved.prev")} width={0.1} disabled={shownPage === 0} position={[-0.56, GRID_TOP - ROW, 0]} onPress={() => setPage(shownPage - 1)} />
          <Button3D label={t("saved.more")} width={0.1} disabled={shownPage === pages - 1} position={[0.56, GRID_TOP - ROW, 0]} onPress={() => setPage(shownPage + 1)} />
        </>
      )}
      <group position={[0, ACTIONS_Y, 0]}>
        <Button3D label={t("saved.back")} width={0.2} position={[-0.15, 0, 0]} onPress={() => showView({ kind: "main" })} />
        <Button3D
          label={editFirst ? t("saved.pickToEdit") : t("saved.editFirst")}
          width={0.2}
          selected={editFirst}
          position={[0.15, 0, 0]}
          onPress={() => setEditFirst(!editFirst)}
        />
      </group>
    </>
  );
}

function GroupTabs({ groups, activeId, onOpen }: { groups: PhrasesGroup[]; activeId: string | undefined; onOpen: (id: string) => void }) {
  const x = (i: number) => (i - (groups.length - 1) / 2) * 0.17;
  return (
    <group position={[0, TABS_Y, 0]}>
      {groups.map((g, i) => (
        <Button3D key={g.id} label={g.name} width={0.16} height={0.05} selected={g.id === activeId} position={[x(i), 0, 0]} onPress={() => onOpen(g.id)} />
      ))}
    </group>
  );
}
