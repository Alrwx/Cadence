// A Lucide icon drawn as a flat stroke mesh, so it stays crisp at any distance.
import { DoubleSide, type BufferGeometry } from "three";
import { SVGLoader, type StrokeStyle } from "three/examples/jsm/loaders/SVGLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ignoreRays } from "./glass.ts";
import { iconSvg, type IconName } from "./icons.ts";

interface Props {
  name: IconName;
  /** Edge of the icon's 24-unit box (meters). */
  size: number;
  color?: string;
  opacity?: number;
  position?: [number, number, number];
}

export function Icon3D({ name, size, color = "white", opacity = 1, position }: Props) {
  return (
    // Like a button's label, the icon must not catch the rays meant for the button under it.
    <mesh geometry={iconGeometry(name)} scale={size} position={position} raycast={ignoreRays}>
      <meshBasicMaterial color={color} opacity={opacity} transparent depthWrite={false} side={DoubleSide} toneMapped={false} />
    </mesh>
  );
}

const geometries = new Map<IconName, BufferGeometry>();

/** Built on first use and shared by every instance: SVGLoader needs the browser's DOMParser. */
function iconGeometry(name: IconName): BufferGeometry {
  let geometry = geometries.get(name);
  if (geometry) return geometry;
  const strokes = new SVGLoader()
    .parse(iconSvg(name))
    .paths.flatMap((path) => path.subPaths.map((sub) => SVGLoader.pointsToStroke(sub.getPoints(), path.userData.style as StrokeStyle)))
    // A subpath too short to stroke yields null.
    .filter((stroke): stroke is BufferGeometry => stroke !== null);
  geometry = mergeGeometries(strokes);
  for (const stroke of strokes) stroke.dispose();
  // SVG's y points down: flip it, and center the 24-unit box on the origin as a 1 m square.
  geometry.translate(-12, -12, 0).scale(1 / 24, -1 / 24, 1);
  geometries.set(name, geometry);
  return geometry;
}
