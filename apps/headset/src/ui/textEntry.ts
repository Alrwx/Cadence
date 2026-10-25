// Text editing for the in-headset keyboard and word board.

/** Appends a typed letter, or a single space (never two in a row, never leading). */
export function typeKey(text: string, key: string): string {
  if (key === " ") return text === "" || text.endsWith(" ") ? text : `${text} `;
  return text + key;
}

export function backspace(text: string): string {
  return text.slice(0, -1);
}

/** Adds a whole word from the word board, separated from what came before by one space. */
export function addWord(text: string, word: string): string {
  return `${text === "" || text.endsWith(" ") ? text : `${text} `}${word} `;
}

/** What gets spoken or saved: no stray spaces, first letter capitalized (the keys are lowercase). */
export function finish(text: string): string {
  const tidy = text.trim().replace(/\s+/g, " ");
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
}
