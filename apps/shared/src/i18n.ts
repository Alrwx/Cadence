// UI strings for both apps, keyed by locale. Add a language by adding locales/<code>.json with the same keys.
import en from "../locales/en.json";

export type StringKey = keyof typeof en;
export type Locale = "en";

const tables: Record<Locale, Partial<Record<StringKey, string>>> = { en };

/** Looks up a UI string and fills `{name}` placeholders. Missing keys fall back to English. */
export function t(key: StringKey, vars: Record<string, string | number> = {}, locale: Locale = "en"): string {
  const template = tables[locale][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
