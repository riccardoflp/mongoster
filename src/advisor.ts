// Index advisor: a tab that reads the indexes of a collection, a database or the whole deployment (with
// their use from $indexStats) and the slow operations (the profiler, or else the server log), and lists
// the indexes to create, the redundant ones and the unused ones, with the action for each.
import * as vscode from 'vscode';
import { ThemeColors } from './themeColors';
import { BSON, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import { openOperation } from './monitor';
import { Advice, AdvisorCollection, AdvisorIndex, analyze } from './shared/advisor';
import type { AdvisorHostMessage, AdvisorReport, AdvisorSources, AdvisorViewMessage } from './shared/messages';
import { SlowOp, fromLogLine, fromProfileDoc, isNoise, splitNs } from './shared/profile';
import { relaxEjson, toShell } from './shared/query';
import { errorMessage } from './tree';

const { EJSON } = BSON;

/** Profiler documents read per database, newest first. */
const PROFILE_LIMIT = 5000;
/** Collections read at the same time. */
const PARALLEL = 8;
const SKIPPED_DATABASES = ['admin', 'local', 'config'];

export interface AdvisorScope {
  connectionId: string;
  database?: string;
  collection?: string;
}

const scopeKey = (s: AdvisorScope) => [s.connectionId, s.database ?? '', s.collection ?? ''].join('\u0000');
const relaxed = (v: unknown) => relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v);
const scopeTitle = (scope: AdvisorScope, info: ConnectionInfo) => `Index Advisor: ${scope.collection ?? scope.database ?? info.name}`;

async function parallel<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

