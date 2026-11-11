// The History tab of a document: its writes read back from the oplog (src/oplogHistory.ts), the versions
// rebuilt from them (src/shared/docHistory.ts), who wrote them, and restoring one of them.
import * as vscode from 'vscode';
import { BSON, Document } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import { paintTab } from './connectionColors';
import type { CollectionRef, DocumentFileSystem } from './documentFs';
import { CollectionPanel } from './collectionPanel';
import { UndoHistory } from './history';
import { RedisOplog } from './redisOplog';
import { DocumentOplog, OplogHistoryError } from './oplogHistory';
import { fieldDiff } from './shared/compare';
import { DocHistory, DocVersion, displayValue, opKey } from './shared/docHistory';
import type { DocHistoryHostMessage, DocHistoryInfo, DocHistoryViewMessage, DocVersionView } from './shared/messages';
import { relaxEjson, toShell } from './shared/query';
import { errorMessage } from './tree';

const { EJSON } = BSON;
const READ = { promoteValues: false, bsonRegExp: true } as const;
/** How far a write of the undo history may be from the oplog entry's wall clock (the client's and the server's clocks differ). */
const BEFORE_MS = 60_000;
const AFTER_MS = 300_000;

const canonical = (v: unknown) => EJSON.serialize({ v }, { relaxed: false }).v as unknown;
const idText = (id: unknown) => toShell(relaxEjson(canonical(id)));
const panelKey = (ref: CollectionRef, id: unknown) => [ref.connectionId, ref.database, ref.collection, JSON.stringify(canonical(id))].join('\u0000');

