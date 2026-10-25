import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PhrasesGroup } from "@cadence/protocol";
import { cleanPhraseText, groupNameProblem, MAX_PHRASE_LENGTH, movedGroupOrder, phraseProblem } from "./phrases.ts";

const groups: PhrasesGroup[] = [
  {
    id: "pg_hospital",
    name: "Hospital",
    items: [
      { id: "ph_water", text: "I need some water", audioReady: true },
      { id: "ph_pain", text: "I'm in pain", audioReady: false },
    ],
  },
  { id: "pg_demo", name: "Demo", items: [] },
  { id: "pg_home", name: "Home", items: [] },
];
const hospital = groups[0];

test("cleanPhraseText collapses whitespace like the gateway", () => {
  assert.equal(cleanPhraseText("  I  need\n some   water "), "I need some water");
  assert.equal(cleanPhraseText(" \t "), "");
});

test("phraseProblem catches empty, too long, and duplicate phrases", () => {
  assert.equal(phraseProblem("   ", hospital), "empty");
  assert.equal(phraseProblem("a".repeat(MAX_PHRASE_LENGTH), hospital), null);
  assert.equal(phraseProblem("a".repeat(MAX_PHRASE_LENGTH + 1), hospital), "tooLong");
  assert.equal(phraseProblem("i need  SOME water", hospital), "duplicate");
  assert.equal(phraseProblem("Please close the curtain", hospital), null);
  // Editing a phrase may keep its own text (e.g. only fixing spacing).
  assert.equal(phraseProblem("I need some  water", hospital, "ph_water"), null);
  // The same text in another group is fine.
  assert.equal(phraseProblem("I need some water", groups[1]), null);
});

test("groupNameProblem catches empty, too long, and duplicate names", () => {
  assert.equal(groupNameProblem("", groups), "empty");
  assert.equal(groupNameProblem("x".repeat(41), groups), "tooLong");
  assert.equal(groupNameProblem(" hospital ", groups), "duplicate");
  assert.equal(groupNameProblem("Hospital", groups, "pg_hospital"), null, "renaming to its own name");
  assert.equal(groupNameProblem("Doctor", groups), null);
});

test("movedGroupOrder stops at both ends", () => {
  assert.equal(movedGroupOrder(groups, "pg_demo", -1), 0);
  assert.equal(movedGroupOrder(groups, "pg_demo", 1), 2);
  assert.equal(movedGroupOrder(groups, "pg_hospital", -1), null);
  assert.equal(movedGroupOrder(groups, "pg_home", 1), null);
  assert.equal(movedGroupOrder(groups, "pg_missing", 1), null);
});