export class AdvisorPanel {
  private static readonly panels = new Map<string, AdvisorPanel>();
  private readonly panel: vscode.WebviewPanel;
  /** The advice of the last report, to act on. */
  private advice: Advice[] = [];
  private documents = new Map<string, number | undefined>();
  private lastRequest = 0;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, info: ConnectionInfo, scope: AdvisorScope): void {
    const existing = AdvisorPanel.panels.get(scopeKey(scope));
    if (existing) {
      existing.panel.reveal();
      return;
    }
    AdvisorPanel.panels.set(scopeKey(scope), new AdvisorPanel(context, connections, info, scope));
  }

  static connectionChanged(info: ConnectionInfo): void {
    for (const p of AdvisorPanel.panels.values()) {
      if (p.scope.connectionId !== info.id) continue;
      p.info = info;
      p.panel.title = scopeTitle(p.scope, info);
      p.postInit();
    }
  }

  static close(connectionId: string): void {
    for (const p of [...AdvisorPanel.panels.values()]) if (p.scope.connectionId === connectionId) p.panel.dispose();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private info: ConnectionInfo,
    private readonly scope: AdvisorScope,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.advisor',
      scopeTitle(scope, info),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    ThemeColors.attach(this.panel);
    this.panel.onDidDispose(() => AdvisorPanel.panels.delete(scopeKey(scope)));
    this.panel.webview.onDidReceiveMessage((m: AdvisorViewMessage) => void this.receive(m));
  }

  private post(m: AdvisorHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private postInit(): void {
    this.post({ type: 'init', connectionName: this.info.name, color: this.info.color, readOnly: !!this.info.readOnly, database: this.scope.database, collection: this.scope.collection });
  }

  private client(): Promise<MongoClient> {
    return this.connections.getClient(this.info.id);
  }

  private async receive(m: AdvisorViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postInit();
        break;
      case 'analyze':
        await this.analyze(m.requestId);
        break;
      case 'create':
        await this.create(m.id);
        break;
      case 'hide':
        await this.hide(m.database, m.collection, m.name, m.hidden);
        break;
      case 'drop':
        await this.drop(m.database, m.collection, m.name, m.why);
        break;
      case 'openQuery': {
        const advice = this.advice.find((a) => a.id === m.id);
        const query = advice?.kind === 'create' ? advice.queries[m.query] : undefined;
        if (advice && query) await openOperation(this.info.id, `${advice.database}.${advice.collection}`, query.kind, query.example.query, m.explain);
        break;
      }
      case 'enableProfiler':
        await this.enableProfiler(m.database);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
    }
  }

  // ---- reading

  private async databases(client: MongoClient): Promise<string[]> {
    if (this.scope.database) return [this.scope.database];
    try {
      const res = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
      return res.databases
        .map((d) => d.name)
        .filter((d) => !SKIPPED_DATABASES.includes(d))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [client.options.dbName];
    }
  }

  /** The collections of the scope with their indexes, their use and sizes. */
  private async collections(client: MongoClient, databases: string[], failed: AdvisorReport['failed']): Promise<{ list: AdvisorCollection[]; profiled: Set<string> }> {
    const list: AdvisorCollection[] = [];
    const profiled = new Set<string>();
    for (const database of databases) {
      const infos = await client
        .db(database)
        .listCollections(this.scope.collection ? { name: this.scope.collection } : {}, { nameOnly: false, authorizedCollections: true })
        .toArray();
      if (!this.scope.collection && infos.some((c) => c.name === 'system.profile')) profiled.add(database);
      for (const c of infos) {
        // Views have no indexes; system collections are the server's.
        if (c.type === 'view' || c.name.startsWith('system.')) continue;
        list.push({ database, collection: c.name, indexes: [] });
      }
    }
    if (this.scope.collection && this.scope.database) {
      const names = await client.db(this.scope.database).listCollections({ name: 'system.profile' }, { nameOnly: true }).toArray().catch(() => []);
      if (names.length) profiled.add(this.scope.database);
    }
    await parallel(list, async (c) => {
      const coll = client.db(c.database).collection(c.collection);
      try {
        const [indexes, stats, sizes, documents] = await Promise.all([
          coll.listIndexes().toArray(),
          coll
            .aggregate<Document>([{ $indexStats: {} }])
            .toArray()
            .catch(() => [] as Document[]),
          coll
            .aggregate<Document>([{ $collStats: { storageStats: {} } }])
            .toArray()
            .then((r) => (r[0]?.storageStats?.indexSizes ?? {}) as Record<string, unknown>)
            .catch(() => ({}) as Record<string, unknown>),
          coll.estimatedDocumentCount().catch(() => undefined),
        ]);
        c.documents = documents;
        c.indexes = indexes.map((ix): AdvisorIndex => {
          const stat = stats.find((s) => s.name === ix.name);
          return {
            name: String(ix.name),
            key: relaxed(ix.key) as Record<string, unknown>,
            unique: ix.unique || undefined,
            sparse: ix.sparse || undefined,
            hidden: ix.hidden || undefined,
            expireAfterSeconds: ix.expireAfterSeconds,
            partialFilterExpression: ix.partialFilterExpression ? relaxed(ix.partialFilterExpression) : undefined,
            collation: ix.collation?.locale,
            size: sizes[ix.name] !== undefined ? Number(sizes[ix.name]) : undefined,
            ops: stat ? Number(stat.accesses?.ops) : undefined,
            since: stat?.accesses?.since instanceof Date ? stat.accesses.since.toISOString() : undefined,
            building: stat?.building || undefined,
          };
        });
      } catch (err) {
        failed.push({ ns: `${c.database}.${c.collection}`, error: errorMessage(err) });
      }
    });
    return { list: list.filter((c) => c.indexes.length), profiled };
  }

  /** Slow operations on the collections: from system.profile where it has some, from the server log for the others. */
  private async slowOps(client: MongoClient, databases: string[], profiled: Set<string>, inScope: (ns: string) => boolean): Promise<{ ops: SlowOp[]; sources: AdvisorSources }> {
    const sources: AdvisorSources = { profiler: [], log: { ops: 0 } };
    const ops: SlowOp[] = [];
    const fromProfiler = new Set<string>();
    for (const database of databases) {
      const db = client.db(database);
      const entry: AdvisorSources['profiler'][number] = { database, ops: 0 };
      sources.profiler.push(entry);
      try {
        const status = await db.command({ profile: -1 });
        entry.level = Number(status.was);
        sources.slowms ??= Number(status.slowms);
      } catch (err) {
        entry.error = errorMessage(err);
      }
      if (!profiled.has(database)) continue;
      try {
        const docs = await db.collection('system.profile').find({}).sort({ ts: -1 }).limit(PROFILE_LIMIT).toArray();
        const found = docs.map((d) => fromProfileDoc(relaxed(d) as Record<string, unknown>)).filter((op) => !isNoise(op) && inScope(op.ns));
        entry.ops = found.length;
        if (found.length) fromProfiler.add(database);
        ops.push(...found);
      } catch (err) {
        entry.error = errorMessage(err);
      }
    }
    try {
      const res = await client.db('admin').command({ getLog: 'global' });
      const found = ((res.log ?? []) as string[])
        .map(fromLogLine)
        .filter((op): op is SlowOp => !!op && !isNoise(op) && inScope(op.ns) && !fromProfiler.has(splitNs(op.ns).database));
      sources.log.ops = found.length;
      ops.push(...found);
    } catch (err) {
      sources.log.error = errorMessage(err);
    }
    sources.since = ops.reduce<string | undefined>((min, op) => (!min || op.ts < min ? op.ts : min), undefined);
    return { ops, sources };
  }

  private async analyze(requestId: number): Promise<void> {
    this.lastRequest = requestId;
    try {
      const client = await this.client();
      const databases = await this.databases(client);
      const failed: AdvisorReport['failed'] = [];
      const { list, profiled } = await this.collections(client, databases, failed);
      const names = new Set(list.map((c) => `${c.database}.${c.collection}`));
      const { ops, sources } = await this.slowOps(client, databases, profiled, (ns) => names.has(ns));
      if (requestId !== this.lastRequest) return;
      const { advice, tooRecent } = analyze(list, ops);
      this.advice = advice;
      this.documents = new Map(list.map((c) => [`${c.database}.${c.collection}`, c.documents]));
      const indexes = list.flatMap((c) => c.indexes);
      this.post({
        type: 'report',
        requestId,
        report: {
          advice: this.advice,
          collections: list.length,
          indexes: indexes.length,
          indexBytes: indexes.reduce((n, ix) => n + (ix.size ?? 0), 0),
          tooRecent,
          sources,
          failed,
        },
      });
    } catch (err) {
      if (requestId === this.lastRequest) this.post({ type: 'report', requestId, error: errorMessage(err) });
    }
  }

  // ---- actions

  private reply(ok: boolean, message?: string): void {
    this.post({ type: 'actionResult', ok, message });
  }

  private refuseWrite(): boolean {
    if (!this.info.readOnly) return false;
    this.reply(false, `The connection ${this.info.name} is read-only: indexes can't be changed.`);
    return true;
  }

  private async create(id: string): Promise<void> {
    const advice = this.advice.find((a) => a.id === id);
    if (advice?.kind !== 'create' || this.refuseWrite()) return;
    const ns = `${advice.database}.${advice.collection}`;
    const documents = this.documents.get(ns);
    const answer = await vscode.window.showWarningMessage(
      `Create the index ${toShell(advice.keys)} on ${ns}?`,
      {
        modal: true,
        detail: `Building an index reads the whole collection${documents ? ` (${documents.toLocaleString('en-US')} documents)` : ''}: on a large collection it takes time and loads the server. Every write then also updates the index.`,
      },
      'Create Index',
    );
    if (answer !== 'Create Index') return this.reply(false);
    try {
      const name = await (await this.client()).db(advice.database).collection(advice.collection).createIndex(advice.keys);
      this.reply(true, `Created the index ${name} on ${ns}.`);
    } catch (err) {
      this.reply(false, `Index not created: ${errorMessage(err)}`);
    }
  }

  private async hide(database: string, collection: string, name: string, hidden: boolean): Promise<void> {
    if (this.refuseWrite()) return;
    try {
      await (await this.client()).db(database).command({ collMod: collection, index: { name, hidden } });
      this.reply(
        true,
        hidden
          ? `The index ${name} of ${database}.${collection} is hidden: queries no longer use it, but it is still kept up to date. Unhide it if something gets slower.`
          : `The index ${name} of ${database}.${collection} is used again.`,
      );
    } catch (err) {
      this.reply(false, `Index not ${hidden ? 'hidden' : 'unhidden'}: ${errorMessage(err)}`);
    }
  }

  private async drop(database: string, collection: string, name: string, why: string): Promise<void> {
    if (name === '_id_' || this.refuseWrite()) return;
    const answer = await vscode.window.showWarningMessage(
      `Drop the index ${name} of ${database}.${collection}?`,
      { modal: true, detail: `${why} Queries that use it will fall back to other indexes or a collection scan, and recreating it means building it again. Hiding it first lets you check the impact without losing it.` },
      'Drop',
    );
    if (answer !== 'Drop') return this.reply(false);
    try {
      await (await this.client()).db(database).collection(collection).dropIndex(name);
      this.reply(true, `Dropped the index ${name} of ${database}.${collection}.`);
    } catch (err) {
      this.reply(false, `Index not dropped: ${errorMessage(err)}`);
    }
  }

  private async enableProfiler(database: string): Promise<void> {
    if (this.info.readOnly) return this.reply(false, `The connection ${this.info.name} is read-only: the profiler can't be changed.`);
    try {
      const db = (await this.client()).db(database);
      const status = await db.command({ profile: -1 });
      const slowms = Number(status.slowms) || 100;
      const answer = await vscode.window.showWarningMessage(
        `Turn on the profiler of ${database}?`,
        {
          modal: true,
          detail: `Operations on ${database} slower than ${slowms} ms will be recorded in ${database}.system.profile (a small capped collection), so the advisor can see which queries need an index. Profiling adds a little work to slow operations; it can be turned off from the Server Monitor.`,
        },
        'Turn On',
      );
      if (answer !== 'Turn On') return this.reply(false);
      await db.command({ profile: 1, slowms });
      this.reply(true, `The profiler of ${database} records operations slower than ${slowms} ms. Use the application for a while, then refresh.`);
    } catch (err) {
      this.reply(false, `Profiler not changed: ${errorMessage(err)}`);
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
  <link rel="stylesheet" href="${asset('media', 'advisor.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Index Advisor</title>
</head>
<body${ThemeColors.bodyAttribute()}>
  <header class="bar">
    <span id="title" class="title"></span>
    <span id="locked" class="badge hidden" title="Indexes can't be changed on this connection">read-only</span>
    <div class="spacer"></div>
    <span id="updated" class="info"></span>
    <button id="refresh" class="secondary" title="Read the indexes and the slow operations again">Refresh</button>
  </header>
  <section class="view">
    <div id="message" class="message hidden" role="status"></div>
    <div id="error" class="error hidden"></div>
    <div id="summary" class="summary"></div>
    <div id="sources" class="sources"></div>
    <div id="report" class="report" aria-live="polite"></div>
  </section>
  <script nonce="${nonce}" src="${asset('dist', 'advisor.js')}"></script>
</body>
</html>`;
  }
}
