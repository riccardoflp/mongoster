// Relationship diagram: a tab that samples the collections of a database, checks the fields that look
// like references against the other collections, and draws the collections with their links.
import * as os from 'os';
import * as vscode from 'vscode';
import { BSON, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { DiagramHostMessage, DiagramViewMessage } from './shared/messages';
import { Box, Candidate, RefType, RelCollection, RelGraph, Relation, candidates, isReference, refKey, sampleFields, toSvg } from './shared/relations';
import { CollectionNode, errorMessage } from './tree';

const { EJSON } = BSON;

/** Collections sampled at the same time. */
const PARALLEL = 6;
/** Values looked up in one query. */
const LOOKUP_CHUNK = 1000;
const MAX_TIME_MS = 20_000;

export interface DiagramScope {
  connectionId: string;
  database: string;
  /** A collection to show first. */
  collection?: string;
}

const scopeKey = (s: DiagramScope) => [s.connectionId, s.database].join('\u0000');
const canonical = (v: unknown) => EJSON.serialize({ v }, { relaxed: false }).v;

async function parallel<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

function valueAt(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

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
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
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
    const progress = (text: string) => {
      if (requestId === this.lastRequest) this.post({ type: 'progress', requestId, text });
    };
    try {
      const db = (await this.client()).db(this.scope.database);
      const infos = (await db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray()).filter((c) => !c.name.startsWith('system.'));
      const collections: RelCollection[] = infos
        .map((c) => ({
          name: c.name,
          view: c.type === 'view' || undefined,
          viewOn: c.type === 'view' ? String((c.options as Document | undefined)?.viewOn ?? '') || undefined : undefined,
          sampled: 0,
          fields: [],
          unique: [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const sampled: Parameters<typeof candidates>[0] = [];
      const dbrefs = new Map<string, Map<string, Set<string>>>();
      let done = 0;
      const tables = collections.filter((c) => !c.view);
      progress(`Sampling ${tables.length} collection${tables.length === 1 ? '' : 's'}…`);
      await parallel(
        tables,
        async (c) => {
          const coll = db.collection(c.name);
          try {
            const [documents, indexes] = await Promise.all([coll.estimatedDocumentCount().catch(() => undefined), coll.listIndexes().toArray().catch(() => [] as Document[])]);
            c.documents = documents;
            c.unique = indexes
              .filter((ix) => ix.unique && !ix.partialFilterExpression && Object.keys(ix.key).length === 1 && ix.name !== '_id_')
              .map((ix) => Object.keys(ix.key)[0]);
            const cursor =
              documents !== undefined && documents > sample
                ? coll.aggregate([{ $sample: { size: sample } }], { promoteValues: false, bsonRegExp: true, maxTimeMS: MAX_TIME_MS })
                : coll.find({}, { promoteValues: false, bsonRegExp: true, limit: sample, maxTimeMS: MAX_TIME_MS });
            const docs = (await cursor.toArray()).map((d) => EJSON.serialize(d, { relaxed: false }));
            const found = sampleFields(docs);
            c.sampled = docs.length;
            c.fields = found.fields;
            sampled.push({ name: c.name, fields: found.fields, values: found.values, unique: c.unique });
            if (found.dbrefs.size) dbrefs.set(c.name, found.dbrefs);
          } catch {
            // Not readable (permissions): shown without fields.
          }
          progress(`Sampled ${++done} of ${tables.length} collections…`);
        },
      );
      if (requestId !== this.lastRequest) return;

      const relations = await this.references(db, candidates(sampled), progress);
      // DBRefs name their collection.
      for (const [from, paths] of dbrefs) {
        const c = collections.find((x) => x.name === from)!;
        for (const [path, targets] of paths) {
          for (const target of targets) {
            const to = target.startsWith(`${this.scope.database}.`) ? target.slice(this.scope.database.length + 1) : target;
            if (!collections.some((x) => x.name === to)) continue;
            const field = c.fields.find((f) => f.path === path)!;
            relations.push({ id: `${from}.${path}→${to}._id`, from, field: path, fieldLabel: field.label, to, toField: '_id', many: field.many, kind: 'dbref', matched: 0, tested: 0 });
          }
        }
      }
      for (const c of collections) {
        if (c.view && c.viewOn && collections.some((x) => x.name === c.viewOn)) {
          relations.push({ id: `${c.name}→${c.viewOn}`, from: c.name, field: '', fieldLabel: '', to: c.viewOn, toField: '', many: false, kind: 'view', matched: 0, tested: 0 });
        }
      }
      if (requestId !== this.lastRequest) return;
      this.graph = { database: this.scope.database, collections, relations, sample };
      this.post({ type: 'graph', requestId, graph: this.graph });
    } catch (err) {
      if (requestId === this.lastRequest) this.post({ type: 'graph', requestId, error: errorMessage(err) });
    }
  }

  /** Looks the candidates' values up: one query per target field, for every candidate pointing to it. */
  private async references(db: ReturnType<MongoClient['db']>, list: Candidate[], progress: (text: string) => void): Promise<Relation[]> {
    const targets = new Map<string, { to: string; toField: string; values: Map<string, unknown> }>();
    for (const c of list) {
      for (const t of c.targets) {
        const key = `${t.to}\u0000${t.toField}`;
        const entry = targets.get(key) ?? { ...t, values: new Map<string, unknown>() };
        targets.set(key, entry);
        for (const v of c.values) entry.values.set(refKey(v), v);
      }
    }
    if (!targets.size) return [];
    progress(`Checking ${list.length} possible reference${list.length === 1 ? '' : 's'} in ${targets.size} collection${targets.size === 1 ? '' : 's'}…`);
    const found = new Map<string, Set<string>>();
    await parallel([...targets.entries()], async ([key, t]) => {
      const keys = new Set<string>();
      const values = [...t.values.values()].map((v) => EJSON.deserialize({ v } as Document, { relaxed: false }).v);
      try {
        for (let i = 0; i < values.length; i += LOOKUP_CHUNK) {
          const chunk = values.slice(i, i + LOOKUP_CHUNK);
          const docs = await db
            .collection(t.to)
            .find({ [t.toField]: { $in: chunk } }, { projection: { [t.toField]: 1 }, promoteValues: false, maxTimeMS: MAX_TIME_MS })
            .toArray();
          for (const d of docs) keys.add(refKey(canonical(valueAt(d, t.toField))));
        }
      } catch {
        // Not readable: no references found there.
      }
      found.set(key, keys);
    });
    const relations = new Map<string, Relation>();
    for (const c of list) {
      for (const t of c.targets) {
        const keys = found.get(`${t.to}\u0000${t.toField}`) ?? new Set<string>();
        const matched = c.values.filter((v) => keys.has(refKey(v))).length;
        if (!isReference(c.type as RefType, matched, c.values.length)) continue;
        const id = `${c.from}.${c.field.path}→${t.to}.${t.toField}`;
        const prev = relations.get(id);
        if (prev && prev.matched / prev.tested >= matched / c.values.length) continue;
        relations.set(id, { id, from: c.from, field: c.field.path, fieldLabel: c.field.label, to: t.to, toField: t.toField, many: c.field.many, kind: 'reference', matched, tested: c.values.length });
      }
    }
    return [...relations.values()].sort((a, b) => a.id.localeCompare(b.id));
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
