// Which panel the headset shows; the gateway's COMPOSING state overrides it with the compose keyboard.
import { create } from "zustand";
import { send } from "../session.ts";

export type View = { kind: "main" } | { kind: "saved" } | { kind: "conversations" } | { kind: "settings" };

export interface Notice {
  text: string;
  tone: "info" | "error";
}

interface ViewState {
  view: View;
  /** Group shown in Saved phrases, and where "Bookmark last reply" saves to. */
  groupId: string | null;
  /** Text the compose keyboard opens with. */
  draft: string;
  notice: Notice | null;
}

export const useView = create<ViewState>(() => ({ view: { kind: "main" }, groupId: null, draft: "", notice: null }));

export const showView = (view: View) => useView.setState({ view });

/** Opens "Type my own", empty or with a saved phrase to edit before speaking. */
export function startCompose(draft = ""): void {
  useView.setState({ draft });
  send("compose.start", {});
}

const NOTICE_MS = 3000;

/** Shows a short message in the status line. */
export function notify(text: string, tone: Notice["tone"] = "info"): void {
  const notice = { text, tone };
  useView.setState({ notice });
  setTimeout(() => {
    if (useView.getState().notice === notice) useView.setState({ notice: null });
  }, NOTICE_MS);
}
