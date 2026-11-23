// The URLs the app serves its own files from, to the webviews and to the shell. A module of its own, without the
// color theme, so that the quick pick (ui.ts) can draw icons without importing webview.ts: that import closed the
// cycle appearance → documents → ui → webview → appearance, and the app failed to start.
import * as path from 'path';
import { Uri } from './base';
import { runtime } from './runtime';

/** The protocol the app serves its own files and the webviews' documents from. */
export const APP_PROTOCOL = 'mongoster-app';
export const RESOURCE_HOST = 'res';

/** The URL of a file of the app, as the webviews and the shell load it; files elsewhere aren't served. */
export function appResourceUri(resource: Uri): Uri {
  const relative = path.relative(runtime().appRoot, resource.fsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Not a file of the app: ${resource.fsPath}`);
  return Uri.from({ scheme: APP_PROTOCOL, authority: RESOURCE_HOST, path: `/${relative.split(path.sep).join('/')}` });
}

export function isResourceHost(host: string): boolean {
  return host === RESOURCE_HOST;
}
