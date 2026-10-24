/** `?debug` in the URL shows the in-headset debug panel and hand recorder. */
export const debugEnabled = new URLSearchParams(location.search).has("debug");
