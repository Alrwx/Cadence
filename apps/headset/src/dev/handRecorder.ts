// Records a few seconds of hand frames on the Quest and uploads them to the dev server, which saves them
// under fixtures/hands/ for fixtures.test.ts to replay through the classifier.
import { create } from "zustand";
import type { HandFrame, Quat, Vec3 } from "../gestures/classify.ts";

export const RECORDING_LABELS = ["thumbsUp", "thumbsDown", "openPalm", "relaxed", "pinch"] as const;
export type RecordingLabel = (typeof RECORDING_LABELS)[number];

export interface Recording {
  label: RecordingLabel;
  hand: XRHandedness;
  frames: HandFrame[];
}

const COUNTDOWN_MS = 2000;
const DURATION_MS = 3000;
const ENDPOINT = "/__dev/hand-recording";

interface RecorderState {
  label: RecordingLabel | null;
  recording: boolean;
  status: string;
}

export const useRecorder = create<RecorderState>(() => ({ label: null, recording: false, status: "" }));

const frames = new Map<XRHandedness, HandFrame[]>();

export function startRecording(label: RecordingLabel): void {
  if (useRecorder.getState().label) return;
  frames.clear();
  useRecorder.setState({ label, recording: false, status: `Get ready: ${label}` });
  setTimeout(() => useRecorder.setState({ recording: true, status: `Recording ${label}…` }), COUNTDOWN_MS);
  setTimeout(() => void finish(label), COUNTDOWN_MS + DURATION_MS);
}

/** Called every frame by HandGestures for each tracked hand. */
export function recordFrame(hand: XRHandedness, frame: HandFrame): void {
  if (!useRecorder.getState().recording) return;
  const list = frames.get(hand) ?? [];
  list.push(copyFrame(frame));
  frames.set(hand, list);
}

async function finish(label: RecordingLabel): Promise<void> {
  useRecorder.setState({ recording: false });
  const saved: string[] = [];
  try {
    for (const [hand, list] of frames) {
      const body: Recording = { label, hand, frames: list };
      const res = await fetch(ENDPOINT, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saved.push(`${hand} ${list.length}`);
    }
    useRecorder.setState({ label: null, status: saved.length ? `Saved ${label}: ${saved.join(", ")} frames` : "No hands tracked" });
  } catch (err) {
    useRecorder.setState({ label: null, status: `Upload failed: ${String(err)}` });
  }
}

// WebXR hands out live DOMPointReadOnly objects; copy them so the recording keeps this frame's values.
const v = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
const q = (p: Quat): Quat => ({ x: p.x, y: p.y, z: p.z, w: p.w });

function copyFrame({ joints, wristOrientation, head }: HandFrame): HandFrame {
  const copied = Object.fromEntries(Object.entries(joints).map(([k, p]) => [k, v(p)])) as unknown as HandFrame["joints"];
  return { joints: copied, wristOrientation: q(wristOrientation), head: v(head) };
}
