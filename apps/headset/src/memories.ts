// Quick memories: the gateway's list, and the one just saved so it can be announced and undone.
import type { MemoriesItem } from "@cadence/protocol";
import { create } from "zustand";

interface MemoriesState {
  /** Newest first. */
  items: MemoriesItem[];
  /** "Remember this" was pressed and its memory hasn't arrived yet. */
  awaiting: boolean;
  justSaved: MemoriesItem | null;
}

export const useMemories = create<MemoriesState>(() => ({ items: [], awaiting: false, justSaved: null }));

export const expectMemory = () => useMemories.setState({ awaiting: true });

export function receiveMemories(items: MemoriesItem[]): void {
  useMemories.setState((s) => {
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
    const added = s.awaiting ? sorted.find((m) => !s.items.some((old) => old.id === m.id)) : undefined;
    const kept = items.some((m) => m.id === s.justSaved?.id) ? s.justSaved : null;
    return { items: sorted, awaiting: s.awaiting && !added, justSaved: added ?? kept };
  });
}
