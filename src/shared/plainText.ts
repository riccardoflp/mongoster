// Text that comes from a database, a server, a library or a file, made safe to put in a notification, a log or
// an answer to an AI.

/**
 * `text` with its Markdown links broken. VS Code draws `[label](https://…)` and `[label](command:…)` in a
 * notification as a link to click, so a collection name or a server's error message could put one there, with
 * a label that says something else. A zero-width space between `]` and `(` leaves the text looking as it was
 * and no longer a link.
 */
export function noLinks(text: string): string {
  return text.replace(/\]\(/g, ']​(');
}

/**
 * `text` without the user and the password of the MongoDB and Redis URLs in it. An error can quote the
 * connection string it was given: the driver's does, for one it cannot read, which is also when the password
 * is where no parser would look for it (a `/` in it, no host after it). So everything up to the last `@`
 * of the URL goes, whatever it is.
 */
export function noCredentials(text: string): string {
  return text.replace(/\b((?:mongodb(?:\+srv)?|rediss?):\/\/)[^\s"'`<>]*@/gi, '$1…@');
}
