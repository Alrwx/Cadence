// Mock gateway: replays a scripted scenario and answers headset actions, so frontend work never waits on the backend.
// Usage: SCENARIO=happy-path|slow-tts|disconnect pnpm --filter @cadence/mock-gateway dev
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { resolve } from "node:path";
import {
  isEventType,
  PROTOCOL_VERSION,
  type CadenceEvent,
  type EventDataMap,
  type EventType,
  type PhrasesGroup,
} from "@cadence/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { beepWav } from "./wav.ts";

type Role = "headset" | "phone";
type Target = Role | "all";

interface Step {
  afterMs: number;
  to: Target;
  type: EventType;
  data: unknown;
}

interface Scenario {
  description: string;
  ttsDelayMs: number;
  disconnectAfterMs?: number;
  steps: Step[];
}

const root = resolve(import.meta.dirname, "../../..");
const scenarioName = process.env.SCENARIO ?? "happy-path";
const scenario = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../scenarios", `${scenarioName}.json`), "utf8"),
) as Scenario;
const port = Number(process.env.PORT ?? 8444);

interface Session {
  id: string;
  clients: Partial<Record<Role, WebSocket>>;
  turnId: string;
  clipTexts: Map<string, string>;
  groups: PhrasesGroup[];
  timers: NodeJS.Timeout[];
  /** The disconnect scenario drops connections once; clients re-send phone.unlock on reconnect. */
  droppedOnce: boolean;
}

const sessions = new Map<string, Session>();
let clipCounter = 0;
let idCounter = 0;

function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      clients: {},
      turnId: "t_1",
      clipTexts: new Map(),
      groups: [
        {
          id: "pg_hospital",
          name: "Hospital",
          items: [
            { id: "ph_water", text: "I need some water", icon: "water", audioReady: true },
            { id: "ph_restroom", text: "I need to use the restroom", audioReady: true },
            { id: "ph_pain", text: "I'm in pain", audioReady: true },
            { id: "ph_family", text: "Can you call my family?", audioReady: true },
          ],
        },
        // Starter groups match AGENTS(GH).md; "Demo" opens the judge demo.
        {
          id: "pg_demo",
          name: "Demo",
          items: [{ id: "ph_judges", text: "Hi judges, I'll be demoing Cadence", audioReady: true }],
        },
        { id: "pg_home", name: "Home", items: [{ id: "ph_love", text: "I love you", audioReady: true }] },
      ],
      timers: [],
      droppedOnce: false,
    };
    sessions.set(id, s);
  }
  return s;
}

function send<T extends EventType>(s: Session, to: Target, type: T, data: EventDataMap[T] | unknown): void {
  const frame = JSON.stringify({ type, v: PROTOCOL_VERSION, sessionId: s.id, turnId: s.turnId, ts: Date.now(), data });
  const roles: Role[] = to === "all" ? ["headset", "phone"] : [to];
  for (const role of roles) s.clients[role]?.send(frame);
}

function runScenario(s: Session): void {
  s.timers.forEach(clearTimeout);
  s.timers = [];
  let at = 0;
  for (const step of scenario.steps) {
    at += step.afterMs;
    s.timers.push(setTimeout(() => send(s, step.to, step.type, step.data), at));
  }
  if (scenario.disconnectAfterMs !== undefined && !s.droppedOnce) {
    s.droppedOnce = true;
    s.timers.push(
      setTimeout(() => {
        console.log("scenario: dropping all connections");
        for (const ws of Object.values(s.clients)) ws?.terminate();
      }, scenario.disconnectAfterMs),
    );
  }
}

function speak(s: Session, text: string, source: EventDataMap["audio.play"]["source"]): void {
  send(s, "all", "state", { state: "SPEAKING" });
  const clipId = `mock_${++clipCounter}`;
  s.clipTexts.set(clipId, text);
  setTimeout(() => send(s, "phone", "audio.play", { clipId, url: `/clips/${clipId}.wav`, text, source }), scenario.ttsDelayMs);
}

const SUGGESTION_TEXT: Record<string, string> = {};
for (const step of scenario.steps) {
  if (step.type === "suggestions") {
    for (const item of (step.data as EventDataMap["suggestions"]).items) SUGGESTION_TEXT[item.id] = item.text;
  }
}
const INSTANT_TEXT: Record<string, string> = { yes: "Yes", no: "No", wait: "Give me a second", hello: "Hello", laugh: "Ha ha" };

