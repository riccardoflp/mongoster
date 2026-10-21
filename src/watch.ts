// Change streams: a tab that shows, as they happen, the changes of a collection, a database or the
// whole deployment, with the document before (when the collection records pre-images) and after.
import * as vscode from 'vscode';
import { BSON, ChangeStream, ChangeStreamOptions, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { DocumentFileSystem } from './documentFs';
import { fromRelaxed, toBson } from './queries';
import type { WatchEvent, WatchHostMessage, WatchOptions, WatchState, WatchViewMessage } from './shared/messages';
import { relaxEjson, toShell } from './shared/query';
import { errorMessage } from './tree';

const { EJSON } = BSON;

/** Events are sent to the tab at most this often. */
const FLUSH_MS = 150;
/** How long a getMore waits for changes before the loop checks whether it was stopped. */
const AWAIT_MS = 1000;
const SUMMARY_MAX = 200;

export interface WatchScope {
  connectionId: string;
  database?: string;
  collection?: string;
}

const scopeKey = (s: WatchScope) => [s.connectionId, s.database ?? '', s.collection ?? ''].join('\u0000');
const relaxed = (v: unknown) => relaxEjson(EJSON.serialize(v, { relaxed: false }));

function scopeTitle(scope: WatchScope, info: ConnectionInfo): string {
  return `Watch: ${scope.collection ?? scope.database ?? info.name}`;
}

export class WatchPanel {
  private static readonly panels = new Map<string, WatchPanel>();
  private readonly panel: vscode.WebviewPanel;
  private stream?: ChangeStream;
  /** Incremented on every start and stop: a loop of an older stream ends quietly. */
  private generation = 0;
  private seq = 0;
  private queue: WatchEvent[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, documents: DocumentFileSystem, info: ConnectionInfo, scope: WatchScope): void {
    const existing = WatchPanel.panels.get(scopeKey(scope));
    if (existing) {
      existing.panel.reveal();
      return;
    }
    WatchPanel.panels.set(scopeKey(scope), new WatchPanel(context, connections, documents, info, scope));
  }

  static connectionChanged(info: ConnectionInfo): void {
    for (const p of WatchPanel.panels.values()) {
      if (p.scope.connectionId !== info.id) continue;
      p.info = info;
      p.panel.title = scopeTitle(p.scope, info);
      void p.postInit();
    }
  }

  /** Closes the tabs of a connection, or of a database or collection when given. */
  static close(connectionId: string, database?: string, collection?: string): void {
    for (const p of [...WatchPanel.panels.values()]) {
      const s = p.scope;
      if (s.connectionId !== connectionId) continue;
      if (database !== undefined && s.database !== database) continue;
      if (collection !== undefined && s.collection !== collection) continue;
      p.panel.dispose();
    }
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly documents: DocumentFileSystem,
    private info: ConnectionInfo,
    private readonly scope: WatchScope,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.watch',
      scopeTitle(scope, info),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      WatchPanel.panels.delete(scopeKey(scope));
      void this.stop();
    });
    this.panel.webview.onDidReceiveMessage((m: WatchViewMessage) => void this.receive(m));
  }

  private post(m: WatchHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private status(state: WatchState, message?: string): void {
    this.post({ type: 'status', state, message });
  }

  private client(): Promise<MongoClient> {
    return this.connections.getClient(this.info.id);
  }

  private async postInit(): Promise<void> {
    let preImages: boolean | undefined;
    const { database, collection } = this.scope;
    if (database && collection) {
      try {
        const [c] = await (await this.client()).db(database).listCollections({ name: collection }, { nameOnly: false }).toArray();
        preImages = !!(c?.options as Document | undefined)?.changeStreamPreAndPostImages?.enabled;
      } catch {
        preImages = false;
      }
    }
    this.post({ type: 'init', connectionName: this.info.name, color: this.info.color, readOnly: !!this.info.readOnly, database, collection, preImages });
  }

  private async receive(m: WatchViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.postInit();
        break;
      case 'start':
        await this.start(m.options);
        break;
      case 'stop':
        await this.stop();
        this.status('stopped');
        break;
      case 'enablePreImages':
        await this.enablePreImages();
        break;
      case 'openDocument':
        await this.documents.open(
          { connectionId: this.info.id, database: m.database, collection: m.collection, readOnly: !!this.info.readOnly },
          fromRelaxed(m.id),
        );
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
    }
  }

  private async start(options: WatchOptions): Promise<void> {
    await this.stop();
    const generation = this.generation;
    this.status('starting');
    let stream: ChangeStream;
    try {
      const match = toBson(options.match, 'Filter');
      const client = await this.client();
      if (generation !== this.generation) return;
      const version = String((await client.db('admin').command({ buildInfo: 1 })).version ?? '');
      const opts: ChangeStreamOptions = { maxAwaitTimeMS: AWAIT_MS, promoteValues: false, bsonRegExp: true };
      if (options.fullDocument) opts.fullDocument = 'updateLookup';
      // Pre-images exist from MongoDB 6.0; without them on the collection, the field is just missing.
      if (Number.parseInt(version, 10) >= 6) opts.fullDocumentBeforeChange = 'whenAvailable';
      const pipeline = match ? [{ $match: match }] : [];
      const { database, collection } = this.scope;
      stream = collection
        ? client.db(database).collection(collection).watch(pipeline, opts)
        : database
          ? client.db(database).watch(pipeline, opts)
          : client.watch(pipeline, opts);
    } catch (err) {
      if (generation === this.generation) this.status('error', errorMessage(err));
      return;
    }
    if (generation !== this.generation) {
      void stream.close();
      return;
    }
    this.stream = stream;
    void this.loop(stream, generation);
  }

  private async loop(stream: ChangeStream, generation: number): Promise<void> {
    let announced = false;
    try {
      while (generation === this.generation && !stream.closed) {
        const change = await stream.tryNext();
        if (generation !== this.generation) return;
        if (!announced) {
          announced = true;
          this.status('watching');
        }
        if (!change) continue;
        this.push(toEvent(++this.seq, change as Document));
        if ((change as Document).operationType === 'invalidate') {
          this.flush();
          await this.stop();
          this.status('stopped', 'The stream was invalidated: the collection or database was dropped or renamed.');
          return;
        }
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.flush();
      await this.stop();
      this.status('error', explain(err));
    }
  }

  private push(event: WatchEvent): void {
    this.queue.push(event);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.queue.length) return;
    this.post({ type: 'events', events: this.queue });
    this.queue = [];
  }

  private async stop(): Promise<void> {
    this.generation++;
    const stream = this.stream;
    this.stream = undefined;
    this.flush();
    await stream?.close().catch(() => undefined);
  }

  private async enablePreImages(): Promise<void> {
    const { database, collection } = this.scope;
    if (!database || !collection) return;
    if (this.info.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${this.info.name} is read-only: the collection options can't be changed.`);
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Record pre-images of ${database}.${collection}?`,
      {
        modal: true,
        detail:
          'Enables changeStreamPreAndPostImages on the collection (collMod): from now on, the document before each update, replace and delete is stored, so it can be shown here. It uses storage, and is a change to the collection options.',
      },
      'Enable',
    );
    if (answer !== 'Enable') return;
    try {
      await (await this.client()).db(database).command({ collMod: collection, changeStreamPreAndPostImages: { enabled: true } });
    } catch (err) {
      void vscode.window.showErrorMessage(`Pre-images not enabled: ${errorMessage(err)}`);
      return;
    }
    await this.postInit();
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
  <link rel="stylesheet" href="${asset('media', 'watch.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Watch</title>
</head>
<body>
  <header class="bar">
    <span id="title" class="title"></span>
    <span id="status" class="status"></span>
    <div class="spacer"></div>
    <button id="pause" class="secondary" title="Hold the new events without stopping the stream">Pause</button>
    <button id="startStop" class="secondary">Stop</button>
    <button id="clear" class="secondary" title="Remove the events from the list">Clear</button>
  </header>
  <section class="view">
    <div class="toolbar">
      <span class="ops" id="ops"></span>
      <input id="search" type="search" placeholder="Search the events" spellcheck="false">
      <span id="info" class="info"></span>
    </div>
    <div class="toolbar">
      <label for="match" title="A $match on the change events, applied by the server">$match</label>
      <input id="match" class="match" type="text" spellcheck="false" placeholder="{ &quot;fullDocument.status&quot;: &quot;active&quot; }  —  Enter applies">
      <label title="On updates, also read the current version of the document"><input id="fullDocument" type="checkbox"> Current document on update</label>
      <span id="preImages" class="pre-images hidden"></span>
    </div>
    <div id="error" class="error hidden"></div>
    <div class="table-wrap"><table id="events"></table></div>
  </section>
  <script nonce="${nonce}" src="${asset('dist', 'watch.js')}"></script>
</body>
</html>`;
  }
}

