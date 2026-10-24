// UI strings by locale. English only for now; a new language is a new file in locales/.
import en from "./locales/en.json";

export type StringKey = keyof typeof en;

/** The UI string for `key`, with `{name}` placeholders filled from `params`. */
export function t(key: StringKey, params: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
