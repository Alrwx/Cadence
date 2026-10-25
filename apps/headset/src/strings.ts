// UI strings by locale, following the language the gateway announces (@cadence/shared/i18n). A new language is a
// new file in locales/ with the same keys.
import { getLocale, type Locale } from "@cadence/shared/i18n";
import en from "./locales/en.json";
import es from "./locales/es.json";

export type StringKey = keyof typeof en;

const tables: Record<Locale, Partial<Record<StringKey, string>>> = { en, es };

/** The UI string for `key` in the current language (English if it has none), with `{name}` placeholders filled. */
export function t(key: StringKey, params: Record<string, string | number> = {}): string {
  const template = tables[getLocale()][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
