// Text editing for the in-headset keyboard and word board.

/** The keyboard's dead key: typed before a vowel, it accents it (´ then a → á). */
export const ACCENT = "´";
const ACCENTED: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú" };

/** Appends a typed letter, or a single space (never two in a row, never leading). A vowel after ACCENT replaces it. */
export function typeKey(text: string, key: string): string {
  if (key === " ") return text === "" || text.endsWith(" ") ? text : `${text} `;
  if (text.endsWith(ACCENT)) {
    if (key === ACCENT) return text;
    if (key in ACCENTED) return text.slice(0, -1) + ACCENTED[key];
  }
  return text + key;
}

export function backspace(text: string): string {
  return text.slice(0, -1);
}

/** Adds a whole word from the word board, separated from what came before by one space. */
export function addWord(text: string, word: string): string {
  return `${text === "" || text.endsWith(" ") ? text : `${text} `}${word} `;
}

/** What gets spoken or saved: no stray spaces or unused accent keys, and the first letter capitalized (the keys are
 * lowercase), also after an opening ¿ or ¡. */
export function finish(text: string): string {
  const tidy = text.replaceAll(ACCENT, "").trim().replace(/\s+/g, " ");
  return tidy.replace(/^([¿¡]*)(.)/u, (_, opening: string, first: string) => opening + first.toUpperCase());
}
