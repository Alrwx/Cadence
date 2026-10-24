// End-to-end tests: headless Chromium runs the headset app against the mock gateway, inside the IWER
// Quest 3 emulator that the dev server installs on localhost (src/dev/emulator.ts).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// The dev servers use HTTPS when `make certs` has run, plain HTTP otherwise.
const root = resolve(import.meta.dirname, "../..");
const scheme = existsSync(resolve(root, process.env.TLS_CERT ?? "certs/dev.pem")) ? "https" : "http";
const MOCK_GATEWAY = `${scheme}://localhost:8444`;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL: `${scheme}://localhost:5173`,
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: [
    {
      command: "pnpm --filter @cadence/mock-gateway dev",
      // The mock gateway answers 404 at /, but serves any /clips/<id>.wav.
      url: `${MOCK_GATEWAY}/clips/ready.wav`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
      cwd: root,
    },
    {
      command: "pnpm dev",
      url: `${scheme}://localhost:5173/headset/`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
      env: { GATEWAY_TARGET: MOCK_GATEWAY },
    },
  ],
});
