// Relationship diagram: a tab that samples the collections of a database, checks the fields that look
// like references against the other collections, and draws the collections with their links.
import * as os from 'os';
import * as vscode from 'vscode';
import type { MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import { paintTab } from './connectionColors';
import type { DiagramHostMessage, DiagramViewMessage } from './shared/messages';
import { RelationsCache, analyzeRelations } from './relationsAnalysis';
import { Box, RelGraph, toSvg } from './shared/relations';
import { CollectionNode, errorMessage } from './tree';

export interface DiagramScope {
  connectionId: string;
  database: string;
  /** A collection to show first. */
  collection?: string;
}

const scopeKey = (s: DiagramScope) => [s.connectionId, s.database].join('\u0000');
export class DiagramPanel {
  private static readonly panels = new Map<string, DiagramPanel>();
  private readonly panel: vscode.WebviewPanel;
  private graph?: RelGraph;
  private lastRequest = 0;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, info: ConnectionInfo, scope: DiagramScope): void {
    const existing = DiagramPanel.panels.get(scopeKey(scope));
    if (existing) {
      existing.scope.collection = scope.collection;
      existing.panel.reveal();
      existing.postInit();
      return;
    }
    DiagramPanel.panels.set(scopeKey(scope), new DiagramPanel(context, connections, info, scope));
  }

  static connectionChanged(info: ConnectionInfo): void {
    for (const p of DiagramPanel.panels.values()) {
      if (p.scope.connectionId !== info.id) continue;
      p.info = info;
      paintTab(p.panel, p.context.extensionUri, info.color);
      p.postInit();
    }
  }

  static close(connectionId: string, database?: string): void {
    for (const p of [...DiagramPanel.panels.values()]) {
      if (p.scope.connectionId === connectionId && (database === undefined || p.scope.database === database)) p.panel.dispose();
    }
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private info: ConnectionInfo,
    private readonly scope: DiagramScope,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.diagram',
      `Diagram: ${scope.database}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    paintTab(this.panel, context.extensionUri, info.color);
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => DiagramPanel.panels.delete(scopeKey(scope)));
    this.panel.webview.onDidReceiveMessage((m: DiagramViewMessage) => void this.receive(m));
  }

  private post(m: DiagramHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private postInit(): void {
    this.post({ type: 'init', connectionName: this.info.name, color: this.info.color, database: this.scope.database, focus: this.scope.collection });
  }

  private client(): Promise<MongoClient> {
    return this.connections.getClient(this.info.id);
  }

  private async receive(m: DiagramViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postInit();
        break;
      case 'analyze':
        await this.analyze(m.requestId, m.sample);
        break;
      case 'openCollection': {
        const c = this.graph?.collections.find((x) => x.name === m.name);
        if (c) await vscode.commands.executeCommand('mongoster.openCollection', new CollectionNode(this.info, this.scope.database, c.name, !!c.view));
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
      case 'saveSvg':
        await this.saveSvg(m.boxes, m.keysOnly);
        break;
    }
  }

  private async analyze(requestId: number, sample: number): Promise<void> {
    this.lastRequest = requestId;
    const current = () => requestId === this.lastRequest;
    const progress = (text: string) => {
      if (current()) this.post({ type: 'progress', requestId, text });
    };
    try {
      const { database, collections, relations } = await analyzeRelations((await this.client()).db(this.scope.database), sample, progress, () => !current());
      if (!current()) return;
      this.graph = { database, collections, relations, sample };
      // The collection tabs of the database follow these references too.
      RelationsCache.store(this.info.id, database, this.graph);
      this.post({ type: 'graph', requestId, graph: this.graph });
    } catch (err) {
      if (current()) this.post({ type: 'graph', requestId, error: errorMessage(err) });
    }
  }

  private async saveSvg(boxes: Box[], keysOnly: boolean): Promise<void> {
    if (!this.graph) return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir()), `${this.scope.database}-diagram.svg`),
      filters: { 'SVG image': ['svg'] },
      title: 'Save the Diagram',
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(toSvg(this.graph, boxes, keysOnly)));
      const open = await vscode.window.showInformationMessage(`Saved the diagram of ${this.scope.database} to ${uri.fsPath}.`, 'Open');
      if (open === 'Open') await vscode.commands.executeCommand('vscode.open', uri);
    } catch (err) {
      void vscode.window.showErrorMessage(`Diagram not saved: ${errorMessage(err)}`);
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
  <link rel="stylesheet" href="${asset('media', 'monitor.css')}">
  <link rel="stylesheet" href="${asset('media', 'diagram.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Diagram</title>
</head>
<body>
  <header class="bar">
    <span id="title" class="title"></span>
    <span id="status" class="info"></span>
    <div class="spacer"></div>
    <label>Sample
      <select id="sample" aria-label="Documents sampled per collection" title="Documents read per collection to find the fields and the references">
        <option value="100">100</option>
        <option value="500">500</option>
        <option value="2000">2,000</option>
      </select>
    </label>
    <label title="Show only _id, unique fields and the fields of the relations"><input id="keysOnly" type="checkbox"> Keys only</label>
    <button id="refresh" class="secondary" title="Sample the collections again">Refresh</button>
  </header>
  <div class="toolbar diagram-tools">
    <button id="zoomOut" class="secondary icon" title="Zoom out" aria-label="Zoom out">−</button>
    <button id="zoomIn" class="secondary icon" title="Zoom in" aria-label="Zoom in">+</button>
    <button id="fit" class="secondary" title="Fit the diagram in the tab">Fit</button>
    <button id="relayout" class="secondary" title="Put the collections back where the automatic layout places them">Reset Layout</button>
    <div class="spacer"></div>
    <button id="mermaid" class="secondary" title="Copy the diagram as a Mermaid erDiagram (for Markdown, GitHub, docs)">Copy Mermaid</button>
    <button id="svg" class="secondary" title="Save the diagram as an SVG image">Save SVG…</button>
  </div>
  <div id="error" class="error hidden"></div>
  <main class="diagram-wrap">
    <svg id="diagram" class="diagram" role="img" aria-labelledby="title"></svg>
    <div id="empty" class="empty hidden"></div>
  </main>
  <details id="relationsBox" class="relations">
    <summary id="relationsTitle">Relations</summary>
    <ul id="relations"></ul>
  </details>
  <script nonce="${nonce}" src="${asset('dist', 'diagram.js')}"></script>
</body>
</html>`;
  }
}
