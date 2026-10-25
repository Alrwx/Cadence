import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addWord, backspace, finish, typeKey } from "./textEntry.ts";

test("typing letters and spaces never doubles or leads with a space", () => {
  let text = "";
  for (const key of [" ", "h", "i", " ", " ", "y", "o", "u"]) text = typeKey(text, key);
  assert.equal(text, "hi you");
  assert.equal(backspace(text), "hi yo");
});

test("words from the board are spaced, and finish tidies the result", () => {
  let text = typeKey("", "I");
  text = addWord(text, "need");
  text = addWord(text, "water");
  assert.equal(text, "I need water ");
  assert.equal(finish(" i  need water "), "I need water");
});
