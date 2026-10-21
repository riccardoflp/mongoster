// Server monitor: one tab per connection with the running operations (currentOp, killOp), the slow
// queries recorded by the profiler or logged by the server, server, database and collection statistics,
// and the replica set's members and oplog.
import * as vscode from 'vscode';
import { ThemeColors } from './themeColors';
import { BSON, Db, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type {
  CollectionStats,
  DatabaseStats,
  MonitorHostMessage,
  MonitorOp,
  MonitorViewMessage,
  OplogOp,
  ReplStatus,
  ServerStats,
} from './shared/messages';
import { relaxEjson, toShell } from './shared/query';
import { OpQuery, SlowOp, SlowOpSource, fromLogLine, fromProfileDoc, isNoise, splitNs } from './shared/profile';
import { helloMembers, oplogEntry, oplogFilter, replMembers } from './replication';
import { errorMessage } from './tree';

const { EJSON } = BSON;

/** Longest scan of the oplog for its most recent entries matching a filter. */
const OPLOG_MAX_TIME_MS = 10_000;
/** Profiler documents read: the most recent ones. */
const PROFILE_LIMIT = 1000;
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
    ThemeColors.attach(this.panel);
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
        await this.loadProfile(m.requestId, m.source, m.database, m.sinceMinutes);
        break;
      case 'clearProfile':
        await this.clearProfile(m.database);
        break;
      case 'openQuery':
        await openOperation(this.info.id, m.ns, m.kind, m.query, m.explain);
        break;
      case 'createIndex':
        await this.createIndex(m.ns, m.keys);
        break;
      case 'setProfile':
        await this.setProfile(m.database, m.level, m.slowms);
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
      case 'loadReplication':
        await this.loadReplication(m.requestId);
        break;
      case 'loadOplog':
        await this.loadOplog(m.requestId, m.ns, m.op, m.limit);
        break;
      case 'stepDown':
        await this.stepDown();
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

  /**
   * Slow operations of the last `sinceMinutes` (0: all): from system.profile of `database`, or from the
   * server log (its last 1024 lines, every database, narrowed to `database` when given).
   */
  private async loadProfile(requestId: number, source: SlowOpSource, database: string, sinceMinutes: number): Promise<void> {
    const since = sinceMinutes ? new Date(Date.now() - sinceMinutes * 60_000) : undefined;
    try {
      const client = await this.client();
      // The threshold (slowms) is the server's; the level is the database's.
      const status = await client.db(database || 'admin').command({ profile: -1 });
      let entries: SlowOp[];
      let limited = false;
      if (source === 'profiler') {
        const docs = await client
          .db(database)
          .collection('system.profile')
          .find(since ? { ts: { $gte: since } } : {})
          .sort({ ts: -1 })
          .limit(PROFILE_LIMIT + 1)
          .toArray();
        limited = docs.length > PROFILE_LIMIT;
        entries = docs.slice(0, PROFILE_LIMIT).map((d) => fromProfileDoc(relaxed(d) as Record<string, unknown>));
      } else {
        const res = await client.db('admin').command({ getLog: 'global' });
        const lines = (res.log ?? []) as string[];
        limited = Number(res.totalLinesWritten ?? 0) > lines.length;
        entries = lines
          .map(fromLogLine)
          .filter((e): e is SlowOp => !!e && (!database || splitNs(e.ns).database === database) && (!since || new Date(e.ts) >= since))
          .reverse();
      }
      this.post({
        type: 'profile',
        requestId,
        source,
        database,
        level: source === 'profiler' ? status.was : undefined,
        slowms: status.slowms,
        entries: entries.filter((e) => !isNoise(e)),
        limited,
      });
    } catch (err) {
      this.post({ type: 'profile', requestId, source, database, error: errorMessage(err) });
    }
  }

  private async setProfile(database: string, level: -1 | 0 | 1 | 2, slowms: number): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'profileAction', ok, message });
    if (this.info.readOnly) return reply(false, `The connection ${this.info.name} is read-only: the profiler can't be changed.`);
    try {
      await (await this.client()).db(database || 'admin').command({ profile: level, slowms });
      reply(
        true,
        level === -1
          ? `Operations slower than ${slowms} ms are now logged.`
          : level === 0
            ? `The profiler of ${database} is off.`
            : `The profiler of ${database} records ${level === 2 ? 'every operation' : `operations slower than ${slowms} ms`}.`,
      );
    } catch (err) {
      reply(false, `Profiler not changed: ${errorMessage(err)}`);
    }
  }

  /** Drops system.profile: the profiler must be off meanwhile, then it is set back as it was. */
  private async clearProfile(database: string): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'profileAction', ok, message });
    if (this.info.readOnly) return reply(false, `The connection ${this.info.name} is read-only.`);
    const answer = await vscode.window.showWarningMessage(
      `Clear the operations recorded by the profiler of ${database}?`,
      { modal: true, detail: 'The system.profile collection is emptied; the profiler keeps recording with the same settings.' },
      'Clear',
    );
    if (answer !== 'Clear') return reply(false);
    try {
      const db = (await this.client()).db(database);
      const status = await db.command({ profile: -1 });
      if (status.was) await db.command({ profile: 0 });
      try {
        await db.collection('system.profile').drop();
      } catch (err) {
        if (!/ns not found/i.test(errorMessage(err))) throw err;
      } finally {
        if (status.was) await db.command({ profile: status.was, slowms: status.slowms });
      }
      reply(true, `Cleared the profiler of ${database}.`);
    } catch (err) {
      reply(false, errorMessage(err));
    }
  }

  private async createIndex(ns: string, keys: Record<string, 1 | -1>): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'profileAction', ok, message });
    if (this.info.readOnly) return reply(false, `The connection ${this.info.name} is read-only.`);
    const { database, collection } = splitNs(ns);
    try {
      const coll = (await this.client()).db(database).collection(collection);
      const same = (await coll.listIndexes().toArray()).find((ix) => JSON.stringify(ix.key) === JSON.stringify(keys));
      if (same) return reply(false, `${ns} already has the index ${same.name} on ${toShell(keys)}.`);
      const answer = await vscode.window.showWarningMessage(
        `Create the index ${toShell(keys)} on ${ns}?`,
        {
          modal: true,
          detail: 'Building an index reads the whole collection: on a large collection it takes time and loads the server. Every write then also updates the index.',
        },
        'Create Index',
      );
      if (answer !== 'Create Index') return reply(false);
      const name = await coll.createIndex(keys);
      reply(true, `Created the index ${name} on ${ns}.`);
    } catch (err) {
      reply(false, `Index not created: ${errorMessage(err)}`);
    }
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

  // ---- replication

  private async loadReplication(requestId: number): Promise<void> {
    try {
      const client = await this.client();
      const admin = client.db('admin');
      const hello = await admin.command({ hello: 1 });
      const status: ReplStatus = { kind: 'replicaSet', setName: hello.setName, me: hello.me, primary: hello.primary, at: Date.now() };
      if (hello.msg === 'isdbgrid') status.kind = 'mongos';
      else if (!hello.setName) status.kind = 'standalone';
      if (status.kind !== 'replicaSet') return this.post({ type: 'replication', requestId, status });

      const [st, conf] = await Promise.allSettled([admin.command({ replSetGetStatus: 1 }), admin.command({ replSetGetConfig: 1 })]);
      if (st.status === 'fulfilled') {
        const config = conf.status === 'fulfilled' ? (conf.value.config as Document) : undefined;
        status.members = replMembers(relaxed(st.value.members) as unknown[], (relaxed(config?.members ?? []) as unknown[]) ?? []);
        status.term = st.value.term === undefined ? undefined : Number(st.value.term);
        const settings = (config?.settings ?? {}) as Document;
        const n = (v: unknown) => (v === undefined ? undefined : Number(v));
        status.settings = {
          electionTimeoutMillis: n(settings.electionTimeoutMillis),
          heartbeatIntervalMillis: n(settings.heartbeatIntervalMillis),
          chainingAllowed: settings.chainingAllowed,
          protocolVersion: n(config?.protocolVersion),
        };
      } else {
        status.statusError = errorMessage(st.reason);
        status.members = helloMembers(hello);
      }

      try {
        const oplog = client.db('local').collection('oplog.rs');
        const [stats] = await oplog.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
        const storage = (stats?.storageStats ?? {}) as Document;
        const [first] = await oplog.find({}, { sort: { $natural: 1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray();
        const [last] = await oplog.find({}, { sort: { $natural: -1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray();
        const [from, to] = [first, last].map((e) => (e ? oplogEntry(relaxed(e) as Record<string, unknown>) : undefined));
        const seconds = (e: typeof from) => Number(e?.key.split(':')[0]);
        const n = (v: unknown) => (v === undefined ? undefined : Number(v));
        status.oplog = { size: n(storage.size), maxSize: n(storage.maxSize), count: n(storage.count), first: from?.time, last: to?.time };
        if (from && to) status.oplog.window = Math.max(0, seconds(to) - seconds(from));
      } catch (err) {
        status.oplogError = errorMessage(err);
      }
      this.post({ type: 'replication', requestId, status });
    } catch (err) {
      this.post({ type: 'replication', requestId, error: errorMessage(err) });
    }
  }

  /** The most recent oplog entries, newest first. */
  private async loadOplog(requestId: number, ns: string, op: OplogOp, limit: number): Promise<void> {
    try {
      const docs = await (await this.client())
        .db('local')
        .collection('oplog.rs')
        .find(oplogFilter(ns, op), { sort: { $natural: -1 }, limit: limit + 1, maxTimeMS: OPLOG_MAX_TIME_MS })
        .toArray();
      const entries = docs.slice(0, limit).map((d) => oplogEntry(relaxed(d) as Record<string, unknown>));
      this.post({ type: 'oplog', requestId, entries, limited: docs.length > limit });
    } catch (err) {
      const message = errorMessage(err);
      this.post({
        type: 'oplog',
        requestId,
        error: /MaxTimeMSExpired|time limit/i.test(message) ? `Few entries match and the oplog is long: reading it took more than ${OPLOG_MAX_TIME_MS / 1000} s. ${message}` : message,
      });
    }
  }

  private async stepDown(): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'replAction', ok, message });
    if (this.info.readOnly) return reply(false, `The connection ${this.info.name} is read-only.`);
    try {
      const admin = (await this.client()).db('admin');
      const hello = await admin.command({ hello: 1 });
      if (!hello.setName || !hello.primary) return reply(false, 'There is no primary to step down.');
      const answer = await vscode.window.showWarningMessage(
        `Step down the primary ${hello.primary} of ${hello.setName}?`,
        {
          modal: true,
          detail: 'The members elect a new primary: writes fail until then (usually a few seconds). The current primary can not be elected again for 60 seconds.',
        },
        'Step Down',
      );
      if (answer !== 'Step Down') return reply(false);
      await admin.command({ replSetStepDown: 60, secondaryCatchUpPeriodSecs: 10 });
      reply(true, `${hello.primary} stepped down: a new primary is being elected.`);
    } catch (err) {
      reply(false, errorMessage(err));
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
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Monitor</title>
</head>
<body${ThemeColors.bodyAttribute()}>
  <header class="bar">
    <span id="title" class="title"></span>
    <div class="tabs" role="tablist">
      <button id="tabOps" role="tab" aria-selected="true">Operations</button>
      <button id="tabProfile" role="tab" aria-selected="false">Slow queries</button>
      <button id="tabStats" role="tab" aria-selected="false">Stats</button>
      <button id="tabRepl" role="tab" aria-selected="false">Replication</button>
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
      <label title="Profiler: the operations recorded in system.profile of a database. Server log: the slow operations of every database in the server's recent log, without turning the profiler on.">Source
        <select id="profileSource">
          <option value="profiler">Profiler</option>
          <option value="log">Server log</option>
        </select>
      </label>
      <label>Database <select id="profileDb"></select></label>
      <label>Since
        <select id="profileSince">
          <option value="15">15 minutes</option>
          <option value="60">1 hour</option>
          <option value="1440">24 hours</option>
          <option value="0">all</option>
        </select>
      </label>
      <div class="tabs" role="tablist" aria-label="Show">
        <button id="profileGrouped" role="tab" title="One row per query shape (the query with its values replaced by ?), with totals">By query</button>
        <button id="profileAll" role="tab" title="Every operation, the most recent first">All</button>
      </div>
      <input id="profileFilter" type="search" placeholder="Filter by namespace, operation, plan or query" spellcheck="false">
    </div>
    <div class="toolbar">
      <span id="profileStatus" class="info"></span>
      <span class="spacer"></span>
      <span class="not-locked profile-set profiler-only">
        Profile
        <select id="profileLevel" title="Profiler level of the database">
          <option value="0">off</option>
          <option value="1">slow operations</option>
          <option value="2">all operations</option>
        </select>
        slower than <input id="profileSlowms" type="number" min="0" step="1" value="100"> ms
        <button id="profileApply" class="secondary" title="Change the profiler of this database (a server setting)">Apply</button>
        <button id="profileClear" class="secondary" title="Empty system.profile of this database">Clear</button>
      </span>
      <span class="not-locked profile-set log-only">
        Log operations slower than <input id="logSlowms" type="number" min="0" step="1" value="100"> ms
        <button id="logApply" class="secondary" title="Change the threshold of slow operations (slowms, a server setting)">Apply</button>
      </span>
    </div>
    <div id="profileError" class="error hidden"></div>
    <div id="profileMessage" class="message hidden"></div>
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
  <section id="replView" class="view hidden">
    <div id="replError" class="error hidden"></div>
    <div id="replMessage" class="message hidden"></div>
    <div id="replCards" class="cards"></div>
    <div id="replMembers" class="hidden">
      <div class="toolbar">
        <h3 class="inline">Members</h3>
        <span id="replInfo" class="info"></span>
        <span class="spacer"></span>
        <button id="stepDown" class="secondary not-locked" title="Make the primary step down so that the members elect another one (replSetStepDown), e.g. to try a failover">Step Down…</button>
      </div>
      <div class="table-wrap"><table id="memberTable"></table></div>
    </div>
    <div id="oplogSection" class="hidden">
      <div class="toolbar">
        <h3 class="inline">Oplog</h3>
        <input id="oplogNs" type="search" placeholder="Database or collection (shop, shop.users)" spellcheck="false">
        <label>Operation
          <select id="oplogOp">
            <option value="">all but no-ops</option>
            <option value="i">insert</option>
            <option value="u">update</option>
            <option value="d">delete</option>
            <option value="c">command / transaction</option>
            <option value="n">no-op</option>
            <option value="*">everything</option>
          </select>
        </label>
        <label>Last
          <select id="oplogLimit">
            <option value="50">50</option>
            <option value="200">200</option>
            <option value="1000">1,000</option>
          </select>
        </label>
        <span id="oplogInfo" class="info"></span>
      </div>
      <div id="oplogError" class="error hidden"></div>
      <div class="table-wrap"><table id="oplogTable"></table></div>
    </div>
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

/** Shows the query in the collection's tab (filter, sort and projection, or the pipeline). */
export async function openOperation(connectionId: string, ns: string, kind: string, query: OpQuery, explain: boolean): Promise<void> {
  const { database, collection } = splitNs(ns);
  const text = (v: unknown) => (v === undefined ? '' : toShell(v));
  await vscode.commands.executeCommand('mongoster.openQuery', {
    connectionId,
    database,
    collection,
    query:
      kind === 'aggregate'
        ? { filter: '', sort: '', projection: '', pipeline: (query.pipeline ?? []).map((stage) => ({ op: Object.keys(stage)[0], body: toShell(Object.values(stage)[0]), enabled: true })) }
        : { filter: text(query.filter), sort: text(query.sort), projection: kind === 'find' ? text(query.projection) : '' },
    explain,
  });
}
