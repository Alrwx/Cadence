import { Canvas } from "@react-three/fiber";
import { XR } from "@react-three/xr";
import { useEffect } from "react";
import { debugEnabled } from "./dev/debug.ts";
import { DebugHud } from "./dev/DebugHud.tsx";
import { HandGestures } from "./gestures/HandGestures.tsx";
import { connection, useCadence } from "./session.ts";
import { DebugPanel } from "./ui/DebugPanel.tsx";
import { Panels } from "./ui/Panels.tsx";
import { xrStore } from "./xr.ts";

export function App() {
  const status = useCadence((s) => s.connection);

  useEffect(() => {
    connection.connect();
    return () => connection.close();
  }, []);

  return (
    <>
      {import.meta.env.DEV && <DebugHud />}
      <div style={{ position: "absolute", zIndex: 1, inset: "auto 0 24px 0", display: "flex", justifyContent: "center", gap: 16 }}>
        <button style={{ fontSize: 28, padding: "16px 48px", borderRadius: 16 }} onClick={() => xrStore.enterAR()}>
          Enter
        </button>
        <span style={{ alignSelf: "center" }}>gateway: {status}</span>
      </div>
      <Canvas>
        <XR store={xrStore}>
          <ambientLight intensity={1.2} />
          <directionalLight position={[1, 2, 1]} />
          <Panels />
          <HandGestures />
          {debugEnabled && <DebugPanel />}
        </XR>
      </Canvas>
    </>
  );
}
