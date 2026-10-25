// Which panel the headset shows; the gateway's COMPOSING state overrides it with the compose keyboard.
import { useEffect } from "react";
import { create } from "zustand";
import { useConsent } from "../consent.ts";
import { send } from "../session.ts";

export type View =
  | { kind: "main" }
  | { kind: "saved" }
  | { kind: "conversations"; tab?: "memories" }
  /** atStart: asked once the gateway first reports consent off, rather than from Remember this. */
  | { kind: "consent"; atStart?: boolean }
  | { kind: "settings" };

export interface Notice {
  text: string;
  tone: "info" | "error";
}

interface ViewState {
  view: View;
  /** Group shown in Saved phrases, and where Bookmark saves to. */
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

export const NOTICE_MS = 3000;

/** Shows a short message in the status line. */
export function notify(text: string, tone: Notice["tone"] = "info"): void {
  const notice = { text, tone };
  useView.setState({ notice });
  setTimeout(() => {
    if (useView.getState().notice === notice) useView.setState({ notice: null });
  }, NOTICE_MS);
}

let consentChecked = false;

/** Asks for store_chat consent once per page load, as soon as the gateway first reports it off. */
export function useConsentAtStart(): void {
  const reported = useConsent((s) => s.reported);
  useEffect(() => {
    if (!reported || consentChecked) return;
    consentChecked = true;
    if (!useConsent.getState().storeChat) showView({ kind: "consent", atStart: true });
  }, [reported]);
}
