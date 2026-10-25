import { devServer } from "@cadence/shared/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/phone/", // the gateway serves the built app at /phone/
  server: devServer(5174),
  build: {
    rollupOptions: {
      // The test bench ships too, so the gateway serves it at /phone/test.html (typing for the listener needs DEV_TOOLS=1).
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        test: resolve(import.meta.dirname, "test.html"),
      },
    },
  },
});
