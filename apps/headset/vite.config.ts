import { devServer } from "@cadence/shared/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { headsetDevTools } from "./devServerPlugin.ts";

export default defineConfig({
  plugins: [react(), headsetDevTools()],
  base: "/headset/", // the gateway serves the built app at /headset/
  // @iwer/devui (desktop emulator) bundles its own three.js 0.165; two copies in one scene break rendering.
  resolve: { dedupe: ["three"] },
  server: devServer(Number(process.env.HEADSET_PORT ?? 5173)),
});
