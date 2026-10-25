// Rules for managing saved phrases from the phone, shared so they can be tested without a browser.
// Limits match the gateway (services/gateway/internal/store/phrases.go), so a valid edit here is never rejected there.
import type { PhrasesGroup } from "@cadence/protocol";

export const MAX_PHRASE_LENGTH = 200;
export const MAX_GROUP_NAME_LENGTH = 40;

export type TextProblem = "empty" | "tooLong" | "duplicate";

/** Collapses runs of whitespace and trims, the same cleanup the gateway applies before saving. */
export function cleanPhraseText(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** Why a phrase can't be saved into a group, or null if it can. `ignoreId` is the phrase being edited. */
export function phraseProblem(text: string, group: PhrasesGroup | undefined, ignoreId?: string): TextProblem | null {
  const clean = cleanPhraseText(text);
  if (!clean) return "empty";
  if ([...clean].length > MAX_PHRASE_LENGTH) return "tooLong";
  if (group?.items.some((p) => p.id !== ignoreId && same(p.text, clean))) return "duplicate";
  return null;
}

/** Why a group name can't be used, or null if it can. `ignoreId` is the group being renamed. */
export function groupNameProblem(name: string, groups: PhrasesGroup[], ignoreId?: string): TextProblem | null {
  const clean = cleanPhraseText(name);
  if (!clean) return "empty";
  if ([...clean].length > MAX_GROUP_NAME_LENGTH) return "tooLong";
  if (groups.some((g) => g.id !== ignoreId && same(g.name, clean))) return "duplicate";
  return null;
}

/** The `order` to send in phrase.group.save to move a group up (-1) or down (+1), or null at either end. */
export function movedGroupOrder(groups: PhrasesGroup[], groupId: string, delta: -1 | 1): number | null {
  const index = groups.findIndex((g) => g.id === groupId);
  if (index < 0) return null;
  const next = index + delta;
  return next < 0 || next >= groups.length ? null : next;
}
