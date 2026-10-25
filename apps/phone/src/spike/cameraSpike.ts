// Phase 0 camera spike: can a page in Quest Browser read a passthrough camera, keep reading it inside an
// immersive-ar session, and upload a cropped frame? See docs/proposals/2026-10-25-pointing-at-objects.md.

// The few WebXR types this page uses (the phone app doesn't include @types/webxr).
interface XRSessionLike {
  updateRenderState(state: { baseLayer: XRLayerLike }): void;
  requestAnimationFrame(callback: () => void): number;
  end(): Promise<void>;
  addEventListener(type: "end", listener: () => void): void;
}
interface XRLayerLike {
  framebuffer: WebGLFramebuffer | null;
}
declare const XRWebGLLayer: new (session: XRSessionLike, gl: WebGL2RenderingContext) => XRLayerLike;
const xr = (navigator as Navigator & { xr?: { requestSession(mode: string): Promise<XRSessionLike> } }).xr;

const AR_SECONDS = 8;
const CAPTURE_AT_SECONDS = 3;
const CROP_SHARE = 0.4; // center of the frame, where the reticle points
const CROP_PX = 512; // long side of the uploaded JPEG

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const select = $<HTMLSelectElement>("cameras");
const report: Record<string, unknown> = { userAgent: navigator.userAgent };
let crop: Blob | null = null;

function log(key: string, value: unknown): void {
  report[key] = value;
  $("out").textContent = JSON.stringify(report, null, 2);
}

/** Runs one step; a failure is recorded in the report instead of thrown, since that's a spike result too. */
function step(name: string, fn: () => Promise<void>): () => void {
  return () =>
    void fn().catch((err: unknown) =>
      log(`${name}Error`, err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
    );
}

async function cropFrame(source: string): Promise<void> {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (!vw) throw new Error("No video frame yet");
  const [w, h] = [vw * CROP_SHARE, vh * CROP_SHARE];
  const scale = CROP_PX / Math.max(w, h);
  const canvas = Object.assign(document.createElement("canvas"), {
    width: Math.round(w * scale),
    height: Math.round(h * scale),
  });
  canvas.getContext("2d")!.drawImage(video, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, canvas.width, canvas.height);
  crop = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))), "image/jpeg", 0.8),
  );
  const img = $<HTMLImageElement>("crop");
  URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(crop);
  log("crop", { source, width: canvas.width, height: canvas.height, bytes: crop.size });
}

// 1. Ask once so the camera labels are filled in, then list every camera.
$("list").onclick = step("list", async () => {
  (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop());
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  select.replaceChildren(...cameras.map((c, i) => new Option(c.label || `camera ${i}`, c.deviceId)));
  log(
    "cameras",
    cameras.map((c) => c.label),
  );
});

// 2. Open the chosen camera, asking for the passthrough cameras' full size.
$("open").onclick = step("open", async () => {
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: select.value }, width: 1280, height: 960 },
  });
  video.srcObject = stream;
  await video.play();
  const { width, height, frameRate } = stream.getVideoTracks()[0]!.getSettings();
  log("opened", { label: select.selectedOptions[0]?.text, width, height, frameRate });
});

// 3. Enter AR, count new camera frames for a few seconds, and crop one frame while inside the session.
$("ar").onclick = step("ar", async () => {
  if (!xr) throw new Error("navigator.xr is missing");
  if (!video.srcObject) throw new Error("Open a camera first (step 2)");
  const session = await xr.requestSession("immersive-ar");
  const gl = document.createElement("canvas").getContext("webgl2", { xrCompatible: true }) as WebGL2RenderingContext;
  const layer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: layer });

  crop = null;
  const started = performance.now();
  let frames = 0;
  let lastTime = video.currentTime;
  let capturing = false;
  const onFrame = () => {
    const seconds = (performance.now() - started) / 1000;
    if (video.currentTime !== lastTime) {
      frames++;
      lastTime = video.currentTime;
    }
    if (!capturing && seconds >= CAPTURE_AT_SECONDS) {
      capturing = true;
      void cropFrame("inside AR").catch((err: unknown) => log("arCropError", String(err)));
    }
    // Clear to transparent so passthrough shows; the session needs a rendered layer to stay alive.
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (seconds >= AR_SECONDS) void session.end();
    else session.requestAnimationFrame(onFrame);
  };
  session.requestAnimationFrame(onFrame);
  await new Promise<void>((resolve) => session.addEventListener("end", resolve));

  const seconds = (performance.now() - started) / 1000;
  log("inAR", { seconds: +seconds.toFixed(1), newCameraFrames: frames, fps: +(frames / seconds).toFixed(1) });
});

// 4. Upload the crop (or take one now) to the gateway, which logs the report and keeps nothing.
$("upload").onclick = step("upload", async () => {
  if (!crop) await cropFrame("page, outside AR");
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(crop!);
  });
  const res = await fetch("/api/spike/frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report, image: dataUrl.split(",")[1] }),
  });
  log("upload", { status: res.status, ...((await res.json()) as object) });
});
