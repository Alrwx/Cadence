import { devServer } from "@cadence/shared/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/headset/", // the gateway serves the built app at /headset/
  server: devServer(5173),
});
