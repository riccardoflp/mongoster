// The Choose a Color tab: a custom color for a connection or a collection (D17), with the system's color picker,
// a `#rrggbb` field, the presets and a preview. `pickCustomColor` waits for it like a quick pick.
import * as vscode from 'vscode';
import { paintTab } from './connectionColors';
import { type Color, readColor } from './shared/colors';
import type { ColorPickerHostMessage, ColorPickerViewMessage } from './shared/messages';

/** The tab open now: opening another one closes it, as a second quick pick closes the first. */
let open: vscode.WebviewPanel | undefined;

/**
 * Opens the tab titled `title` on `initial` (a preset or a custom color) and resolves with the color applied, or
 * undefined when the tab is cancelled or closed.
 */
export function pickCustomColor(context: vscode.ExtensionContext, title: string, initial: Color | undefined): Promise<Color | undefined> {
  open?.dispose();
  const roots = [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')];
  const panel = vscode.window.createWebviewPanel('mongoster.colorPicker', title, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: roots });
  open = panel;
  paintTab(panel, context.extensionUri, initial);
  panel.webview.html = html(panel.webview, context.extensionUri, title);
  return new Promise((resolve) => {
    let result: Color | undefined;
    const post = (m: ColorPickerHostMessage) => void panel.webview.postMessage(m);
    panel.webview.onDidReceiveMessage((m: ColorPickerViewMessage) => {
      if (m.type === 'ready') post({ type: 'init', title, color: initial ?? '#3794ff' });
      if (m.type === 'apply') {
        result = readColor(m.color);
        if (result) panel.dispose();
      }
      if (m.type === 'cancel') panel.dispose();
    });
    panel.onDidDispose(() => {
      if (open === panel) open = undefined;
      resolve(result);
    });
  });
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const text = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'monitor.css')}">
  <link rel="stylesheet" href="${asset('media', 'colorPicker.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>${text}</title>
</head>
<body>
  <header class="bar">
    <span class="title">${text}</span>
  </header>
  <main class="picker">
    <div class="row">
      <input type="color" id="native" title="Open the system's color picker">
      <input type="text" id="value" spellcheck="false" aria-label="Color as #rrggbb or a preset name">
      <span id="error" class="error hidden">Enter a color as #rrggbb</span>
    </div>
    <div class="swatches" id="swatches" role="group" aria-label="Preset colors"></div>
    <div class="preview">
      <div class="stripe"></div>
      <p>The stripe at the top of its tabs, and in the desktop app the line above them, take this color.</p>
      <p id="nearest" class="nearest"></p>
    </div>
    <div class="actions">
      <button id="apply">Apply</button>
      <button id="cancel" class="secondary">Cancel</button>
    </div>
  </main>
  <script nonce="${nonce}" src="${asset('dist', 'colorPicker.js')}"></script>
</body>
</html>`;
}
