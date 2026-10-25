// The compose keyboard for "Type my own": a word board, or letters, toggled.
import { Text } from "@react-three/drei";
import { useState } from "react";
import { rememberSpeech, send } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { ACCENT, TEXT_HALO, ignoreRays } from "./glass.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { addWord, backspace, finish, typeKey } from "./textEntry.ts";
import { useView } from "./views.ts";

const FIELD_Y = 0.13;
const FIELD_TEXT_X = -0.32;
const ACTIONS_Y = -0.2;

const LETTER_ROWS = ["qwertyuiop", "asdfghjkl'", "zxcvbnm,.?"];
const LETTERS_TOP = 0.05;

const WORDS_PER_ROW = 6;
const WORDS_TOP = 0.05;

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
      <Field text={text} />
      {mode === "letters" ? <Letters onKey={(k) => setText((s) => typeKey(s, k))} /> : <Words onWord={(w) => setText((s) => addWord(s, w))} />}
      <group position={[0, ACTIONS_Y, 0]}>
        <Button3D label={t("entry.cancel")} icon="close" iconOnly width={0.07} position={[-0.345, 0, 0]} onPress={() => send("cancel", {})} />
        <Button3D label={t("entry.space")} icon="space" width={0.19} position={[-0.165, 0, 0]} onPress={() => setText((s) => typeKey(s, " "))} />
        <Button3D label={t("entry.delete")} icon="backspace" iconOnly width={0.07} disabled={!text} position={[0.005, 0, 0]} onPress={() => setText(backspace)} />
        <Button3D
          label={mode === "letters" ? t("entry.words") : t("entry.letters")}
          icon={mode === "letters" ? "textLines" : "keyboard"}
          width={0.17}
          position={[0.145, 0, 0]}
          onPress={() => setMode(mode === "letters" ? "words" : "letters")}
        />
        <Button3D label={t("entry.speak")} icon="volume" variant="primary" width={0.18} disabled={!value} position={[0.325, 0, 0]} onPress={submit} />
      </group>
    </>
  );
}

type TextInfo = { textRenderInfo?: { caretPositions: Float32Array } };

/** The message so far, with a caret after its last character, or the dimmed prompt when empty. */
function Field({ text }: { text: string }) {
  const [caretX, setCaretX] = useState(0);
  const [caretY, setCaretY] = useState(0);
  return (
    <GlassPanel width={0.694} height={0.07} radius={0.026} position={[0, FIELD_Y, 0]}>
      <group position={[FIELD_TEXT_X, 0, 0]}>
        <Text
          fontSize={0.026}
          maxWidth={0.64}
          anchorX="left"
          anchorY="middle"
          color="white"
          fillOpacity={text ? 1 : 0.55}
          {...TEXT_HALO}
          // Each character's caret box is [left, right, bottom, top]; the last right edge follows a typed space too.
          onSync={({ textRenderInfo: info }: TextInfo) => {
            const p = text ? info?.caretPositions : undefined;
            const end = p?.length ?? 0;
            setCaretX(p?.[end - 3] ?? 0);
            setCaretY(((p?.[end - 2] ?? 0) + (p?.[end - 1] ?? 0)) / 2);
          }}
        >
          {text || t("entry.compose")}
        </Text>
        <mesh position={[caretX + 0.003, caretY, 0.002]} raycast={ignoreRays}>
          <planeGeometry args={[0.003, 0.032]} />
          <meshBasicMaterial color={ACCENT} toneMapped={false} />
        </mesh>
      </group>
    </GlassPanel>
  );
}

function Letters({ onKey }: { onKey: (key: string) => void }) {
  return LETTER_ROWS.map((row, r) =>
    [...row].map((key, i) => (
      <Button3D
        key={key}
        label={key.toUpperCase()}
        width={0.062}
        height={0.06}
        radius={0.018}
        position={[-0.315 + i * 0.07, LETTERS_TOP - r * 0.068, 0]}
        onPress={() => onKey(key)}
      />
    )),
  );
}

function Words({ onWord }: { onWord: (word: string) => void }) {
  const words = t("entry.words.list").split("|");
  return words.map((word, i) => (
    <Button3D
      key={word}
      label={word}
      width={0.104}
      height={0.064}
      radius={0.022}
      fontSize={0.02}
      position={[-0.295 + (i % WORDS_PER_ROW) * 0.118, WORDS_TOP - Math.floor(i / WORDS_PER_ROW) * 0.078, 0]}
      onPress={() => onWord(word)}
    />
  ));
}
