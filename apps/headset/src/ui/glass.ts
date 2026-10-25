// The glass look for buttons and panels. WebXR can't sample the passthrough camera, so nothing is really refracted:
// a tinted, partly see-through body lets the room show through, and light on a curved rim, a sheen that slides
// as the head moves, and a liquid level for dwell progress make it read as glass.
import { Color, ShaderMaterial, Vector2, type IUniform } from "three";

/** Body opacity: the user chose 0.4 so the room stays visible; the dark tint and text halo keep labels readable. */
export const GLASS_OPACITY = 0.4;
/** "Solid panels" in Settings, for users who find see-through buttons hard to read. */
export const SOLID_OPACITY = 0.96;

/** Neutral body tint for every button and surface. */
export const GLASS_TINT = "#0c1211";
/** The one accent: selected and on states, the primary action, dwell progress, status icons. */
export const ACCENT = "#2dd4bf";
/** Tint and rim of a second-press confirm ("Really delete?"). */
export const DANGER = "#e11d48";
export const DANGER_RIM = "#fb7185";

// The lift and squish move only what's drawn: the mesh itself stays put, since it is also the pinch and dwell target.
const vertexShader = /* glsl */ `
uniform vec2 uScale;
uniform float uLift;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vNormal;

void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position.xy * uScale, position.z + uLift, 1.0);
  vWorldPos = world.xyz;
  vRight = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0));
  vUp = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  vNormal = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uLiquid;
uniform vec3 uRing;
uniform float uRingMix;
uniform vec2 uSize;
uniform float uRadius;
uniform float uOpacity;
uniform float uSheen;
uniform float uHover;
uniform float uFill;
uniform float uTime;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vNormal;

const float BEVEL = 0.012;
const float RING = 0.002;
const vec3 LIGHT = normalize(vec3(-0.35, 1.0, 0.55));

// Signed distance to a rounded rectangle (negative inside), and the outward direction to its nearest edge.
float roundRect(vec2 p, vec2 halfSize, float r, out vec2 outward) {
  vec2 q = abs(p) - halfSize + r;
  float outside = length(max(q, 0.0));
  vec2 s = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
  if (outside > 0.0) outward = s * max(q, 0.0) / outside;
  else outward = q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
  return outside + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = (vUv - 0.5) * uSize;
  vec2 outward;
  float d = roundRect(p, uSize * 0.5, uRadius, outward);
  float aa = fwidth(d);
  float mask = 1.0 - smoothstep(-aa, aa, d);
  if (mask <= 0.0) discard;

  // The surface curves away near the edge, so the rim catches the light and brightens at grazing angles.
  float bevel = 1.0 - clamp(-d / BEVEL, 0.0, 1.0);
  bevel *= bevel;
  vec3 local = normalize(vec3(outward * bevel * 1.6, 1.0));
  vec3 n = normalize(vRight * local.x + vUp * local.y + vNormal * local.z);
  vec3 v = normalize(cameraPosition - vWorldPos);
  float fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  float spec = pow(max(dot(n, normalize(LIGHT + v)), 0.0), 80.0);
  float rim = (1.0 - smoothstep(0.0, 0.0025, -d)) * (0.6 + 0.4 * outward.y);

  // A soft diagonal band that slides across as the head moves, like light on a curved pane.
  float along = (p.x + p.y * 0.8) / uSize.x + dot(v, vRight) * 1.5 - 0.25;
  float sheen = exp(-along * along / 0.02) * uSheen;

  // Dwell progress: liquid rises from the bottom, with a small wave on its surface while it fills.
  float level = (uFill - 0.5) * uSize.y + sin(p.x * 90.0 + uTime * 6.0) * 0.002 * uFill * (1.0 - uFill) * 4.0;
  float edgeY = fwidth(p.y);
  float liquid = uFill > 0.001 ? smoothstep(level + edgeY, level - edgeY, p.y) : 0.0;
  float meniscus = uFill > 0.001 && uFill < 0.999 ? 1.0 - smoothstep(0.0, 0.0018, abs(p.y - level)) : 0.0;

  vec3 color = mix(uTint * 0.5, uTint * 0.95 + 0.04, vUv.y);
  color = mix(color, uTint * 1.3 + 0.08, uHover * 0.4);
  color = mix(color, uLiquid, liquid * 0.6);
  color += meniscus * 0.5 + sheen * 0.1 + fresnel * 0.3 + spec * 0.6 + rim * (0.2 + fresnel * 0.5);

  // Selected, primary and danger buttons get a solid colored ring just inside the edge.
  float ring = (1.0 - smoothstep(RING - aa, RING + aa, -d)) * uRingMix;
  color = mix(color, uRing, ring);

  float alpha = uOpacity + uHover * 0.12 + liquid * 0.2 + rim * 0.3 + spec * 0.4 + meniscus * 0.3 + ring;
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0) * mask);
  #include <colorspace_fragment>
}
`;

export type GlassMaterial = ShaderMaterial & {
  uniforms: Record<"uTint" | "uLiquid" | "uRing", IUniform<Color>> &
    Record<"uSize" | "uScale", IUniform<Vector2>> &
    Record<"uRadius" | "uOpacity" | "uSheen" | "uHover" | "uFill" | "uTime" | "uLift" | "uRingMix", IUniform<number>>;
};

/** One material per surface (its uniforms animate independently); three compiles the shader once for all of them. */
export function createGlassMaterial(width: number, height: number, radius: number): GlassMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTint: { value: new Color(GLASS_TINT) },
      uLiquid: { value: new Color(ACCENT) },
      uRing: { value: new Color(ACCENT) },
      uRingMix: { value: 0 },
      uSize: { value: new Vector2(width, height) },
      uRadius: { value: radius },
      uOpacity: { value: GLASS_OPACITY },
      uSheen: { value: 1 },
      uHover: { value: 0 },
      uFill: { value: 0 },
      uTime: { value: 0 },
      uScale: { value: new Vector2(1, 1) },
      uLift: { value: 0 },
    },
    transparent: true,
    // The room shows through, and labels drawn just in front must not be hidden by the glass.
    depthWrite: false,
    toneMapped: false,
  }) as GlassMaterial;
}

/** A raycast that never hits, for meshes drawn on or behind a button that must not take its pinches. */
export const ignoreRays = () => {};
