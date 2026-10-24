// Hands-free selection: which target the head points at, and when holding on it counts as a selection.
// Pure math so it can be unit-tested off-device; HeadPointer.tsx feeds it the head ray every frame.
export type Vec3 = { x: number; y: number; z: number };

/** A flat rectangular target in world space; right, up, and normal are unit vectors. */
export interface Rect {
  center: Vec3;
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  halfWidth: number;
  halfHeight: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Angle (radians) by which a ray misses the rectangle: 0 when it hits, Infinity when the rectangle is behind it. */
export function angularMiss(origin: Vec3, dir: Vec3, rect: Rect): number {
  const facing = dot(dir, rect.normal);
  if (Math.abs(facing) < 1e-6) return Infinity;
  const distance = dot(sub(rect.center, origin), rect.normal) / facing;
  if (distance <= 0) return Infinity;
  const hit = { x: origin.x + dir.x * distance, y: origin.y + dir.y * distance, z: origin.z + dir.z * distance };
  const local = sub(hit, rect.center);
  const outX = Math.max(0, Math.abs(dot(local, rect.right)) - rect.halfWidth);
  const outY = Math.max(0, Math.abs(dot(local, rect.up)) - rect.halfHeight);
  return Math.atan2(Math.hypot(outX, outY), distance);
}

/** The target the ray hits, or failing that the nearest one within `snapRad` (an aiming assist). */
export function pickTarget(origin: Vec3, dir: Vec3, targets: Iterable<[string, Rect]>, snapRad: number): string | null {
  let best: string | null = null;
  let bestMiss = Infinity;
  for (const [id, rect] of targets) {
    const miss = angularMiss(origin, dir, rect);
    if (miss <= snapRad && miss < bestMiss) {
      best = id;
      bestMiss = miss;
    }
  }
  return best;
}

export interface DwellOptions {
  dwellMs: number;
  /** Faster head turns (radians per second) restart the dwell, so glancing across targets selects nothing. */
  maxHeadSpeed: number;
}

export interface DwellUpdate {
  hover: string | null;
  /** 0 to 1 while holding on the hovered target; 0 again once it has fired. */
  progress: number;
  fired: string | null;
}

/** Fires once per visit: after a selection the head has to leave the target before it can fire again. */
export class DwellTracker {
  private hover: string | null = null;
  private since = 0;
  private fired = false;
  private lastDir: Vec3 | null = null;
  private lastTime = 0;

  update(hover: string | null, dir: Vec3, now: number, opts: DwellOptions): DwellUpdate {
    const seconds = Math.max((now - this.lastTime) / 1000, 1e-3);
    const speed = this.lastDir ? Math.acos(Math.min(1, dot(this.lastDir, dir))) / seconds : 0;
    this.lastDir = dir;
    this.lastTime = now;

    if (hover !== this.hover) {
      this.hover = hover;
      this.since = now;
      this.fired = false;
    }
    if (speed > opts.maxHeadSpeed) this.since = now;
    if (!hover || this.fired) return { hover, progress: 0, fired: null };

    const progress = (now - this.since) / opts.dwellMs;
    if (progress < 1) return { hover, progress, fired: null };
    this.fired = true;
    return { hover, progress: 0, fired: hover };
  }
}
