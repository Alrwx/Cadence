import { strict as assert } from "node:assert";
import { test } from "node:test";
import en from "../locales/en.json";
import es from "../locales/es.json";
import { getLocale, setLocale, t } from "./i18n.ts";
import { createCadenceStore } from "./store.ts";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("es.json has every English key, with the same placeholders", () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  for (const [key, text] of Object.entries(en)) {
    assert.deepEqual(placeholders(es[key as keyof typeof es]), placeholders(text), key);
  }
});

test("setLocale switches t(), and an unknown locale means English", () => {
  setLocale("es");
  assert.equal(getLocale(), "es");
  assert.equal(t("phone.start"), "Empezar");
  assert.equal(t("voice.stepOf", { n: 2 }), "Paso 2 de 3");
  assert.equal(t("phone.start", {}, "en"), "Start", "an explicit locale wins");
  setLocale("fr");
  assert.equal(getLocale(), "en");
  assert.equal(t("phone.start"), "Start");
});

test("the language event sets the UI language and the supported list", () => {
  const store = createCadenceStore();
  store.getState().applyEvent({
    type: "language",
    v: 1,
    sessionId: "s",
    ts: 1,
    data: { locale: "es", supported: ["en", "es"] },
  });
  assert.equal(store.getState().locale, "es");
  assert.deepEqual(store.getState().supportedLocales, ["en", "es"]);
  assert.equal(t("status.open"), "Conectado");
  setLocale("en");
});
