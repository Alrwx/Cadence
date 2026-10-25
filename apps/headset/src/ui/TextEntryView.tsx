// The compose keyboard for "Type my own": a word board, or letters, toggled.
import { Text } from "@react-three/drei";
import { useState } from "react";
import { layout } from "../config.ts";
import { rememberSpeech, send } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { addWord, backspace, finish, typeKey } from "./textEntry.ts";
import { useView } from "./views.ts";

const KEY = 0.075;
const KEY_STEP = 0.082;
const WORD_WIDTH = 0.14;
const DISPLAY_Y = 0.13;
const KEYS_TOP = 0.05;
const ACTIONS_Y = -0.2;
const KEY_COLOR = "#4b3a66";
const ACTION = "#555";
const SUBMIT = "#7a4fa0";

export function TextEntryView() {
  const [text, setText] = useState(() => useView.getState().draft);
  // The word board is faster when typing by head dwell.
  const [mode, setMode] = useState<"letters" | "words">("words");
  const value = finish(text);

  const submit = () => {
    if (!value) return;
    rememberSpeech(value, true);
    send("compose.submit", { text: value });
  };

  return (
    <>
      <group position={[0, DISPLAY_Y, 0]}>
        <mesh position={[0, 0, -0.002]}>
          <planeGeometry args={[0.86, 0.075]} />
          <meshBasicMaterial color="#1b1f27" />
        </mesh>
        <Text fontSize={0.026} maxWidth={0.82} color={text ? "white" : "#8a94a6"} anchorX="center" anchorY="middle">
          {text || t("entry.compose")}
        </Text>
      </group>
      {mode === "letters" ? <Letters onKey={(k) => setText((s) => typeKey(s, k))} /> : <Words onWord={(w) => setText((s) => addWord(s, w))} />}
      <group position={[0, ACTIONS_Y, 0]}>
        <Button3D label={t("entry.space")} width={0.22} color={ACTION} position={[-0.33, 0, 0]} onPress={() => setText((s) => typeKey(s, " "))} />
        <Button3D label={t("entry.delete")} width={0.14} color={ACTION} disabled={!text} position={[-0.13, 0, 0]} onPress={() => setText(backspace)} />
        <Button3D
          label={mode === "letters" ? t("entry.words") : t("entry.letters")}
          width={0.16}
          color={ACTION}
          position={[0.04, 0, 0]}
          onPress={() => setMode(mode === "letters" ? "words" : "letters")}
        />
        <Button3D label={t("entry.cancel")} width={0.14} color={ACTION} position={[0.21, 0, 0]} onPress={() => send("cancel", {})} />
        <Button3D
          label={t("entry.speak")}
          width={0.18}
          color={SUBMIT}
          disabled={!value}
          position={[0.39, 0, 0]}
          onPress={submit}
        />
      </group>
    </>
  );
}

function Letters({ onKey }: { onKey: (key: string) => void }) {
  // Per language: Spanish swaps the apostrophe for ñ and adds the ´ dead key (´ then a vowel types á é í ó ú).
  const rows = t("entry.letters.rows").split("|");
  return (
    <group position={[0, KEYS_TOP, 0]}>
      {rows.map((row, r) =>
        [...row].map((key, i) => (
          <Button3D
            key={key}
            label={key.toUpperCase()}
            width={KEY}
            color={KEY_COLOR}
            position={[(i - (row.length - 1) / 2) * KEY_STEP, -r * (layout.buttonHeight + 0.01), 0]}
            onPress={() => onKey(key)}
          />
        )),
      )}
    </group>
  );
}

const WORDS_PER_ROW = 6;

function Words({ onWord }: { onWord: (word: string) => void }) {
  const words = t("entry.words.list").split("|");
  return (
    <group position={[0, KEYS_TOP, 0]}>
      {words.map((word, i) => (
        <Button3D
          key={word}
          label={word}
          width={WORD_WIDTH}
          color={KEY_COLOR}
          position={[((i % WORDS_PER_ROW) - (WORDS_PER_ROW - 1) / 2) * (WORD_WIDTH + 0.01), -Math.floor(i / WORDS_PER_ROW) * (layout.buttonHeight + 0.015), 0]}
          onPress={() => onWord(word)}
        />
      ))}
    </group>
  );
}
