import { Canvas } from "@react-three/fiber";
import { createXRStore, XR } from "@react-three/xr";
import { useEffect } from "react";
import { HandGestures } from "./gestures/HandGestures.tsx";
import { connection, useCadence } from "./session.ts";
import { Panels } from "./ui/Panels.tsx";

// Passthrough AR on the Quest 3S; hands are the primary input, controllers also work.
const xrStore = createXRStore({ hand: true, controller: true });

export function App() {
  const status = useCadence((s) => s.connection);

  useEffect(() => {
    connection.connect();
    return () => connection.close();
  }, []);

  return (
    <>
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
        </XR>
      </Canvas>
    </>
  );
}
