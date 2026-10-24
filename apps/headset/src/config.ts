// Every tunable for gestures and layout lives here (AGENTS(GH).md §7, Dev 1 agent notes).

// Reach = fingertip-to-wrist distance in palm lengths (wrist to middle knuckle).
// classify.test.ts checks these against IWER's captured hand poses.
export const gestures = {
  /** A finger is curled below this reach. */
  curledReach: 0.85,
  /** A finger is extended above this reach. */
  extendedReach: 1.5,
  /** The thumb sticks out (thumbs-up/down) above this reach. */
  thumbOutReach: 1.25,
  /** Open palm needs thumb and index tips at least this far apart (palm lengths), so a pinch never counts. */
  minPinchGap: 0.5,
  /** Cosine of the max angle between "up" and the thumb (thumbs-up/down) or the fingers (open palm). */
  pointingCos: 0.7,
  /** Cosine of the max angle between the palm and the direction away from the head (open palm). */
  palmAwayCos: 0.5,
  /** A pose must be held this long before it fires (ms). */
  holdMs: 400,
  /** After a gesture fires, ignore gestures for this long (ms). */
  cooldownMs: 1500,
} as const;

/** Hands-free selection: hold the head reticle on a target. */
export const selection = {
  /** Default dwell time; users can change it in Settings (ms). */
  dwellMs: 800,
  dwellChoicesMs: [600, 800, 1200, 1600],
  /** A near miss within this angle still counts as pointing at the target (degrees). */
  snapDeg: 3,
  /** Turning the head faster than this restarts the dwell (degrees per second). */
  maxHeadSpeedDegPerSec: 60,
  /** The reticle floats this far in front of the eyes (meters). */
  reticleDistance: 0.8,
} as const;

export const layout = {
  /** Panels sit below the line of sight, at chest height, to reduce arm fatigue (meters from the head). */
  panelOffset: [0, -0.35, -0.6] as [number, number, number],
  buttonWidth: 0.34,
  buttonHeight: 0.07,
  fontSize: 0.022,
  /** Ignore repeat presses on the same button within this window (ms). */
  pressDebounceMs: 600,
  /** A press that deletes something needs a second press within this window (ms). */
  confirmMs: 4000,
  /** The ?debug panel floats to the user's left, turned toward them (meters from the head; radians). */
  debugPanelOffset: [-0.6, -0.1, -0.45] as [number, number, number],
  debugPanelYaw: 0.6,
  /** After pressing Recenter, the user has this long to look where the panels should go (ms). */
  recenterCountdownMs: 2500,
  /** Head poses settle for this long after entering AR or a system recenter before the UI follows (ms). */
  recenterSettleMs: 300,
  /** Reply bubbles stack this far from the user (meters) and this far to the right of the listener's face (degrees). */
  listenerDistance: 1,
  listenerSideDeg: 12,
} as const;

/** Gesture → instant phrase sent to the gateway. Palm-pinch is reserved by the Quest system; never map it. */
export const gesturePhrases = {
  thumbsUp: { phraseId: "yes", label: "instant.yes" },
  thumbsDown: { phraseId: "no", label: "instant.no" },
  openPalm: { phraseId: "wait", label: "instant.wait" },
} as const;
