// Dev server on a desktop: installs Meta's IWER Quest 3 emulator. Desktop Chrome has a native navigator.xr
// that can't run immersive-ar, and @react-three/xr's own `emulate` option won't replace a native runtime.
import type { XRDevice } from "iwer";

export async function installEmulator(): Promise<XRDevice | null> {
  if (location.hostname !== "localhost" || (await navigator.xr?.isSessionSupported("immersive-ar"))) return null;
  const [{ XRDevice, metaQuest3 }, { DevUI }] = await Promise.all([import("iwer"), import("@iwer/devui")]);
  const device = new XRDevice(metaQuest3);
  device.primaryInputMode = "hand";
  device.installRuntime({ forceInstall: true });
  // The DevUI re-applies its own head and hand poses every frame, which would undo the end-to-end
  // tests' remote-control moves; automated browsers set navigator.webdriver.
  if (!navigator.webdriver) device.installDevUI(DevUI);
  return device;
}
