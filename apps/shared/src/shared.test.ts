import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GatewayConnection, gatewayUrl, nextBackoff, parse } from "./connection.ts";
import { t } from "./i18n.ts";
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

test("a state event for a new turn clears the previous turn's suggestions", () => {
  const store = createCadenceStore();
  const { applyEvent } = store.getState();
  const state = (turnId: string, value: "CHOOSING" | "SPEAKING" | "LISTENING") =>
    applyEvent({ type: "state", v: 1, sessionId: "s", turnId, ts: 1, data: { state: value } });
  state("t_1", "CHOOSING");
  applyEvent({
    type: "suggestions", v: 1, sessionId: "s", turnId: "t_1", ts: 2,
    data: { items: [{ id: "a", text: "old", kind: "statement", audioReady: true }] },
  });
  state("t_1", "SPEAKING");
  assert.equal(store.getState().suggestions.length, 1, "same turn keeps suggestions");
  state("t_2", "LISTENING");
  assert.equal(store.getState().suggestions.length, 0);
  assert.equal(store.getState().turnId, "t_2");
});

test("t() fills placeholders and leaves unknown ones alone", () => {
  assert.equal(t("phone.start"), "Start");
  assert.equal(t("phone.micError", { error: "denied" }), "Microphone unavailable: denied");
  assert.equal(t("phone.micError"), "Microphone unavailable: {error}");
});

/** Minimal stand-in for the browser WebSocket, enough to drive GatewayConnection. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

test("hello goes out before onStatus/onOpen, and onOpen runs again after a reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = realWs;
  });

  const log: string[] = [];
  const conn = new GatewayConnection({
    role: "phone",
    sessionId: "s",
    url: "wss://test/ws",
    onEvent: () => {},
    onStatus: (status) => log.push(`status:${status}`),
    onOpen: () => {
      log.push("onOpen");
      conn.send("phone.unlock", {});
    },
  });
  conn.connect();
  const first = FakeSocket.instances.at(-1)!;
  first.open();
  assert.deepEqual(
    first.sent.map((f) => (JSON.parse(f) as { type: string }).type),
    ["hello", "phone.unlock"],
  );

  first.readyState = 3;
  first.onclose?.(); // server went away
  t.mock.timers.tick(500); // first backoff step
  const second = FakeSocket.instances.at(-1)!;
  assert.notEqual(second, first);
  second.open();
  assert.deepEqual(
    second.sent.map((f) => (JSON.parse(f) as { type: string }).type),
    ["hello", "phone.unlock"],
  );
  assert.deepEqual(log, [
    "status:connecting",
    "status:open",
    "onOpen",
    "status:closed",
    "status:connecting",
    "status:open",
    "onOpen",
  ]);
  conn.close();
});