function explain(err: unknown): string {
  const message = errorMessage(err);
  // 40573: $changeStream on a standalone server.
  if ((err as { code?: number })?.code === 40573 || /only supported on replica sets/i.test(message)) {
    return 'Change streams need a replica set or a sharded cluster: this server is a standalone. (A single-node replica set is enough, e.g. mongod --replSet rs0 and rs.initiate().)';
  }
  return message;
}

/** The fields of an update, as "$set a, b · $unset c". */
function updateSummary(updated: Document | undefined, removed: string[] | undefined, truncated: unknown[] | undefined): string {
  const parts: string[] = [];
  const set = Object.keys(updated ?? {});
  if (set.length) parts.push(`set ${set.join(', ')}`);
  if (removed?.length) parts.push(`unset ${removed.join(', ')}`);
  if (truncated?.length) parts.push(`truncated ${(truncated as { field: string }[]).map((t) => t.field).join(', ')}`);
  return parts.join(' · ');
}

function short(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

export function toEvent(seq: number, change: Document): WatchEvent {
  const op = String(change.operationType ?? '');
  const ns = change.ns ? [change.ns.db, change.ns.coll].filter(Boolean).join('.') : '';
  const seconds = change.clusterTime?.getHighBitsUnsigned?.() ?? change.clusterTime?.high;
  const time = change.wallTime instanceof Date ? change.wallTime : seconds ? new Date(Number(seconds) * 1000) : new Date();
  const id = change.documentKey?._id;
  const ud = change.updateDescription as Document | undefined;
  const after = change.fullDocument ? relaxed(change.fullDocument) : undefined;
  const before = change.fullDocumentBeforeChange ? relaxed(change.fullDocumentBeforeChange) : undefined;
  let summary = '';
  if (op === 'update') summary = updateSummary(ud?.updatedFields, ud?.removedFields, ud?.truncatedArrays);
  else if ((op === 'insert' || op === 'replace') && after) summary = short(toShell(after));
  else if (op === 'rename' && change.to) summary = `→ ${[change.to.db, change.to.coll].filter(Boolean).join('.')}`;
  return {
    seq,
    time: time.toISOString(),
    op,
    ns,
    id: id === undefined ? undefined : relaxed(id),
    key: id === undefined ? undefined : toShell(relaxed(id)),
    summary,
    updated: ud?.updatedFields ? (relaxed(ud.updatedFields) as Record<string, unknown>) : undefined,
    removed: ud?.removedFields?.length ? ud.removedFields : undefined,
    truncated: ud?.truncatedArrays?.length ? (ud.truncatedArrays as { field: string; newSize: number }[]).map((t) => ({ field: t.field, newSize: Number(t.newSize) })) : undefined,
    before,
    after,
    raw: relaxed(change),
  };
}
