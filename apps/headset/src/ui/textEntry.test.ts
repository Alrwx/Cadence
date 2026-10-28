import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ACCENT, addWord, backspace, finish, typeKey } from "./textEntry.ts";

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

test("the accent key accents the next vowel, and is dropped if nothing follows it", () => {
  let text = "";
  for (const key of ["d", "o", "n", "d", ACCENT, ACCENT, "e"]) text = typeKey(text, key);
  assert.equal(text, "dondé");
  assert.equal(typeKey(`ma${ACCENT}`, "s"), `ma${ACCENT}s`, "only vowels take the accent");
  assert.equal(finish(`hola${ACCENT} `), "Hola");
});

test("finish capitalizes after an opening ¿ or ¡", () => {
  assert.equal(finish("¿dónde está el baño?"), "¿Dónde está el baño?");
  assert.equal(finish("¡ñandú!"), "¡Ñandú!");
});
