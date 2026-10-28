// UI strings for both apps, keyed by locale. Add a language by adding locales/<code>.json with the same keys,
// listing it in LANGUAGES, and adding it to the gateway's SupportedLocales.
import en from "../locales/en.json";
import es from "../locales/es.json";

export type StringKey = keyof typeof en;
export type Locale = "en" | "es";

/** The languages with UI strings, each named in itself, for language pickers. */
export const LANGUAGES: Record<Locale, string> = { en: "English", es: "Español" };

const tables: Record<Locale, Partial<Record<StringKey, string>>> = { en, es };
const STORAGE_KEY = "cadence.locale";

export function isLocale(value: string): value is Locale {
  return value in tables;
}

/** Remembered from the last session, so the first screen is in the right language before the gateway says so. */
let current: Locale = (() => {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY) ?? "";
    return isLocale(saved) ? saved : "en";
  } catch {
    return "en";
  }
})();

export function getLocale(): Locale {
  return current;
}

/** Switches the UI language (an unknown locale means English). Components re-render from the store's `locale`. */
export function setLocale(locale: string): void {
  current = isLocale(locale) ? locale : "en";
  if (typeof document !== "undefined") document.documentElement.lang = current;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, current);
  } catch {
    // Private mode or blocked storage: the gateway's language event still sets it on every connect.
  }
}

/** Looks up a UI string and fills `{name}` placeholders. Missing keys fall back to English. */
export function t(key: StringKey, vars: Record<string, string | number> = {}, locale: Locale = current): string {
  const template = tables[locale][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
