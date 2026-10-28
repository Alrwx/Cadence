import { Canvas, useFrame } from "@react-three/fiber";
import { XR } from "@react-three/xr";
import { useRef, useState } from "react";
import { debugEnabled } from "./dev/debug.ts";
import { DebugHud } from "./dev/DebugHud.tsx";
import { HandGestures } from "./gestures/HandGestures.tsx";
import { UIAnchor } from "./layout/UIAnchor.tsx";
import { HeadPointer } from "./selection/HeadPointer.tsx";
import { useCadence } from "./session.ts";
import { DebugPanel } from "./ui/DebugPanel.tsx";
import { ListenerReplies } from "./ui/ListenerReplies.tsx";
import { Panels } from "./ui/Panels.tsx";
import { xrStore } from "./xr.ts";

export function App() {
  const status = useCadence((s) => s.connection);
  // Every label comes from t(), which follows the gateway's language event; re-render the scene when it changes.
  useCadence((s) => s.locale);
  const [sceneReady, setSceneReady] = useState(false);

  return (
    <>
      {import.meta.env.DEV && <DebugHud />}
      <div style={{ position: "absolute", zIndex: 1, inset: "auto 0 24px 0", display: "flex", justifyContent: "center", gap: 16 }}>
        <button
          style={{ fontSize: 28, padding: "16px 48px", borderRadius: 16 }}
          disabled={!sceneReady}
          onClick={() => xrStore.enterAR().catch((err) => console.error("Couldn't enter AR:", err))}
        >
          Enter
        </button>
        <span style={{ alignSelf: "center" }}>gateway: {status}</span>
      </div>
      <Canvas>
        <XR store={xrStore}>
          <ambientLight intensity={1.2} />
          <directionalLight position={[1, 2, 1]} />
          <UIAnchor>
            <Panels />
            {debugEnabled && <DebugPanel />}
          </UIAnchor>
          <ListenerReplies />
          <HandGestures />
          <HeadPointer />
          <OnFirstFrame run={() => setSceneReady(true)} />
        </XR>
      </Canvas>
    </>
  );
}

/** enterAR() rejects until <XR> is connected, which is certain once the scene has rendered a frame. */
function OnFirstFrame({ run }: { run: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    run();
  });
  return null;
}
