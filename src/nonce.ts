// The nonce of a tab's Content-Security-Policy: only the script tag that carries it runs in the webview.
// No vscode dependency.
import { randomBytes } from 'crypto';

/**
 * A new nonce for one rendering of a webview's HTML. It comes from the system's random generator:
 * a nonce that could be guessed would let injected markup name it and run as the tab's own script.
 */
export function newNonce(): string {
  return randomBytes(24).toString('base64url');
}
