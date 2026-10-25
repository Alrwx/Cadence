import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connection } from "./headset.ts";
import { TestBench } from "./TestBench.tsx";

// Once, outside React, so StrictMode's double effects never open a second socket.
connection.connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TestBench />
  </StrictMode>,
);
