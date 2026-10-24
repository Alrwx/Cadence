// Desktop overlay (dev server only): session state, outgoing events, and buttons that stand in for the
// phone and for hand gestures, so the headset app can be driven without a phone or a Quest.
import { fireGesture } from "../gestures/HandGestures.tsx";
import type { Gesture } from "../gestures/classify.ts";
import { send, useCadence, useHeadset } from "../session.ts";

const GESTURES: [Gesture, string][] = [
  ["thumbsUp", "👍 Yes"],
  ["thumbsDown", "👎 No"],
  ["openPalm", "✋ Wait"],
];

export function DebugHud() {
  const connection = useCadence((s) => s.connection);
  const state = useCadence((s) => s.state);
  const turnId = useCadence((s) => s.turnId);
  const sent = useHeadset((s) => s.sent);

  return (
    <div
      style={{
        position: "absolute", zIndex: 2, top: 8, left: 8, width: 300, padding: 10, borderRadius: 8,
        background: "rgba(0,0,0,0.75)", font: "12px ui-monospace, monospace", color: "#ddd",
      }}
    >
      <div>gateway: {connection} · state: {state} · turn: {turnId ?? "–"}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "8px 0" }}>
        {/* The mock gateway starts its scenario on phone.unlock, whichever client sends it. */}
        <button onClick={() => send("phone.unlock", {})}>Phone: Start</button>
        {GESTURES.map(([g, label]) => (
          <button key={g} onClick={() => fireGesture(g)}>
            {label}
          </button>
        ))}
      </div>
      <div>sent:</div>
      <ol reversed style={{ margin: 0, paddingLeft: 24 }}>
        {sent
          .slice(-8)
          .reverse()
          .map((e) => (
            <li key={e.at + e.type} style={{ color: e.delivered ? undefined : "#f88" }}>
              {e.type} {JSON.stringify(e.data)}
            </li>
          ))}
      </ol>
    </div>
  );
}
