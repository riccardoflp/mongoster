// The tab beside a playground showing what a run returned: documents as a table or as text,
// the print() output, or the error with its line.
import * as vscode from 'vscode';
import type { PlaygroundHostMessage, PlaygroundViewMessage } from '../shared/messages';

export class PlaygroundResultPanel {
  private static current: PlaygroundResultPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private pending: PlaygroundHostMessage | undefined;
  /** Playground the shown result came from, for "Go to line". */
  private source: vscode.Uri | undefined;
  private lineOffset = 0;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.playgroundResult',
      'Playground Result',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => (PlaygroundResultPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((m: PlaygroundViewMessage) => void this.receive(m));
  }

  /** Shows `message` in the result tab (created beside the playground on first use). */
  static show(
    context: vscode.ExtensionContext,
    message: PlaygroundHostMessage,
    source?: { uri: vscode.Uri; lineOffset: number },
  ): PlaygroundResultPanel {
    const panel = (PlaygroundResultPanel.current ??= new PlaygroundResultPanel(context));
    panel.source = source?.uri;
    panel.lineOffset = source?.lineOffset ?? 0;
    if (message.type === 'result') panel.panel.title = `Result: ${message.title}`;
    if (!panel.panel.visible) panel.panel.reveal(vscode.ViewColumn.Beside, true);
    panel.post(message);
    return panel;
  }

  private post(message: PlaygroundHostMessage): void {
    if (this.ready) void this.panel.webview.postMessage(message);
    else this.pending = message;
  }

  private async receive(m: PlaygroundViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        if (this.pending) void this.panel.webview.postMessage(this.pending);
        this.pending = undefined;
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
      case 'openJson': {
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: m.text });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
        break;
      }
      case 'goToLine': {
        if (!this.source) return;
        const doc = await vscode.workspace.openTextDocument(this.source);
        const line = Math.min(Math.max(m.line - 1 + this.lineOffset, 0), doc.lineCount - 1);
        const range = doc.lineAt(line).range;
        await vscode.window.showTextDocument(doc, { selection: range, viewColumn: vscode.ViewColumn.One });
        break;
      }
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'playground.css')}">
  <title>Playground Result</title>
</head>
<body>
  <header class="bar">
    <div id="meta" class="meta">Run a playground with Ctrl+Enter.</div>
    <div class="spacer"></div>
    <div class="tabs" role="tablist">
      <button id="viewTable" role="tab" aria-selected="true">Table</button>
      <button id="viewText" role="tab" aria-selected="false">JSON</button>
    </div>
    <button id="copy" class="secondary" title="Copy the result as mongosh text">Copy</button>
    <button id="openJson" class="secondary" title="Open the result as JSON in an editor tab">Open in Editor</button>
  </header>
  <section id="error" class="error hidden"></section>
  <section id="output" class="output hidden"><div class="output-title">Output</div><pre id="outputText"></pre></section>
  <main id="result" class="result"></main>
  <script nonce="${nonce}" src="${asset('dist', 'playground.js')}"></script>
</body>
</html>`;
  }
}