export class DocumentHistoryPanel {
  private static readonly panels = new Map<string, DocumentHistoryPanel>();
  private readonly panel: vscode.WebviewPanel;
  private reader?: DocumentOplog;
  private history?: DocHistory;
  /** Incremented by every load: an older one stops quietly. */
  private generation = 0;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, documents: DocumentFileSystem, ref: CollectionRef, id: unknown): void {
    const key = panelKey(ref, id);
    const existing = DocumentHistoryPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      void existing.load(false);
      return;
    }
    const p = new DocumentHistoryPanel(context, connections, documents, ref, id);
    DocumentHistoryPanel.panels.set(key, p);
    p.panel.onDidDispose(() => {
      p.generation++;
      DocumentHistoryPanel.panels.delete(key);
    });
  }

  /** The History of the document open in an editor tab (a mongoster:// document). */
  static async showEditor(context: vscode.ExtensionContext, connections: ConnectionManager, documents: DocumentFileSystem, uri: vscode.Uri | undefined): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const params = new URLSearchParams(target?.query ?? '');
    const idJson = params.get('id');
    if (!target || target.scheme !== 'mongoster' || !idJson) {
      void vscode.window.showInformationMessage('Open a document of a collection first: a new document has no history yet.');
      return;
    }
    const [database, collection] = target.path.split('/').slice(1, 3).map(decodeURIComponent);
    const id = EJSON.parse(idJson, { relaxed: false })._id;
    DocumentHistoryPanel.show(context, connections, documents, { connectionId: target.authority, database, collection }, id);
  }

  /** Closes the tabs of a connection (removed). */
  static close(connectionId: string): void {
    for (const p of [...DocumentHistoryPanel.panels.values()]) if (p.ref.connectionId === connectionId) p.panel.dispose();
  }

  /** Name, color and read-only changes. */
  static connectionChanged(info: ConnectionInfo): void {
    for (const p of DocumentHistoryPanel.panels.values()) if (p.ref.connectionId === info.id) p.postInit();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly documents: DocumentFileSystem,
    private readonly ref: CollectionRef,
    private id: unknown,
  ) {
    this.panel = vscode.window.createWebviewPanel('mongoster.documentHistory', `History: ${idText(id)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    paintTab(this.panel, context.extensionUri, connections.get(ref.connectionId)?.color);
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: DocHistoryViewMessage) => void this.receive(m));
  }

  private post(m: DocHistoryHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private info(): DocHistoryInfo {
    const c = this.connections.get(this.ref.connectionId);
    return {
      connectionName: c?.name ?? '?',
      color: c?.color,
      database: this.ref.database,
      collection: this.ref.collection,
      id: idText(this.id),
      readOnly: c?.readOnly ? `The connection ${c.name} is read-only.` : undefined,
    };
  }

  private postInit(): void {
    paintTab(this.panel, this.context.extensionUri, this.connections.get(this.ref.connectionId)?.color);
    this.post({ type: 'init', info: this.info() });
  }

  private async receive(m: DocHistoryViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postInit();
        await this.load(false);
        break;
      case 'refresh':
        await this.load(false);
        break;
      case 'loadOlder':
        await this.load(true);
        break;
      case 'restore':
        await this.restore(m.key);
        break;
      case 'openDocument':
        await this.documents.open({ ...this.ref, readOnly: !!this.connections.get(this.ref.connectionId)?.readOnly }, this.id);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('Mongoster: copied to clipboard', 2000);
        break;
    }
  }

  /** Reads the history again from the newest write, or (`older`) the page before what was read. */
  private async load(older: boolean): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const started = Date.now();
    this.post({ type: 'loading', older });
    try {
      const client = await this.connections.getClient(this.ref.connectionId);
      if (!older || !this.reader) {
        this.reader = new DocumentOplog(client, this.ref.database, this.ref.collection, this.id);
        await this.reader.check();
      }
      const reader = this.reader;
      await reader.readPage();
      const doc = await reader.current();
      if (!current()) return;
      // The stored _id (a number's type, say) is the one to write back.
      if (doc) this.id = doc._id;
      const history = reader.history(doc);
      this.history = history;
      const labels = await this.ownWrites(history);
      if (!current()) return;
      const versions = history.versions.map((v, k) => this.view(v, k === history.versions.length - 1 && !!doc, labels.get(opKey(v.op)))).reverse();
      this.post({
        type: 'result',
        versions,
        exists: !!doc,
        oplogFirst: reader.firstTime,
        oplogLast: reader.lastTime,
        readFrom: reader.fromTime,
        complete: reader.complete,
        before: history.before.state,
        conflict: history.conflict,
        durationMs: Date.now() - started,
        timedOut: reader.timedOut || undefined,
      });
    } catch (err) {
      if (!current()) return;
      this.post({ type: 'error', message: errorMessage(err), kind: err instanceof OplogHistoryError ? err.kind : 'other' });
    }
  }

  /** Mongoster's own writes among the versions, from the undo history: label by version key. */
  private async ownWrites(history: DocHistory): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const undo = UndoHistory.get();
    const timed = history.versions.filter((v) => v.op.wall && v.kind !== 'drop' && v.kind !== 'renamed');
    if (!undo || !timed.length) return out;
    const times = timed.map((v) => Date.parse(v.op.wall!));
    const writes = await undo.writesOf(this.ref, this.id, Math.min(...times) - BEFORE_MS, Math.max(...times) + AFTER_MS).catch(() => []);
    const expected = { insert: 'inserted', delete: 'deleted', update: 'updated', replace: 'updated' } as Record<string, string>;
    // The nearest recorded write of the same kind, each used once.
    for (const v of timed) {
      const wall = Date.parse(v.op.wall!);
      let best = -1;
      writes.forEach((w, i) => {
        if (w.kind !== expected[v.kind] || w.time < wall - BEFORE_MS || w.time > wall + AFTER_MS) return;
        if (best < 0 || Math.abs(w.time - wall) < Math.abs(writes[best].time - wall)) best = i;
      });
      if (best >= 0) {
        out.set(opKey(v.op), writes[best].label);
        writes.splice(best, 1);
      }
    }
    return out;
  }

  private view(v: DocVersion, current: boolean, mongoster: string | undefined): DocVersionView {
    const op = v.op;
    return {
      key: opKey(op),
      time: op.wall ?? new Date(op.t * 1000).toISOString(),
      ts: `Timestamp({ t: ${op.t}, i: ${op.i} })`,
      kind: v.kind,
      ...(v.changes && { set: v.changes.set, unset: v.changes.unset, truncated: v.changes.truncated }),
      ...(op.command && { command: op.command }),
      state: v.state,
      ...(v.doc && { doc: displayValue(v.doc) }),
      ...(v.unknown && { unknown: v.unknown }),
      diff: v.diff,
      ...(current && { current }),
      ...(op.group && { group: op.group }),
      ...(op.partial && { partial: true }),
      ...(op.prepared && { prepared: true }),
      ...(op.lsid && { lsid: op.lsid }),
      ...(op.txnNumber && { txnNumber: op.txnNumber }),
      ...(op.migrate && { migrate: true }),
      ...(mongoster && { mongoster }),
      ...(v.mismatch && { mismatch: v.mismatch }),
    };
  }

  /**
   * Puts the document back as it was in a version, after a modal confirmation: replaced, or inserted
   * again when it was deleted. Recorded in the undo history and published to redis-oplog like any edit.
   */
  private async restore(key: string): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'restored', ok, message });
    const info = this.connections.get(this.ref.connectionId);
    if (!info) return reply(false, 'The connection no longer exists.');
    if (info.readOnly) return reply(false, `The connection ${info.name} is read-only: nothing can be restored through it.`);
    const version = this.history?.versions.find((v) => opKey(v.op) === key);
    if (!version?.doc || version.state !== 'exact') return reply(false, 'Only a version whose fields are all known can be restored.');
    const when = new Date(version.op.wall ?? version.op.t * 1000);
    const label = `${idText(this.id)} as of ${when.toLocaleString()}`;
    try {
      const coll = (await this.connections.getClient(this.ref.connectionId)).db(this.ref.database).collection(this.ref.collection);
      const before = await coll.findOne({ _id: this.id } as Document, READ);
      const opts = { ignore: [], ignoreOrder: false, numbersByValue: false };
      const changes = before ? fieldDiff(canonical(before), version.doc, opts).length : 0;
      if (before && !changes) return reply(false, 'The document is already as it was in this version.');
      const answer = await vscode.window.showWarningMessage(
        before ? `Restore ${label}?` : `Insert ${label} again?`,
        {
          modal: true,
          detail: [
            before
              ? `It replaces the document as it is now in ${this.ref.database}.${this.ref.collection}: ${changes.toLocaleString('en-US')} field${changes === 1 ? '' : 's'} differ.`
              : `The document was deleted: it is inserted again in ${this.ref.database}.${this.ref.collection}.`,
            UndoHistory.note(this.ref.connectionId, 1),
          ].join('\n'),
        },
        before ? 'Restore' : 'Insert Again',
      );
      if (!answer) return reply(false);
      const doc = EJSON.deserialize(version.doc, { relaxed: false }) as Document;
      const target = { connectionId: this.ref.connectionId, database: this.ref.database, collection: this.ref.collection };
      const rec = UndoHistory.start(target, `Restore ${label}`);
      await rec?.snapshotIds(coll, [this.id]);
      if (before) {
        const res = await coll.replaceOne({ _id: before._id } as Document, doc);
        if (!res.matchedCount) throw new Error('The document was deleted meanwhile: restore again to insert it.');
      } else await coll.insertOne(doc);
      const after = await coll.findOne({ _id: this.id } as Document, READ);
      RedisOplog.sink(target)?.changes(before ? [before] : [], after ? [after] : []);
      const entry = await rec?.commit(coll);
      const message = before ? `Restored ${label}.` : `Inserted ${label} again.`;
      reply(true, message);
      UndoHistory.notify(message, entry);
      CollectionPanel.refresh(this.ref);
      void vscode.commands.executeCommand('mongoster.refresh');
    } catch (err) {
      return reply(false, `Restore failed: ${errorMessage(err)}`);
    }
    await this.load(false);
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
  <link rel="stylesheet" href="${asset('media', 'compare.css')}">
  <link rel="stylesheet" href="${asset('media', 'docHistory.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Document History</title>
</head>
<body>
  <header class="bar">
    <span class="title">History</span>
    <span id="target" class="target"></span>
    <span id="badge" class="badge hidden">read-only</span>
    <div class="spacer"></div>
    <button id="open" class="secondary" title="Open the document as it is now in an editor tab">Open Document</button>
    <button id="refresh" class="secondary" title="Read the oplog again">Refresh</button>
  </header>
  <div id="window" class="window info"></div>
  <div id="error" class="error hidden"></div>
  <div id="message" class="message hidden"></div>
  <main class="list" id="list"></main>
  <div id="more" class="more hidden">
    <span id="moreInfo" class="info"></span>
    <button id="older" class="secondary" title="Read the older part of the oplog">Load older</button>
  </div>
  <script nonce="${nonce}" src="${asset('dist', 'docHistory.js')}"></script>
</body>
</html>`;
  }
}
