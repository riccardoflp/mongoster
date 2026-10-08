// Server monitor: one tab per connection with the running operations (currentOp, killOp), the slow
// queries recorded by the profiler, and server, database and collection statistics.
import * as vscode from 'vscode';
import { BSON, Db, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type {
  CollectionStats,
  DatabaseStats,
  MonitorHostMessage,
  MonitorOp,
  MonitorViewMessage,
  ProfileEntry,
  ServerStats,
} from './shared/messages';
import { relaxEjson, toShell } from './shared/query';
import { errorMessage } from './tree';

const { EJSON } = BSON;

const PROFILE_LIMIT = 200;
/** Databases and collections whose statistics are read in parallel. */
const PARALLEL = 8;
/** Command fields that only add noise to a one-line summary. */
const NOISE = new Set(['lsid', '$clusterTime', '$db', '$readPreference', 'txnNumber', 'autocommit', 'startTransaction', 'readConcern', 'writeConcern', 'apiVersion', '$audit', '$client', 'mayBypassWriteBlocking']);

const relaxed = (v: unknown) => relaxEjson(EJSON.serialize(v, { relaxed: false }));

/** The command of an operation or profiler entry on one line, without session noise. */
function summarize(command: unknown, max = 300): string {
  if (!command || typeof command !== 'object') return '';
  const clean = Object.fromEntries(Object.entries(command as Document).filter(([k]) => !NOISE.has(k)));
  const text = toShell(relaxed(clean));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

export class MonitorPanel {
  private static readonly panels = new Map<string, MonitorPanel>();
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, info: ConnectionInfo): void {
    const existing = MonitorPanel.panels.get(info.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    MonitorPanel.panels.set(info.id, new MonitorPanel(context, connections, info));
  }

  /** Name, color and read-only changes apply to the open monitor. */
  static connectionChanged(info: ConnectionInfo): void {
    const p = MonitorPanel.panels.get(info.id);
    if (!p) return;
    p.info = info;
    p.panel.title = `Monitor: ${info.name}`;
    void p.postInit();
  }

  static close(connectionId: string): void {
    MonitorPanel.panels.get(connectionId)?.panel.dispose();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private info: ConnectionInfo,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.monitor',
      `Monitor: ${info.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => MonitorPanel.panels.delete(info.id));
    this.panel.webview.onDidReceiveMessage((m: MonitorViewMessage) => void this.receive(m));
  }

  private post(m: MonitorHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private client(): Promise<MongoClient> {
    return this.connections.getClient(this.info.id);
  }

  private async postInit(): Promise<void> {
    let databases: string[] = [];
    try {
      databases = (await (await this.client()).db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).sort();
    } catch {
      // Shown by the individual sections.
    }
    this.post({ type: 'init', connectionName: this.info.name, readOnly: !!this.info.readOnly, color: this.info.color, databases });
  }

  private async receive(m: MonitorViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.postInit();
        break;
      case 'loadOps':
        await this.loadOps(m.requestId, m.includeIdle);
        break;
      case 'killOp':
        await this.killOp(m.opid, m.summary);
        break;
      case 'loadProfile':
        await this.loadProfile(m.requestId, m.database);
        break;
      case 'setProfile':
        await this.setProfile(m.requestId, m.database, m.level, m.slowms);
        break;
      case 'loadServer':
        await this.loadServer(m.requestId);
        break;
      case 'loadDatabases':
        await this.loadDatabases(m.requestId);
        break;
      case 'loadCollections':
        await this.loadCollections(m.requestId, m.database);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
    }
  }

  // ---- operations

  private async loadOps(requestId: number, includeIdle: boolean): Promise<void> {
    try {
      const admin = (await this.client()).db('admin');
      const res = await admin.command({ currentOp: 1, $all: includeIdle });
      const ops = ((res.inprog ?? []) as Document[])
        // The currentOp command that produced this list.
        .filter((op) => !(op.command && 'currentOp' in op.command))
        .map(toOp)
        .sort((a, b) => Number(b.active) - Number(a.active) || (b.micros ?? 0) - (a.micros ?? 0));
      this.post({ type: 'ops', requestId, ops, at: Date.now() });
    } catch (err) {
      this.post({ type: 'ops', requestId, error: errorMessage(err), at: Date.now() });
    }
  }

  private async killOp(opid: number | string, summary: string): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'killResult', opid, ok, message });
    if (this.info.readOnly) return reply(false, `The connection ${this.info.name} is read-only.`);
    const answer = await vscode.window.showWarningMessage(
      `Kill operation ${opid}?`,
      { modal: true, detail: `${summary}\n\nThe operation is interrupted and its client receives an error. Writes already done are not undone.` },
      'Kill',
    );
    if (answer !== 'Kill') return reply(false);
    try {
      await (await this.client()).db('admin').command({ killOp: 1, op: opid });
      reply(true, `Killed operation ${opid}.`);
    } catch (err) {
      reply(false, errorMessage(err));
    }
  }

  // ---- profiler

  private async loadProfile(requestId: number, database: string): Promise<void> {
    try {
      const db = (await this.client()).db(database);
      const status = await db.command({ profile: -1 });
      const docs = await db.collection('system.profile').find({}).sort({ ts: -1 }).limit(PROFILE_LIMIT).toArray();
      this.post({
        type: 'profile',
        requestId,
        database,
        level: status.was,
        slowms: status.slowms,
        entries: docs.map(toProfileEntry),
      });
    } catch (err) {
      this.post({ type: 'profile', requestId, database, error: errorMessage(err) });
    }
  }

  private async setProfile(requestId: number, database: string, level: 0 | 1 | 2, slowms: number): Promise<void> {
    if (this.info.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${this.info.name} is read-only: the profiler level can't be changed.`);
      return this.loadProfile(requestId, database);
    }
    try {
      await (await this.client()).db(database).command({ profile: level, slowms });
    } catch (err) {
      void vscode.window.showErrorMessage(`Profiler not changed: ${errorMessage(err)}`);
    }
    await this.loadProfile(requestId, database);
  }

  // ---- statistics

  private async loadServer(requestId: number): Promise<void> {
    try {
      const s = await (await this.client()).db('admin').command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0 });
      const n = (v: unknown) => Number(v ?? 0);
      const stats: ServerStats = {
        host: s.host,
        version: s.version,
        uptime: n(s.uptime),
        connections: { current: n(s.connections?.current), available: n(s.connections?.available), totalCreated: n(s.connections?.totalCreated) },
        opcounters: {
          insert: n(s.opcounters?.insert),
          query: n(s.opcounters?.query),
          update: n(s.opcounters?.update),
          delete: n(s.opcounters?.delete),
          getmore: n(s.opcounters?.getmore),
          command: n(s.opcounters?.command),
        },
        memory: s.mem ? { resident: n(s.mem.resident), virtual: n(s.mem.virtual) } : undefined,
        network: s.network ? { bytesIn: n(s.network.bytesIn), bytesOut: n(s.network.bytesOut), numRequests: n(s.network.numRequests) } : undefined,
        at: Date.now(),
      };
      this.post({ type: 'server', requestId, stats });
    } catch (err) {
      this.post({ type: 'server', requestId, error: errorMessage(err) });
    }
  }

  private async loadDatabases(requestId: number): Promise<void> {
    try {
      const client = await this.client();
      const names = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      const databases = await inBatches(names, async (name): Promise<DatabaseStats> => {
        try {
          const s = await client.db(name).command({ dbStats: 1 });
          const n = (v: unknown) => (v === undefined ? undefined : Number(v));
          return {
            name,
            collections: n(s.collections),
            views: n(s.views),
            objects: n(s.objects),
            dataSize: n(s.dataSize),
            storageSize: n(s.storageSize),
            indexes: n(s.indexes),
            indexSize: n(s.indexSize),
          };
        } catch (err) {
          return { name, error: errorMessage(err) };
        }
      });
      this.post({ type: 'databases', requestId, databases });
    } catch (err) {
      this.post({ type: 'databases', requestId, error: errorMessage(err) });
    }
  }

  private async loadCollections(requestId: number, database: string): Promise<void> {
    try {
      const db = (await this.client()).db(database);
      const infos = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c) => !c.name.startsWith('system.'));
      const collections = await inBatches(infos, (c) => collectionStats(db, c.name, c.type ?? 'collection'));
      this.post({ type: 'collections', requestId, database, collections: collections.sort((a, b) => (b.size ?? -1) - (a.size ?? -1)) });
    } catch (err) {
      this.post({ type: 'collections', requestId, database, error: errorMessage(err) });
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
  <title>Monitor</title>
</head>
<body>
  <header class="bar">
    <span id="title" class="title"></span>
    <div class="tabs" role="tablist">
      <button id="tabOps" role="tab" aria-selected="true">Operations</button>
      <button id="tabProfile" role="tab" aria-selected="false">Slow queries</button>
      <button id="tabStats" role="tab" aria-selected="false">Stats</button>
    </div>
    <div class="spacer"></div>
    <label class="auto" title="Refresh the current tab periodically">Auto
      <select id="auto">
        <option value="0">off</option>
        <option value="2">2 s</option>
        <option value="5" selected>5 s</option>
        <option value="15">15 s</option>
      </select>
    </label>
    <button id="refresh" class="secondary" title="Refresh now">Refresh</button>
  </header>

  <section id="opsView" class="view">
    <div class="toolbar">
      <input id="opsFilter" type="search" placeholder="Filter by namespace, type, client or command" spellcheck="false">
      <label title="Only operations running at least this long">Running ≥ <input id="opsMin" type="number" min="0" step="0.1" value="0"> s</label>
      <label><input id="opsIdle" type="checkbox"> Idle connections</label>
      <label><input id="opsSystem" type="checkbox"> System operations</label>
      <span id="opsInfo" class="info"></span>
    </div>
    <div id="opsError" class="error hidden"></div>
    <div class="table-wrap"><table id="opsTable"></table></div>
  </section>

  <section id="profileView" class="view hidden">
    <div class="toolbar">
      <label>Database <select id="profileDb"></select></label>
      <span id="profileStatus" class="info"></span>
      <span class="spacer"></span>
      <span class="not-locked profile-set">
        Profile
        <select id="profileLevel" title="Profiler level of the database">
          <option value="0">off</option>
          <option value="1">slow operations</option>
          <option value="2">all operations</option>
        </select>
        slower than <input id="profileSlowms" type="number" min="0" step="1" value="100"> ms
        <button id="profileApply" class="secondary" title="Change the profiler of this database (a server setting)">Apply</button>
      </span>
    </div>
    <div id="profileError" class="error hidden"></div>
    <div class="table-wrap"><table id="profileTable"></table></div>
  </section>

  <section id="statsView" class="view hidden">
    <div id="serverError" class="error hidden"></div>
    <div id="serverCards" class="cards"></div>
    <h3>Databases</h3>
    <div id="dbError" class="error hidden"></div>
    <div class="table-wrap"><table id="dbTable" class="sortable"></table></div>
    <h3 id="collTitle" class="hidden"></h3>
    <div id="collError" class="error hidden"></div>
    <div class="table-wrap"><table id="collTable" class="sortable"></table></div>
  </section>
  <script nonce="${nonce}" src="${asset('dist', 'monitor.js')}"></script>
</body>
</html>`;
  }
}

function toOp(op: Document): MonitorOp {
  const micros = op.microsecs_running !== undefined ? Number(op.microsecs_running) : op.secs_running !== undefined ? Number(op.secs_running) * 1e6 : undefined;
  const command = op.command ?? op.query;
  const users = op.effectiveUsers as { user: string; db: string }[] | undefined;
  return {
    opid: typeof op.opid === 'object' ? Number(op.opid) : op.opid,
    type: op.op ?? op.type ?? '',
    ns: op.ns ?? '',
    micros,
    active: !!op.active,
    client: op.client ?? op.client_s,
    appName: op.appName,
    desc: op.desc,
    user: users?.map((u) => `${u.user}@${u.db}`).join(', ') || undefined,
    plan: op.planSummary,
    waitingForLock: op.waitingForLock || undefined,
    system: !op.client && !op.client_s,
    summary: summarize(command) || op.msg || '',
    raw: relaxed(op),
  };
}

function toProfileEntry(doc: Document): ProfileEntry {
  const users = doc.allUsers as { user: string; db: string }[] | undefined;
  const num = (v: unknown) => (v === undefined ? undefined : Number(v));
  return {
    ts: doc.ts instanceof Date ? doc.ts.toISOString() : String(doc.ts),
    op: doc.op ?? '',
    ns: doc.ns ?? '',
    millis: Number(doc.millis ?? 0),
    docsExamined: num(doc.docsExamined),
    keysExamined: num(doc.keysExamined),
    nreturned: num(doc.nreturned),
    plan: doc.planSummary,
    user: users?.map((u) => `${u.user}@${u.db}`).join(', ') || undefined,
    summary: summarize(doc.command ?? doc.query ?? doc.updateobj),
    raw: relaxed(doc),
  };
}

async function collectionStats(db: Db, name: string, type: string): Promise<CollectionStats> {
  if (type === 'view') return { name, type };
  try {
    const [s] = await db
      .collection(name)
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray();
    const st = (s?.storageStats ?? {}) as Document;
    const n = (v: unknown) => (v === undefined ? undefined : Number(v));
    return {
      name,
      type,
      count: n(st.count),
      size: n(st.size),
      avgObjSize: n(st.avgObjSize),
      storageSize: n(st.storageSize),
      nindexes: n(st.nindexes),
      totalIndexSize: n(st.totalIndexSize),
      capped: st.capped || undefined,
    };
  } catch (err) {
    return { name, type, error: errorMessage(err) };
  }
}
