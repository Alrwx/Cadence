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
  unlocked: boolean;
}

const sessions = new Map<string, Session>();
let clipCounter = 0;
// tsx watch restarts on every edit, and clients still hold ids from the previous run.
const idBase = Date.now().toString(36);
let idCounter = 0;

function newId(prefix: string): string {
  return `${prefix}_${idBase}_${++idCounter}`;
}

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
      unlocked: false,
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

function sendPhrases(s: Session, to: Target): void {
  send(s, to, "phrases", { groups: s.groups });
}

function runScenario(s: Session): void {
  let at = 0;
  for (const step of scenario.steps) {
    at += step.afterMs;
    setTimeout(() => send(s, step.to, step.type, step.data), at);
  }
  if (scenario.disconnectAfterMs !== undefined) {
    setTimeout(() => {
      console.log("scenario: dropping all connections");
      for (const ws of Object.values(s.clients)) ws?.terminate();
    }, scenario.disconnectAfterMs);
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

function handle(s: Session, from: Role, event: CadenceEvent): void {
  switch (event.type) {
    case "phone.unlock":
      // Clients re-send this on every reconnect; like the real gateway (Start only from IDLE), only the first one counts.
      if (s.unlocked) break;
      s.unlocked = true;
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
        send(s, from, "error", { code: "unknown_group", message: "That group no longer exists.", recoverable: true });
        break;
      }
      group.items.push({ id: newId("ph"), text: event.data.text, audioReady: true });
      sendPhrases(s, "all");
      break;
    }
    case "phrase.group.save": {
      const { groupId, name, order } = event.data;
      if (order !== undefined && !Number.isInteger(order)) {
        send(s, from, "error", { code: "invalid_order", message: "Group order must be a whole number.", recoverable: true });
        break;
      }
      let group = s.groups.find((g) => g.id === groupId);
      if (groupId === undefined) s.groups.push((group = { id: newId("pg"), name, items: [] }));
      else if (group) group.name = name;
      else {
        send(s, from, "error", { code: "unknown_group", message: "That group no longer exists.", recoverable: true });
        break;
      }
      if (order !== undefined) {
        s.groups.splice(s.groups.indexOf(group), 1);
        s.groups.splice(Math.max(0, Math.min(order, s.groups.length)), 0, group);
      }
      sendPhrases(s, "all");
      break;
    }
    case "phrase.group.delete":
      s.groups = s.groups.filter((g) => g.id !== event.data.groupId);
      sendPhrases(s, "all");
      break;
    case "phrase.delete":
      for (const g of s.groups) g.items = g.items.filter((p) => p.id !== event.data.phraseId);
      sendPhrases(s, "all");
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

// Consent + voice upload, the shape proposed in docs/proposals/2026-10-24-voice-upload-endpoints.md.
const MAX_SAMPLE_BYTES = 25 * 1024 * 1024;
const VOICE_DELAY_MS = Number(process.env.VOICE_DELAY_MS ?? 1500);
const consents = new Set<string>();
let voiceCounter = 0;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Pulls a plain text field out of a multipart body. Good enough for a mock; the real gateway uses a parser. */
function formField(body: Buffer, name: string): string | undefined {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body.toString("latin1"));
  return match?.[1];
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "POST" && req.url === "/api/consent") {
    const body = await readBody(req, 64 * 1024);
    const data = JSON.parse(body?.toString() || "{}") as Record<string, unknown>;
    const missing = ["sessionId", "kind", "voiceOwner", "statement"].filter(
      (k) => typeof data[k] !== "string" || !(data[k] as string).trim(),
    );
    if (missing.length) return json(res, 400, { code: "bad_request", message: `Missing ${missing.join(", ")}.` });
    const consentId = `c_${consents.size + 1}`;
    consents.add(consentId);
    console.log(`consent ${consentId}: ${String(data.voiceOwner)} (${String(data.statement)})`);
    return json(res, 201, { consentId });
  }
  if (req.method === "POST" && req.url === "/api/voices") {
    if (!req.headers["content-type"]?.startsWith("multipart/form-data")) {
      return json(res, 400, { code: "bad_request", message: "Expected multipart/form-data." });
    }
    const body = await readBody(req, MAX_SAMPLE_BYTES);
    if (!body) return json(res, 413, { code: "too_large", message: "The sample is over 25 MB." });
    const consentId = formField(body, "consentId");
    if (!formField(body, "sessionId") || !body.includes('name="audio"')) {
      return json(res, 400, { code: "bad_request", message: "Missing audio or sessionId." });
    }
    if (!consentId || !consents.has(consentId)) {
      return json(res, 403, { code: "no_consent", message: "No consent record for this voice." });
    }
    await new Promise((r) => setTimeout(r, VOICE_DELAY_MS)); // stands in for transcription + voice prompt
    const voiceId = `v_${++voiceCounter}`;
    console.log(`voice ${voiceId} from ${body.length} bytes (consent ${consentId})`);
    return json(res, 201, { voiceId });
  }
  json(res, 404, { code: "not_found", message: "Unknown API route." });
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  if (req.url?.startsWith("/api/")) {
    handleApi(req, res).catch((err: unknown) => json(res, 400, { code: "bad_request", message: String(err) }));
    return;
  }
  serveClip(req, res);
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
  ? createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, handleHttp)
  : createHttp(handleHttp);

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
  sendPhrases(s, role);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // phone mic frames; the mock ignores audio
    try {
      const event = JSON.parse(raw.toString()) as CadenceEvent;
      if (!isEventType(event.type)) {
        console.warn("ignoring unknown event", event.type);
        return;
      }
      handle(s, role, event);
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
