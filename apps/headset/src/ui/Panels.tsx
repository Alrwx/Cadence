// The in-headset panels: suggested replies, instant phrases, saved phrases, and "Type my own".
import { Text } from "@react-three/drei";
import { useState } from "react";
import { layout } from "../config.ts";
import { connection, lastSpokenText, rememberSpoken, useCadence } from "../session.ts";
import { Button3D } from "./Button3D.tsx";

const ROW = layout.buttonHeight + 0.015;

export function Panels() {
  const state = useCadence((s) => s.state);
  return (
    <group position={layout.panelPosition} rotation={[layout.panelTilt, 0, 0]}>
      <StatusLine />
      {state === "COMPOSING" ? <ComposeBoard /> : <Replies />}
      <InstantRow />
      <SavedPhrases />
    </group>
  );
}

function StatusLine() {
  const partial = useCadence((s) => s.partial);
  const caption = useCadence((s) => s.captions.at(-1) ?? "");
  const state = useCadence((s) => s.state);
  const error = useCadence((s) => s.lastError);
  return (
    <Text position={[0, 0.2, 0]} fontSize={0.018} maxWidth={0.9} color={error ? "#ffb4a8" : "#ddd"} anchorY="bottom">
      {error ? error.message : partial || caption || (state === "IDLE" ? "Tap Start on the phone" : "Listening…")}
    </Text>
  );
}

function Replies() {
  const suggestions = useCadence((s) => s.suggestions);
  const turnId = useCadence((s) => s.turnId);
  return (
    <group position={[0, 0.12, 0]}>
      {suggestions.map((item, i) => (
        <Button3D
          key={item.id}
          label={item.text}
          position={[(i - 1) * (layout.buttonWidth + 0.02), 0, 0]}
          height={layout.buttonHeight * 1.4}
          onPress={() => {
            rememberSpoken(item.text);
            connection.send("select", { suggestionId: item.id }, turnId);
          }}
        />
      ))}
    </group>
  );
}

const INSTANT = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
  { id: "wait", label: "One sec" },
] as const;

function InstantRow() {
  return (
    <group position={[0, 0.12 - ROW * 1.4, 0]}>
      {INSTANT.map((p, i) => (
        <Button3D
          key={p.id}
          label={p.label}
          width={0.16}
          color="#2e7d4f"
          position={[(i - 1.5) * 0.18, 0, 0]}
          onPress={() => connection.send("instant", { phraseId: p.id })}
        />
      ))}
      <Button3D
        label="Type my own"
        width={0.2}
        color="#7a4fa0"
        position={[1.5 * 0.18 + 0.02, 0, 0]}
        onPress={() => connection.send("compose.start", {})}
      />
    </group>
  );
}

function SavedPhrases() {
  const groups = useCadence((s) => s.phraseGroups);
  const [groupIndex, setGroupIndex] = useState(0);
  const group = groups[groupIndex] ?? groups[0];
  const y0 = 0.12 - ROW * 2.6;
  return (
    <group position={[0, y0, 0]}>
      {groups.map((g, i) => (
        <Button3D
          key={g.id}
          label={g.name}
          width={0.14}
          height={0.05}
          color={g.id === group?.id ? "#b07a1f" : "#5a4a2a"}
          position={[(i - (groups.length - 1) / 2) * 0.15, 0, 0]}
          onPress={() => setGroupIndex(i)}
        />
      ))}
      {group?.items.map((p, i) => (
        <Button3D
          key={p.id}
          label={p.text}
          color="#8a6a2a"
          position={[((i % 3) - 1) * (layout.buttonWidth + 0.02), -ROW * (1 + Math.floor(i / 3)), 0]}
          onPress={() => connection.send("phrase.speak", { phraseId: p.id })}
        />
      ))}
      {group && (
        <Button3D
          label="☆ Save last reply"
          width={0.2}
          height={0.05}
          color="#5a4a2a"
          position={[0, -ROW * (2 + Math.floor((group.items.length - 1) / 3)), 0]}
          onPress={() => lastSpokenText && connection.send("phrase.save", { text: lastSpokenText, groupId: group.id })}
        />
      )}
    </group>
  );
}

// TODO(Dev 1): replace with a full keyboard; a word board is the faster first version.
const WORDS = ["I", "you", "need", "want", "please", "thank you", "water", "help", "pain", "tired", "yes", "no"];

function ComposeBoard() {
  const [words, setWords] = useState<string[]>([]);
  const text = words.join(" ");
  return (
    <group position={[0, 0.12, 0]}>
      <Text position={[0, 0.06, 0]} fontSize={0.022} maxWidth={0.9} color="white">
        {text || "Pick words…"}
      </Text>
      {WORDS.map((w, i) => (
        <Button3D
          key={w}
          label={w}
          width={0.14}
          color="#4b3a66"
          position={[((i % 6) - 2.5) * 0.15, -Math.floor(i / 6) * ROW, 0]}
          onPress={() => setWords((ws) => [...ws, w])}
        />
      ))}
      <group position={[0, -2 * ROW, 0]}>
        <Button3D label="⌫" width={0.12} color="#555" position={[-0.25, 0, 0]} onPress={() => setWords((ws) => ws.slice(0, -1))} />
        <Button3D label="Cancel" width={0.16} color="#555" position={[-0.08, 0, 0]} onPress={() => connection.send("cancel", {})} />
        <Button3D
          label="Speak"
          width={0.2}
          color="#7a4fa0"
          disabled={!text}
          position={[0.13, 0, 0]}
          onPress={() => {
            rememberSpoken(text);
            connection.send("compose.submit", { text });
            setWords([]);
          }}
        />
      </group>
    </group>
  );
}
