// A glass surface behind a group of controls or text: a card, a menu, a tray. It is not a target.
import { useEffect, useMemo, type ReactNode } from "react";
import { useSettings } from "../settings.ts";
import { createGlassMaterial, GLASS_OPACITY, ignoreRays, SOLID_OPACITY } from "./glass.ts";

interface Props {
  width: number;
  height: number;
  /** Corner radius (meters); a pill by default. */
  radius?: number;
  position?: [number, number, number];
  /** Drawn on the surface, positioned from its center. */
  children?: ReactNode;
}

export function GlassPanel({ width, height, radius = height / 2, position, children }: Props) {
  const solid = useSettings((s) => s.solidPanels);
  const corner = Math.min(radius, width / 2, height / 2);
  const material = useMemo(() => Object.assign(createGlassMaterial(width, height, corner), { depthWrite: true }), [width, height, corner]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    material.uniforms.uOpacity.value = solid ? SOLID_OPACITY : GLASS_OPACITY;
    material.uniforms.uSheen.value = solid ? 0 : 1;
  }, [material, solid]);

  return (
    <group position={position}>
      {/* Drawn before what sits on it, and writing depth so that what sits behind it (the main view under the More
          menu) can't paint over it afterwards. Whatever is on the panel must sit in front of it in z. */}
      <mesh material={material} raycast={ignoreRays} renderOrder={-1}>
        <planeGeometry args={[width, height]} />
      </mesh>
      {children}
    </group>
  );
}
