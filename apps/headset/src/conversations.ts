// Saved conversations: the gateway's list, and which ones this session uses as context.
import type { ConversationsItem } from "@cadence/protocol";
import { create } from "zustand";

interface ConversationsState {
  /** Newest first. */
  items: ConversationsItem[];
  attached: string[];
}

export const useConversations = create<ConversationsState>(() => ({ items: [], attached: [] }));

export function receiveConversations(items: ConversationsItem[]): void {
  useConversations.setState((s) => ({
    items: [...items].sort((a, b) => b.startedAt - a.startedAt),
    attached: s.attached.filter((id) => items.some((c) => c.id === id)),
  }));
}

/** Flips one conversation and returns the full attached set, which is what `conversation.attach` carries. */
export function toggleAttached(id: string): string[] {
  const { attached } = useConversations.getState();
  const next = attached.includes(id) ? attached.filter((a) => a !== id) : [...attached, id];
  useConversations.setState({ attached: next });
  return next;
}
