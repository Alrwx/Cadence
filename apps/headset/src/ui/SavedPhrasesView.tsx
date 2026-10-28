// Saved phrases: a chip per group and big phrase tiles a page at a time. A phrase speaks as-is, or,
// after "Edit first", opens in the compose keyboard. Each has a trash circle, so a bookmark can be undone here;
// adding and organizing phrases happens on the phone.
import { Text } from "@react-three/drei";
import type { PhrasesGroup } from "@cadence/protocol";
import { useState } from "react";
import { layout } from "../config.ts";
import { rememberSpeech, send, useCadence } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { BackButton, HEADER_Y, Pager, useConfirm } from "./controls.tsx";
import { ignoreRays } from "./glass.ts";
import { startCompose, useView } from "./views.ts";

const COLUMNS = 2;
const PAGE_SIZE = 6;
const COLUMN_WIDTH = 0.34;
const TILE_WIDTH = 0.274;
const DELETE_SIZE = 0.052;
const TILE_HEIGHT = 0.088;
const TILE_RADIUS = 0.028;
const COLUMN_X = 0.177;
const TOP_ROW_Y = 0.236;
const ROW_STEP = 0.108;
const MIDDLE_ROW_Y = TOP_ROW_Y - ROW_STEP;
const PAGER_X = 0.402;
const DOTS_Y = -0.049;
const EDIT_Y = -0.105;
const CHIP_HEIGHT = 0.05;
const CHIP_FONT = 0.019;
const CHIP_GAP = 0.012;

export function SavedPhrasesView() {
  const groups = useCadence((s) => s.phraseGroups);
  const groupId = useView((s) => s.groupId);
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const [page, setPage] = useState(0);
  const [editFirst, setEditFirst] = useState(false);
  const { confirming, press } = useConfirm();

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
      <BackButton />
      <GroupChips groups={groups} activeId={group?.id} onOpen={openGroup} />
      {shown.length === 0 && (
        <Text position={[0, MIDDLE_ROW_Y, 0]} fontSize={layout.fontSize} color="white" fillOpacity={0.8} raycast={ignoreRays}>
          {group ? t("saved.empty") : t("saved.noGroups")}
        </Text>
      )}
      {shown.map((item, i) => {
        const position: [number, number, number] = [((i % COLUMNS) * 2 - 1) * COLUMN_X, TOP_ROW_Y - Math.floor(i / COLUMNS) * ROW_STEP, 0];
        const remove = () => press(item.id, () => send("phrase.delete", { phraseId: item.id }));
        // The confirm covers the tile and its trash circle, so a second press on the same spot deletes.
        if (confirming === item.id) {
          return (
            <Button3D
              key={item.id}
              label={t("saved.confirmDelete", { text: item.text })}
              variant="danger"
              width={COLUMN_WIDTH}
              height={TILE_HEIGHT}
              radius={TILE_RADIUS}
              position={position}
              onPress={remove}
            />
          );
        }
        return (
          <group key={item.id} position={position}>
            <Button3D
              label={item.text}
              width={TILE_WIDTH}
              height={TILE_HEIGHT}
              radius={TILE_RADIUS}
              align="start"
              position={[(TILE_WIDTH - COLUMN_WIDTH) / 2, 0, 0]}
              onPress={() => {
                if (editFirst) return startCompose(item.text);
                rememberSpeech(item.text, false);
                send("phrase.speak", { phraseId: item.id });
              }}
            />
            <Button3D
              label={t("saved.delete", { text: item.text })}
              icon="trash"
              iconOnly
              width={DELETE_SIZE}
              height={DELETE_SIZE}
              position={[(COLUMN_WIDTH - DELETE_SIZE) / 2, 0, 0]}
              onPress={remove}
            />
          </group>
        );
      })}
      <Pager page={shownPage} pages={pages} onPage={setPage} halfSpan={PAGER_X} y={MIDDLE_ROW_Y} dotsY={DOTS_Y} />
      <Button3D
        label={editFirst ? t("saved.pickToEdit") : t("saved.editFirst")}
        icon="pencil"
        width={editFirst ? 0.25 : 0.2}
        selected={editFirst}
        position={[0, EDIT_Y, 0]}
        onPress={() => setEditFirst(!editFirst)}
      />
    </>
  );
}

// Troika measures text only after it renders, so a chip's width comes from its name's length.
const chipWidth = (name: string) => Math.min(0.22, Math.max(0.15, 0.048 + name.length * 0.0105));

function GroupChips({ groups, activeId, onOpen }: { groups: PhrasesGroup[]; activeId: string | undefined; onOpen: (id: string) => void }) {
  const total = groups.reduce((sum, g) => sum + chipWidth(g.name), 0) + CHIP_GAP * (groups.length - 1);
  let left = -total / 2;
  const chips = groups.map((g) => {
    const width = chipWidth(g.name);
    const chip = { group: g, width, x: left + width / 2 };
    left += width + CHIP_GAP;
    return chip;
  });
  return (
    <group position={[0, HEADER_Y, 0]}>
      {chips.map(({ group: g, width, x }) => (
        <Button3D
          key={g.id}
          label={g.name}
          width={width}
          height={CHIP_HEIGHT}
          fontSize={CHIP_FONT}
          selected={g.id === activeId}
          position={[x, 0, 0]}
          onPress={() => onOpen(g.id)}
        />
      ))}
    </group>
  );
}
