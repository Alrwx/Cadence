import { devServer } from "@cadence/shared/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/phone/", // the gateway serves the built app at /phone/
  server: devServer(5174),
});
