// Keeps the phone screen on while the app runs: a sleeping phone stops the mic mid-conversation.
// The browser drops the lock whenever the page is hidden, so it's re-requested when the page is visible again.

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || sentinel || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
  } catch (err) {
    // Unsupported, low battery, or not allowed; the app still works, the screen may just dim.
    console.warn("wake lock unavailable", err);
  }
}

/** Call from a user tap. Safe to call more than once. */
export function keepScreenOn(): void {
  if (!wanted) document.addEventListener("visibilitychange", () => void acquire());
  wanted = true;
  void acquire();
}
