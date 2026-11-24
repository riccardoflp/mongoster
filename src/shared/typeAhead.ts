// Type-ahead in a list or a tree: typing letters moves to the next row whose name starts with them, as in a file
// manager. The desktop app's tree uses it; VS Code's trees have their own.
// No vscode dependency, no DOM: the shell keeps the letters typed and the time.

/** The pause after which a letter starts a new name instead of adding to the one typed. */
export const TYPE_AHEAD_RESET_MS = 1000;

/** The letters typed so far: `key` added to `typed`, or alone after a pause. */
export function typedText(typed: string, key: string, sinceLastKeyMs: number): string {
  return sinceLastKeyMs > TYPE_AHEAD_RESET_MS ? key : typed + key;
}

/**
 * The index of the row to move to, or -1 when no name starts with what was typed. The same letter typed again (`a`,
 * `aa`, `aaa`) goes to the next name starting with it, round to the first; other letters (`or`, `ord`) look for the
 * name from the current row on, so that the row stays while it still matches. Case is ignored.
 */
export function typeAheadTarget(labels: string[], current: number, typed: string): number {
  if (!typed || !labels.length) return -1;
  const text = typed.toLowerCase();
  const repeated = [...text].every((c) => c === text[0]);
  const prefix = repeated ? text[0] : text;
  const start = repeated || current < 0 ? current + 1 : current;
  for (let i = 0; i < labels.length; i++) {
    const index = (((start + i) % labels.length) + labels.length) % labels.length;
    if (labels[index].toLowerCase().startsWith(prefix)) return index;
  }
  return -1;
}
