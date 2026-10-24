// Dev-server-only endpoints the headset posts to: Quest console output, and hand recordings saved as
// test fixtures (see src/dev/remoteConsole.ts and src/dev/handRecorder.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures/hands");
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z]+$/;

export function headsetDevTools(): Plugin {
  return {
    name: "cadence-headset-dev-tools",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/log", (req, res) =>
        handle(req, res, ({ level, text }) => console.log(`[quest ${String(level)}] ${String(text)}`)),
      );
      server.middlewares.use("/__dev/hand-recording", (req, res) =>
        handle(req, res, (body) => {
          const { label, hand } = body;
          if (typeof label !== "string" || typeof hand !== "string" || !SAFE_NAME.test(label) || !SAFE_NAME.test(hand)) {
            throw new Error("label and hand must be plain words");
          }
          mkdirSync(FIXTURES_DIR, { recursive: true });
          const file = resolve(FIXTURES_DIR, `${label}-${hand}-${Date.now()}.json`);
          writeFileSync(file, JSON.stringify(body));
          console.log(`[quest] saved hand recording ${file}`);
        }),
      );
    },
  };
}

function handle(req: IncomingMessage, res: ServerResponse, onBody: (body: Record<string, unknown>) => void): void {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(204).end();
    } catch (err) {
      res.writeHead(400).end(String(err));
    }
  });
}
