import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gatewayUrl, nextBackoff, parse } from "./connection.ts";
import { createCadenceStore } from "./store.ts";

test("gatewayUrl follows the page's scheme and host", () => {
  assert.equal(
    gatewayUrl("phone", "s 1", { protocol: "https:", host: "10.0.0.5:5174" }),
    "wss://10.0.0.5:5174/ws?role=phone&session=s%201",
  );
});

test("backoff doubles and caps", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(nextBackoff), [500, 1000, 2000, 4000, 8000, 8000, 8000]);
});

test("parse drops unknown and malformed events", () => {
  assert.equal(parse('{"type":"nope","data":{}}'), null);
  assert.equal(parse("not json"), null);
  assert.equal(parse('{"type":"cancel","v":1,"sessionId":"s","ts":1,"data":{}}')?.type, "cancel");
});

test("store applies events and drops stale suggestions", () => {
  const store = createCadenceStore();
  const { applyEvent } = store.getState();
  applyEvent({ type: "state", v: 1, sessionId: "s", turnId: "t_2", ts: 1, data: { state: "CHOOSING" } });
  applyEvent({
    type: "suggestions", v: 1, sessionId: "s", turnId: "t_1", ts: 2,
    data: { items: [{ id: "a", text: "old", kind: "statement", audioReady: false }] },
  });
  assert.equal(store.getState().suggestions.length, 0);
  applyEvent({
    type: "suggestions", v: 1, sessionId: "s", turnId: "t_2", ts: 3,
    data: { items: [{ id: "b", text: "new", kind: "statement", audioReady: false }] },
  });
  applyEvent({ type: "suggestion.audioReady", v: 1, sessionId: "s", turnId: "t_2", ts: 4, data: { id: "b" } });
  assert.deepEqual(store.getState().suggestions.map((s) => [s.text, s.audioReady]), [["new", true]]);
  applyEvent({ type: "transcript.final", v: 1, sessionId: "s", ts: 5, data: { text: "Hi", speaker: "other" } });
  assert.deepEqual(store.getState().captions, ["Hi"]);
});
