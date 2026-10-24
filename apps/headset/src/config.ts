// Every tunable for gestures and layout lives here (AGENTS(GH).md §7, Dev 1 agent notes).

export const gestures = {
  /** A finger counts as curled when its tip is closer than this to the wrist (meters). */
  curledTipToWrist: 0.09,
  /** A finger counts as extended when its tip is farther than this from the wrist (meters). */
  extendedTipToWrist: 0.13,
  /** Thumb tip must be this far above (thumbs-up) or below (thumbs-down) the wrist (meters). */
  thumbVertical: 0.04,
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
