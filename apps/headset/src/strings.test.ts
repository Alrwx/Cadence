import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setLocale } from "@cadence/shared/i18n";
import en from "./locales/en.json";
import es from "./locales/es.json";
import { t } from "./strings.ts";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("es.json has every English key, with the same placeholders", () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  for (const [key, text] of Object.entries(en)) {
    assert.deepEqual(placeholders(es[key as keyof typeof es]), placeholders(text), key);
  }
});

test("keyboard rows fit the panel: at most 10 distinct keys a row, three rows", () => {
  for (const table of [en, es]) {
    const rows = table["entry.letters.rows"].split("|");
    assert.equal(rows.length, 3);
    for (const row of rows) assert.ok([...row].length <= 10, row);
    const keys = rows.flatMap((row) => [...row]);
    assert.equal(new Set(keys).size, keys.length, "keys are unique (they're React keys)");
  }
});

test("t() follows the shared locale", () => {
  setLocale("es");
  assert.equal(t("instant.yes"), "Sí");
  assert.equal(t("status.speaking", { text: "Hola" }), "Diciendo: «Hola»");
  setLocale("en");
  assert.equal(t("instant.yes"), "Yes");
});
