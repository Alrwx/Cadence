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

export const layout = {
  /** Panels sit at chest/lap height to reduce arm fatigue; y is meters above the floor. */
  panelPosition: [0, 1.1, -0.55] as [number, number, number],
  /** Tilt panels back toward the user (radians). */
  panelTilt: -0.35,
  buttonWidth: 0.34,
  buttonHeight: 0.07,
  fontSize: 0.022,
  /** Ignore repeat presses on the same button within this window (ms). */
  pressDebounceMs: 600,
} as const;

/** Gesture → instant phraseId sent to the gateway. Palm-pinch is reserved by the Quest system; never map it. */
export const gesturePhrases = {
  thumbsUp: "yes",
  thumbsDown: "no",
  openPalm: "wait",
} as const;
