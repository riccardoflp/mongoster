// Text that comes from a database, a server or a file, made safe to put in a notification.

/**
 * `text` with its Markdown links broken. VS Code draws `[label](https://…)` and `[label](command:…)` in a
 * notification as a link to click, so a collection name or a server's error message could put one there, with
 * a label that says something else. A zero-width space between `]` and `(` leaves the text looking as it was
 * and no longer a link.
 */
export function noLinks(text: string): string {
  return text.replace(/\]\(/g, ']​(');
}
