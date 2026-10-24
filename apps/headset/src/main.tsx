import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connection } from "./session.ts";

if (import.meta.env.DEV) await (await import("./dev/setup.ts")).setupDev();
// Once for the app's lifetime, outside React, so StrictMode's double effects never open a second socket.
connection.connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