function handle(s: Session, event: CadenceEvent): void {
  switch (event.type) {
    case "phone.unlock":
      runScenario(s);
      break;
    case "select":
      speak(s, SUGGESTION_TEXT[event.data.suggestionId] ?? "(unknown suggestion)", "suggestion");
      break;
    case "instant":
      speak(s, INSTANT_TEXT[event.data.phraseId] ?? event.data.phraseId, "instant");
      break;
    case "phrase.speak": {
      const phrase = s.groups.flatMap((g) => g.items).find((p) => p.id === event.data.phraseId);
      speak(s, phrase?.text ?? "(unknown phrase)", "saved");
      break;
    }
    case "phrase.save": {
      const group = s.groups.find((g) => g.id === event.data.groupId);
      if (!group) {
        send(s, "headset", "error", { code: "unknown_group", message: "That group no longer exists.", recoverable: true });
        break;
      }
      group.items.push({ id: `ph_${++idCounter}`, text: event.data.text, audioReady: true });
      send(s, "headset", "phrases", { groups: s.groups });
      break;
    }
    case "phrase.group.save": {
      const { groupId, name, order } = event.data;
      let group = s.groups.find((g) => g.id === groupId);
      if (group) group.name = name;
      else s.groups.push((group = { id: groupId ?? `pg_${++idCounter}`, name, items: [] }));
      if (order !== undefined) {
        s.groups = s.groups.filter((g) => g !== group);
        s.groups.splice(Math.max(0, Math.min(order, s.groups.length)), 0, group);
      }
      send(s, "headset", "phrases", { groups: s.groups });
      break;
    }
    case "phrase.group.delete":
      s.groups = s.groups.filter((g) => g.id !== event.data.groupId);
      send(s, "headset", "phrases", { groups: s.groups });
      break;
    case "phrase.delete":
      for (const g of s.groups) g.items = g.items.filter((p) => p.id !== event.data.phraseId);
      send(s, "headset", "phrases", { groups: s.groups });
      break;
    case "compose.start":
      send(s, "all", "state", { state: "COMPOSING" });
      break;
    case "compose.submit":
      speak(s, event.data.text, "typed");
      break;
    case "cancel":
    case "audio.done":
      send(s, "all", "state", { state: "LISTENING" });
      break;
    default:
      console.log("mock: not handled", event.type);
  }
}

function serveClip(req: IncomingMessage, res: ServerResponse): void {
  const match = /^\/clips\/([\w-]+)\.wav$/.exec(req.url ?? "");
  if (!match) {
    res.writeHead(404).end();
    return;
  }
  const text = [...sessions.values()].map((s) => s.clipTexts.get(match[1]!)).find(Boolean) ?? "";
  res.writeHead(200, { "Content-Type": "audio/wav" }).end(beepWav(text));
}

const cert = resolve(root, process.env.TLS_CERT ?? "certs/dev.pem");
const key = resolve(root, process.env.TLS_KEY ?? "certs/dev-key.pem");
const tls = existsSync(cert) && existsSync(key);
const server = tls
  ? createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, serveClip)
  : createHttp(serveClip);

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const role = url.searchParams.get("role") as Role | null;
  const sessionId = url.searchParams.get("session");
  if ((role !== "headset" && role !== "phone") || !sessionId) {
    ws.close(1008, "need role=headset|phone and session");
    return;
  }
  const s = getSession(sessionId);
  s.clients[role] = ws;
  console.log(`connected ${role} (session ${sessionId})`);
  send(s, role, "state", { state: "IDLE" });
  if (role === "headset") send(s, "headset", "phrases", { groups: s.groups });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // phone mic frames; the mock ignores audio
    try {
      const event = JSON.parse(raw.toString()) as CadenceEvent;
      if (!isEventType(event.type)) {
        console.warn("ignoring unknown event", event.type);
        return;
      }
      handle(s, event);
    } catch (err) {
      console.warn("ignoring malformed event", err);
    }
  });
  ws.on("close", () => {
    if (s.clients[role] === ws) delete s.clients[role];
  });
});

server.listen(port, () => {
  console.log(`mock gateway (${scenarioName}) on ${tls ? "https" : "http"}://localhost:${port} – ${scenario.description}`);
});
