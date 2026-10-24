// Shared Vite dev-server settings for the headset and phone apps.
// Both dev servers proxy /ws and /clips to the gateway, so the apps only ever use same-origin URLs.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerOptions } from "vite";

const root = resolve(import.meta.dirname, "../..");

export function devServer(port: number): ServerOptions {
  const cert = resolve(root, process.env.TLS_CERT ?? "certs/dev.pem");
  const key = resolve(root, process.env.TLS_KEY ?? "certs/dev-key.pem");
  // Real gateway by default; `GATEWAY_TARGET=https://localhost:8444` for the mock gateway.
  const target = process.env.GATEWAY_TARGET ?? "https://localhost:8443";
  return {
    host: true,
    port,
    strictPort: true,
    // Quest Browser needs HTTPS for WebXR, phones need it for the mic. Run mkcert first (see README).
    https: existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined,
    proxy: {
      "/ws": { target, ws: true, secure: false },
      "/clips": { target, secure: false },
    },
  };
}
