export * from "./connection.ts";
export * from "./phrases.ts";
export * from "./store.ts";
export * from "./voiceApi.ts";

/** Session id from `?session=` in the page URL, so headset and phone can pair; defaults to "demo". */
export function sessionIdFromUrl(search: string = location.search): string {
  return new URLSearchParams(search).get("session") || "demo";
}
