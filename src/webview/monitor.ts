// Server monitor tab: running operations, profiler entries, statistics, replication and sharding, refreshed on demand or periodically.
import './tokenColors';
import type {
  CollectionStats,
  DatabaseStats,
  MonitorHostMessage,
  MonitorOp,
  MonitorViewMessage,
  OplogEntry,
  OplogOp,
  ReplMember,
  ReplStatus,
  ServerStats,
  ShardedCollectionInfo,
  ShardingEvent,
  ShardingStatus,
} from '../shared/messages';
import { prettyShell, toShell } from '../shared/query';
import { SlowOp, SlowOpGroup, SlowOpSource, canOpen, groupOps, splitNs } from '../shared/profile';

type Tab = 'ops' | 'profile' | 'stats' | 'repl' | 'shard';

interface State {
  tab: Tab;
  auto: number;
  filter: string;
  minSeconds: number;
  idle: boolean;
  system: boolean;
  profileDb?: string;
  /** Database the server log is narrowed to ('' for all). */
  logDb?: string;
  profileSource: SlowOpSource;
  /** Minutes, 0 for everything recorded. */
  profileSince: number;
  profileView: 'grouped' | 'all';
  profileFilter: string;
  profileSort?: SortState;
  statsDb?: string;
  dbSort?: SortState;
  collSort?: SortState;
  oplogNs: string;
  oplogOp: OplogOp;
  oplogLimit: number;
  shardCollFilter: string;
  shardCollSort?: SortState;
  shardEventsNs: string;
  shardEventsScope: 'balancer' | 'all';
}

interface SortState {
  key: string;
  desc: boolean;
}

declare function acquireVsCodeApi(): {
  postMessage(message: MonitorViewMessage): void;
  getState(): Partial<State> | undefined;
  setState(state: State): void;
};

const vscode = acquireVsCodeApi();
const state: State = {
  tab: 'ops',
  auto: 5,
  filter: '',
  minSeconds: 0,
  idle: false,
  system: false,
  profileSource: 'profiler',
  profileSince: 60,
  profileView: 'grouped',
  profileFilter: '',
  oplogNs: '',
  oplogOp: '',
  oplogLimit: 50,
  shardCollFilter: '',
  shardEventsNs: '',
  shardEventsScope: 'balancer',
  ...vscode.getState(),
};
const save = () => vscode.setState(state);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let readOnly = false;
let databases: string[] = [];
let ops: MonitorOp[] = [];
let profile: SlowOp[] = [];
let profileInfo: { level?: number; slowms?: number; limited?: boolean } = {};
let dbStats: DatabaseStats[] = [];
let collStats: CollectionStats[] = [];
/** Previous server sample, for rates. */
let lastServer: ServerStats | undefined;
let server: ServerStats | undefined;
let repl: ReplStatus | undefined;
let oplog: OplogEntry[] = [];
let oplogLimited = false;
const expandedMembers = new Set<string>();
const expandedOplog = new Set<string>();
const expandedOps = new Set<string>();
const expandedProfile = new Set<string>();
const killing = new Set<string>();
let sharding: ShardingStatus | undefined;
/** Whether the pending sharding request reads the per-collection values too. */
let shardingFull = true;
let shardEvents: ShardingEvent[] = [];
const expandedShards = new Set<string>();
const expandedShardColls = new Set<string>();
const expandedEvents = new Set<string>();
/** Recent sharding events shown. */
const SHARD_EVENTS = 100;
let requestId = 0;
const latest: Record<string, number> = {};
let timer: ReturnType<typeof setInterval> | undefined;

function request(kind: string): number {
  latest[kind] = ++requestId;
  return requestId;
}

// ---------------------------------------------------------------------------
// Formatting

function duration(micros: number | undefined): string {
  if (micros === undefined) return '';
  const ms = micros / 1000;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function bytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

const count = (n: number | undefined) => (n === undefined ? '' : n.toLocaleString('en-US'));

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

function cell(row: HTMLTableRowElement, text: string, className = '', title?: string): HTMLTableCellElement {
  const c = row.insertCell();
  c.textContent = text;
  if (className) c.className = className;
  if (title) c.title = title;
  return c;
}

function header(table: HTMLTableElement, labels: string[]): void {
  const row = table.createTHead().insertRow();
  for (const label of labels) {
    const th = document.createElement('th');
    th.textContent = label;
    row.append(th);
  }
}

function detailRow(table: HTMLTableElement, colspan: number, raw: unknown): void {
  const row = table.tBodies[0].insertRow();
  row.className = 'detail';
  const c = row.insertCell();
  c.colSpan = colspan;
  const pre = document.createElement('pre');
  pre.textContent = prettyShell(raw, 0, 110);
  const copy = document.createElement('button');
  copy.className = 'secondary small';
  copy.textContent = 'Copy';
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'copy', text: pre.textContent ?? '' });
  });
  c.append(copy, pre);
}

function showError(id: string, error: string | undefined): void {
  el(id).textContent = error ?? '';
  el(id).classList.toggle('hidden', !error);
}

// ---------------------------------------------------------------------------
// Tabs and refreshing

function setTab(tab: Tab): void {
  state.tab = tab;
  save();
  for (const [t, view, button] of [
    ['ops', 'opsView', 'tabOps'],
    ['profile', 'profileView', 'tabProfile'],
    ['stats', 'statsView', 'tabStats'],
    ['repl', 'replView', 'tabRepl'],
    ['shard', 'shardView', 'tabShard'],
  ] as const) {
    el(view).classList.toggle('hidden', t !== tab);
    el(button).setAttribute('aria-selected', String(t === tab));
  }
  refresh(true);
}

/** Reloads the current tab; `full` also reloads the slower parts (database and collection statistics). */
function refresh(full: boolean): void {
  if (state.tab === 'ops') vscode.postMessage({ type: 'loadOps', requestId: request('ops'), includeIdle: state.idle });
  else if (state.tab === 'profile') profileRequest();
  else if (state.tab === 'repl') {
    vscode.postMessage({ type: 'loadReplication', requestId: request('repl') });
    oplogRequest();
  } else if (state.tab === 'shard') {
    shardingRequest(full);
    shardEventsRequest();
  } else {
    vscode.postMessage({ type: 'loadServer', requestId: request('server') });
    if (full) {
      vscode.postMessage({ type: 'loadDatabases', requestId: request('databases') });
      if (state.statsDb) vscode.postMessage({ type: 'loadCollections', requestId: request('collections'), database: state.statsDb });
    }
  }
}

function setAuto(seconds: number): void {
  state.auto = seconds;
  save();
  if (timer) clearInterval(timer);
  timer = seconds
    ? setInterval(() => {
        if (document.visibilityState === 'visible') refresh(false);
      }, seconds * 1000)
    : undefined;
}

// ---------------------------------------------------------------------------
// Operations

function renderOps(): void {
  const table = el<HTMLTableElement>('opsTable');
  table.replaceChildren();
  const needle = state.filter.trim().toLowerCase();
  const shown = ops.filter(
    (op) =>
      (state.system || !op.system) &&
      (op.micros ?? 0) >= state.minSeconds * 1e6 &&
      (!needle || [op.ns, op.type, op.client, op.appName, op.desc, op.summary, op.user, String(op.opid)].some((v) => v?.toLowerCase().includes(needle))),
  );
  el('opsInfo').textContent = `${shown.length} of ${ops.length} operation${ops.length === 1 ? '' : 's'} · ${new Date().toLocaleTimeString()}`;
  if (!shown.length) {
    const p = table.createTBody().insertRow().insertCell();
    p.className = 'empty';
    p.textContent = ops.length ? 'No operation matches the filters.' : 'No operations running.';
    return;
  }
  header(table, ['', 'opid', 'type', 'namespace', 'running', 'client', 'plan', 'command']);
  const body = table.createTBody();
  for (const op of shown) {
    const id = String(op.opid);
    const row = body.insertRow();
    row.className = 'op';
    row.classList.toggle('idle', !op.active);
    row.classList.toggle('expanded', expandedOps.has(id));
    const action = row.insertCell();
    action.className = 'action';
    if (!readOnly && op.opid !== undefined) {
      const kill = document.createElement('button');
      kill.className = 'kill small';
      kill.textContent = killing.has(id) ? '…' : 'Kill';
      kill.disabled = killing.has(id);
      kill.title = `Kill operation ${id} (killOp)`;
      kill.addEventListener('click', (e) => {
        e.stopPropagation();
        killing.add(id);
        renderOps();
        vscode.postMessage({ type: 'killOp', opid: op.opid, summary: `${op.type} ${op.ns} — running ${duration(op.micros)}\n${op.summary}` });
      });
      action.append(kill);
    }
    cell(row, id, 'num');
    cell(row, op.type + (op.waitingForLock ? ' 🔒' : ''), '', op.waitingForLock ? 'Waiting for a lock' : op.desc);
    cell(row, op.ns);
    const secs = (op.micros ?? 0) / 1e6;
    cell(row, op.active ? duration(op.micros) : 'idle', `num ${secs >= 30 ? 'very-slow' : secs >= 5 ? 'slow' : ''}`);
    cell(row, [op.appName, op.client].filter(Boolean).join(' · ') || (op.system ? op.desc ?? 'system' : ''), '', op.user);
    cell(row, op.plan ?? '', op.plan?.startsWith('COLLSCAN') ? 'collscan' : '');
    cell(row, op.summary, 'command', op.summary);
    row.addEventListener('click', () => {
      if (expandedOps.has(id)) expandedOps.delete(id);
      else expandedOps.add(id);
      renderOps();
    });
    if (expandedOps.has(id)) detailRow(table, 8, op.raw);
  }
}

// ---------------------------------------------------------------------------
// Profiler

function profileRequest(): void {
  const database = state.profileSource === 'log' ? state.logDb ?? '' : state.profileDb;
  if (database === undefined) return;
  vscode.postMessage({ type: 'loadProfile', requestId: request('profile'), source: state.profileSource, database, sinceMinutes: state.profileSince });
}

/** The database list of the source: the log can also show every database. */
function fillProfileDbs(): void {
  const select = el<HTMLSelectElement>('profileDb');
  const log = state.profileSource === 'log';
  select.replaceChildren(...(log ? [new Option('all databases', '')] : []), ...databases.map((d) => new Option(d, d)));
  select.value = (log ? state.logDb : state.profileDb) ?? '';
  document.body.classList.toggle('source-log', log);
  el<HTMLSelectElement>('profileSource').value = state.profileSource;
}

const SINCE: Record<number, string> = { 15: 'in the last 15 minutes', 60: 'in the last hour', 1440: 'in the last 24 hours', 0: '' };

function matches(op: SlowOp, needle: string): boolean {
  return !needle || [op.ns, op.kind, op.plan, op.shape, op.summary, op.app].some((v) => v?.toLowerCase().includes(needle));
}

function renderProfile(): void {
  const table = el<HTMLTableElement>('profileTable');
  table.replaceChildren();
  const { level, slowms, limited } = profileInfo;
  const log = state.profileSource === 'log';
  if (slowms !== undefined) {
    el<HTMLInputElement>('profileSlowms').value = String(slowms);
    el<HTMLInputElement>('logSlowms').value = String(slowms);
  }
  if (level !== undefined) el<HTMLSelectElement>('profileLevel').value = String(level);
  el('profileGrouped').setAttribute('aria-selected', String(state.profileView === 'grouped'));
  el('profileAll').setAttribute('aria-selected', String(state.profileView === 'all'));

  const needle = state.profileFilter.trim().toLowerCase();
  const shown = profile.filter((op) => matches(op, needle));
  const groups = groupOps(shown);
  const recording = log
    ? `The server logs the operations slower than ${slowms ?? '?'} ms`
    : level === 0
      ? 'Profiler off'
      : level === 1
        ? `Recording operations slower than ${slowms} ms`
        : 'Recording all operations';
  const found = `${count(shown.length)} operation${shown.length === 1 ? '' : 's'}${state.profileView === 'grouped' ? ` · ${count(groups.length)} quer${groups.length === 1 ? 'y' : 'ies'}` : ''}`;
  const more = limited ? (log ? ' · older lines are no longer in the log' : ` · the latest ${count(profile.length)}`) : '';
  el('profileStatus').textContent = `${recording} · ${found}${more}`;

  if (!shown.length) {
    const p = table.createTBody().insertRow().insertCell();
    p.className = 'empty';
    const since = SINCE[state.profileSince] ?? '';
    p.textContent = profile.length
      ? 'No operation matches the filter.'
      : log
        ? `No operations slower than ${slowms} ms in the server log${since ? ` ${since}` : ''}. Lower the threshold to log more of them.`
        : level === 0
          ? 'The profiler of this database is off: choose "slow operations" and Apply to record the operations slower than the threshold, or look at the server log.'
          : `No operations recorded${since ? ` ${since}` : ''}.`;
    return;
  }
  if (state.profileView === 'grouped') renderGroups(table, groups);
  else renderOperations(table, shown);
}

type GroupSortKey = 'count' | 'totalMs' | 'avgMs' | 'maxMs' | 'scanned' | 'last';

function renderGroups(table: HTMLTableElement, groups: SlowOpGroup[]): void {
  const sort = state.profileSort ?? { key: 'totalMs', desc: true };
  const value = (g: SlowOpGroup, key: GroupSortKey): number | string =>
    key === 'scanned' ? g.docsExamined / Math.max(g.nreturned, 1) : key === 'last' ? g.last : g[key];
  groups.sort((a, b) => {
    const x = value(a, sort.key as GroupSortKey);
    const y = value(b, sort.key as GroupSortKey);
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sort.desc ? -cmp : cmp;
  });
  const head = table.createTHead().insertRow();
  const columns: [string, GroupSortKey | null, string][] = [
    ['count', 'count', 'Times the query ran (getMore batches included)'],
    ['total ms', 'totalMs', 'Time spent in all the executions'],
    ['avg ms', 'avgMs', ''],
    ['max ms', 'maxMs', ''],
    ['examined / returned', 'scanned', 'Documents examined and returned, in all the executions'],
    ['op', null, ''],
    ['namespace', null, ''],
    ['query', null, 'The query with its values replaced by ?'],
    ['plan', null, ''],
    ['last', 'last', ''],
  ];
  for (const [label, key, title] of columns) {
    const th = document.createElement('th');
    th.textContent = label + (key && sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : '');
    if (title) th.title = title;
    if (key) {
      th.className = 'sortable-th';
      th.addEventListener('click', () => {
        state.profileSort = { key, desc: sort.key === key ? !sort.desc : true };
        save();
        renderProfile();
      });
    }
    head.append(th);
  }
  const body = table.createTBody();
  for (const g of groups) {
    const row = body.insertRow();
    row.className = 'op';
    row.classList.toggle('expanded', expandedProfile.has(g.key));
    cell(row, count(g.count), 'num', g.getMores ? `${g.getMores} getMore batch${g.getMores === 1 ? '' : 'es'}` : undefined);
    cell(row, count(Math.round(g.totalMs)), `num ${slowness(g.maxMs)}`);
    cell(row, count(Math.round(g.avgMs)), 'num');
    cell(row, count(g.maxMs), `num ${slowness(g.maxMs)}`);
    const scanned = g.docsExamined / Math.max(g.nreturned, 1);
    cell(row, `${count(g.docsExamined)} / ${count(g.nreturned)}`, `num ${scanned >= 100 ? 'slow' : ''}`, scanned >= 10 ? `${count(Math.round(scanned))} documents examined per document returned` : undefined);
    cell(row, g.kind + (g.suggestion ? ' ⚑' : ''), '', g.suggestion ? 'An index could help: see the details' : undefined);
    cell(row, g.ns);
    cell(row, g.shape, 'command shape', g.shape);
    cell(row, g.plans.join(' · '), g.collscan ? 'collscan' : '');
    const last = new Date(g.last);
    cell(row, last.toLocaleTimeString(), 'num', last.toLocaleString());
    row.addEventListener('click', () => toggleProfile(g.key));
    if (expandedProfile.has(g.key)) profileDetail(table, columns.length, g.slowest, g);
  }
}

function renderOperations(table: HTMLTableElement, ops: SlowOp[]): void {
  header(table, ['time', 'op', 'namespace', 'ms', 'docs examined', 'keys examined', 'returned', 'plan', 'command']);
  const body = table.createTBody();
  for (const op of ops) {
    const id = `${op.ts}/${op.ns}/${op.millis}/${op.summary}`;
    const row = body.insertRow();
    row.className = 'op';
    row.classList.toggle('expanded', expandedProfile.has(id));
    const ts = new Date(op.ts);
    cell(row, ts.toLocaleTimeString(), 'num', ts.toLocaleString());
    cell(row, op.kind + (op.getMore ? ' (getMore)' : ''));
    cell(row, op.ns);
    cell(row, count(op.millis), `num ${slowness(op.millis)}`);
    const ratio = op.docsExamined && op.nreturned !== undefined ? op.docsExamined / Math.max(op.nreturned, 1) : 0;
    cell(row, count(op.docsExamined), `num ${ratio >= 100 ? 'slow' : ''}`, ratio >= 100 ? `${Math.round(ratio)} documents examined per document returned` : undefined);
    cell(row, count(op.keysExamined), 'num');
    cell(row, count(op.nreturned), 'num');
    cell(row, op.plan ?? '', op.plan?.includes('COLLSCAN') ? 'collscan' : '');
    cell(row, op.summary, 'command', op.summary);
    row.addEventListener('click', () => toggleProfile(id));
    if (expandedProfile.has(id)) profileDetail(table, 9, op);
  }
}

const slowness = (ms: number) => (ms >= 1000 ? 'very-slow' : ms >= 100 ? 'slow' : '');

function toggleProfile(id: string): void {
  if (expandedProfile.has(id)) expandedProfile.delete(id);
  else expandedProfile.add(id);
  renderProfile();
}

/** The query parts of an operation, to show and copy. */
function queryOf(op: SlowOp): unknown {
  if (op.kind === 'aggregate') return op.query.pipeline ?? [];
  return Object.fromEntries(Object.entries(op.query).filter(([, v]) => v !== undefined));
}

function button(label: string, title: string, onClick: () => void, className = 'secondary small'): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Details of an operation, or of a group with its slowest operation as the example. */
function profileDetail(table: HTMLTableElement, colspan: number, op: SlowOp, group?: SlowOpGroup): void {
  const row = table.tBodies[0].insertRow();
  row.className = 'detail';
  const cellOf = row.insertCell();
  cellOf.colSpan = colspan;
  // The table can be wider than the tab: the details stay in view.
  const c = document.createElement('div');
  c.className = 'detail-box';
  cellOf.append(c);
  const { collection } = splitNs(op.ns);
  const openable = canOpen(op.kind) && !!collection && !collection.startsWith('$cmd');

  if (group?.suggestion) {
    const box = document.createElement('div');
    box.className = 'suggestion';
    const scanned = group.docsExamined / Math.max(group.nreturned, 1);
    const why = group.collscan
      ? 'The plan scans the whole collection (COLLSCAN).'
      : group.sortStage
        ? 'The results are sorted in memory.'
        : `${count(Math.round(scanned))} documents are examined per document returned.`;
    const text = document.createElement('span');
    text.textContent = `${why} An index on ${toShell(group.suggestion)} (equality fields, then sort, then range) could serve this query.`;
    box.append(text);
    box.append(
      button('Create Index…', `Create ${toShell(group.suggestion)} on ${op.ns}`, () =>
        vscode.postMessage({ type: 'createIndex', ns: op.ns, keys: group.suggestion! }),
        'secondary small not-locked',
      ),
    );
    c.append(box);
  }

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  if (openable) {
    actions.append(
      button('Open in Collection', `Show the ${op.kind === 'aggregate' ? 'pipeline' : 'filter'} in the tab of ${op.ns}`, () =>
        vscode.postMessage({ type: 'openQuery', ns: op.ns, kind: op.kind, query: op.query, explain: false }),
      ),
      button('Explain', 'How the server runs this query now (indexes created since are taken into account)', () =>
        vscode.postMessage({ type: 'openQuery', ns: op.ns, kind: op.kind, query: op.query, explain: true }),
      ),
    );
  }
  actions.append(button('Copy Query', 'Copy the query (mongosh syntax)', () => vscode.postMessage({ type: 'copy', text: prettyShell(queryOf(op), 0, 110) })));
  if (group) {
    actions.append(
      button('Show Operations', 'Every execution of this query', () => {
        state.profileView = 'all';
        state.profileFilter = group.shape;
        el<HTMLInputElement>('profileFilter').value = group.shape;
        save();
        renderProfile();
      }),
    );
    const facts = document.createElement('span');
    facts.className = 'info';
    facts.textContent = [
      `example: the slowest, ${count(op.millis)} ms at ${new Date(op.ts).toLocaleString()}`,
      group.getMores ? `${count(group.getMores)} getMore batches` : '',
      group.apps.length ? `apps: ${group.apps.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    actions.append(facts);
  }
  c.append(actions);

  const pre = document.createElement('pre');
  pre.textContent = prettyShell(queryOf(op), 0, 110);
  c.append(pre);
  const raw = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = state.profileSource === 'log' ? 'Log entry' : 'Profiler document';
  const rawPre = document.createElement('pre');
  raw.addEventListener('toggle', () => {
    if (raw.open && !rawPre.textContent) rawPre.textContent = prettyShell(op.raw, 0, 110);
  });
  raw.append(summary, rawPre);
  c.append(raw);
}
// ---------------------------------------------------------------------------
// Statistics

function renderServer(): void {
  const cards = el('serverCards');
  cards.replaceChildren();
  const s = server;
  if (!s) return;
  const card = (label: string, value: string, sub?: string) => {
    const c = document.createElement('div');
    c.className = 'card';
    const l = document.createElement('div');
    l.className = 'card-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'card-value';
    v.textContent = value;
    c.append(l, v);
    if (sub) {
      const d = document.createElement('div');
      d.className = 'card-sub';
      d.textContent = sub;
      c.append(d);
    }
    cards.append(c);
  };
  card('Server', s.version, s.host);
  card('Uptime', uptime(s.uptime));
  card('Connections', count(s.connections.current), `${count(s.connections.available)} available · ${count(s.connections.totalCreated)} created`);
  const prev = lastServer;
  const dt = prev ? (s.at - prev.at) / 1000 : 0;
  if (prev && dt > 0) {
    const rate = (k: keyof ServerStats['opcounters']) => Math.max(0, (s.opcounters[k] - prev.opcounters[k]) / dt);
    const kinds = ['query', 'insert', 'update', 'delete', 'getmore', 'command'] as const;
    const total = kinds.reduce((a, k) => a + rate(k), 0);
    card('Operations / s', total.toFixed(total < 10 ? 1 : 0), kinds.map((k) => `${k} ${rate(k).toFixed(rate(k) < 10 ? 1 : 0)}`).join(' · '));
    if (s.network && prev.network) {
      card('Network / s', `↓ ${bytes((s.network.bytesIn - prev.network.bytesIn) / dt)}`, `↑ ${bytes((s.network.bytesOut - prev.network.bytesOut) / dt)}`);
    }
  } else {
    const o = s.opcounters;
    card('Operations', count(o.query + o.insert + o.update + o.delete + o.getmore + o.command), 'since start · rates after the next refresh');
  }
  if (s.memory) card('Memory', `${count(s.memory.resident)} MB`, `${count(s.memory.virtual)} MB virtual`);
}

interface Column<T> {
  key: keyof T & string;
  label: string;
  format?: (v: never) => string;
  num?: boolean;
}

function sortableTable<T>(
  table: HTMLTableElement,
  columns: Column<T>[],
  rows: T[],
  sort: SortState | undefined,
  onSort: (s: SortState) => void,
  onRow?: (row: T) => void,
  selected?: (row: T) => boolean,
): void {
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col.label + (sort?.key === col.key ? (sort.desc ? ' ▼' : ' ▲') : '');
    th.className = col.num ? 'num' : '';
    th.title = 'Sort';
    th.addEventListener('click', () => onSort({ key: col.key, desc: sort?.key === col.key ? !sort.desc : !!col.num }));
    head.append(th);
  }
  const sorted = [...rows];
  if (sort) {
    sorted.sort((a, b) => {
      const x = a[sort.key as keyof T] as unknown;
      const y = b[sort.key as keyof T] as unknown;
      const cmp = typeof x === 'number' || typeof y === 'number' ? Number(x ?? -1) - Number(y ?? -1) : String(x ?? '').localeCompare(String(y ?? ''));
      return sort.desc ? -cmp : cmp;
    });
  }
  const body = table.createTBody();
  for (const r of sorted) {
    const row = body.insertRow();
    if (onRow) {
      row.className = 'clickable';
      row.addEventListener('click', () => onRow(r));
    }
    if (selected?.(r)) row.classList.add('selected');
    for (const col of columns) {
      const v = r[col.key] as unknown;
      const text = col.format ? col.format(v as never) : v === undefined ? '' : String(v);
      cell(row, text, col.num ? 'num' : '');
    }
    const error = (r as { error?: string }).error;
    if (error) row.title = error;
  }
}

function renderDatabases(): void {
  sortableTable<DatabaseStats>(
    el('dbTable'),
    [
      { key: 'name', label: 'database' },
      { key: 'collections', label: 'collections', num: true, format: count },
      { key: 'views', label: 'views', num: true, format: count },
      { key: 'objects', label: 'documents', num: true, format: count },
      { key: 'dataSize', label: 'data', num: true, format: bytes },
      { key: 'storageSize', label: 'storage', num: true, format: bytes },
      { key: 'indexes', label: 'indexes', num: true, format: count },
      { key: 'indexSize', label: 'index size', num: true, format: bytes },
    ],
    dbStats,
    state.dbSort,
    (s) => {
      state.dbSort = s;
      save();
      renderDatabases();
    },
    (db) => {
      state.statsDb = db.name;
      save();
      collStats = [];
      renderDatabases();
      renderCollections();
      vscode.postMessage({ type: 'loadCollections', requestId: request('collections'), database: db.name });
    },
    (db) => db.name === state.statsDb,
  );
}

function renderCollections(): void {
  const title = el('collTitle');
  title.classList.toggle('hidden', !state.statsDb);
  title.textContent = state.statsDb ? `Collections of ${state.statsDb}` : '';
  if (!state.statsDb) return el('collTable').replaceChildren();
  sortableTable<CollectionStats>(
    el('collTable'),
    [
      { key: 'name', label: 'collection' },
      { key: 'type', label: 'type' },
      { key: 'count', label: 'documents', num: true, format: count },
      { key: 'avgObjSize', label: 'avg size', num: true, format: bytes },
      { key: 'size', label: 'data', num: true, format: bytes },
      { key: 'storageSize', label: 'storage', num: true, format: bytes },
      { key: 'nindexes', label: 'indexes', num: true, format: count },
      { key: 'totalIndexSize', label: 'index size', num: true, format: bytes },
    ],
    collStats,
    state.collSort,
    (s) => {
      state.collSort = s;
      save();
      renderCollections();
    },
  );
}

// ---------------------------------------------------------------------------
// Replication

function oplogRequest(): void {
  vscode.postMessage({ type: 'loadOplog', requestId: request('oplog'), ns: state.oplogNs.trim(), op: state.oplogOp, limit: state.oplogLimit });
}

/** Seconds as "45 s", "3m 20s", "41h 12m", "3d 4h". */
function seconds(n: number): string {
  if (n < 60) return `${Math.round(n)} s`;
  return uptime(n);
}

function clock(iso: string, withMs = false): string {
  const d = new Date(iso);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const today = new Date().toDateString() === d.toDateString();
  const date = today ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `;
  return `${date}${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${withMs ? `.${p(d.getMilliseconds(), 3)}` : ''}`;
}

const stateClass = (m: ReplMember) =>
  !m.health && m.state !== '?' ? 'state-down' : m.state === 'PRIMARY' ? 'state-primary' : m.state === 'SECONDARY' ? 'state-secondary' : m.state === 'ARBITER' ? 'state-arbiter' : 'state-other';

function card(cards: HTMLElement, label: string, value: string, sub?: string, valueClass = ''): void {
  const c = document.createElement('div');
  c.className = 'card';
  const l = document.createElement('div');
  l.className = 'card-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = `card-value ${valueClass}`;
  v.textContent = value;
  c.append(l, v);
  if (sub) {
    const d = document.createElement('div');
    d.className = 'card-sub';
    d.textContent = sub;
    c.append(d);
  }
  cards.append(c);
}

function replMessage(text: string, failed = false): void {
  const box = el('replMessage');
  box.textContent = text;
  box.classList.toggle('hidden', !text);
  box.classList.toggle('failed', failed);
}

function renderRepl(): void {
  const cards = el('replCards');
  cards.replaceChildren();
  const r = repl;
  const isSet = r?.kind === 'replicaSet';
  el('replMembers').classList.toggle('hidden', !isSet);
  el('oplogSection').classList.toggle('hidden', !isSet);
  if (!r) return;
  if (!isSet) {
    replMessage(
      r.kind === 'mongos'
        ? 'Connected to a mongos (sharded cluster): add a connection to a shard to see its replica set and oplog. The Sharding tab shows the cluster.'
        : `${r.me ?? 'This server'} is a standalone server: it is not part of a replica set, so there is no replication and no oplog.`,
    );
    return;
  }
  const members = r.members ?? [];
  const self = members.find((m) => m.self);
  card(cards, 'Replica set', r.setName ?? '', [r.term !== undefined ? `term ${r.term}` : '', r.settings?.protocolVersion !== undefined ? `protocol v${r.settings.protocolVersion}` : ''].filter(Boolean).join(' · '));
  card(cards, 'Primary', r.primary ?? 'none', self ? `connected to ${self.name} (${self.state.toLowerCase()})` : r.me ? `connected to ${r.me}` : undefined, r.primary ? '' : 'very-slow');
  const byState = new Map<string, number>();
  for (const m of members) byState.set(m.state.toLowerCase(), (byState.get(m.state.toLowerCase()) ?? 0) + 1);
  const healthy = members.filter((m) => m.health === 1).length;
  card(cards, 'Members', `${healthy} / ${members.length} healthy`, [...byState].map(([k, n]) => `${n} ${k}`).join(' · '), healthy < members.length ? 'very-slow' : '');
  const lagging = members.filter((m) => m.lag !== undefined && !m.delay);
  if (lagging.length) {
    const max = lagging.reduce((a, m) => (m.lag! > a.lag! ? m : a));
    const delayed = members.some((m) => m.delay);
    card(cards, 'Replication lag', max.lag ? seconds(max.lag) : '0 s', [max.lag ? max.name : 'every member is up to date', delayed ? 'delayed members left out' : ''].filter(Boolean).join(' · '), max.lag! >= 60 ? 'very-slow' : max.lag! >= 10 ? 'slow' : '');
  }
  if (r.oplog) {
    const o = r.oplog;
    card(
      cards,
      'Oplog window',
      o.window !== undefined ? seconds(o.window) : '',
      [o.size !== undefined ? `${bytes(o.size)}${o.maxSize ? ` of ${bytes(o.maxSize)}` : ''}` : '', o.count !== undefined ? `${count(o.count)} entries` : '', o.first ? `since ${clock(o.first)}` : '']
        .filter(Boolean)
        .join(' · '),
    );
  }
  const st = r.settings;
  if (st?.electionTimeoutMillis !== undefined) {
    card(
      cards,
      'Elections',
      `${st.electionTimeoutMillis / 1000} s timeout`,
      [st.heartbeatIntervalMillis !== undefined ? `heartbeat every ${st.heartbeatIntervalMillis / 1000} s` : '', st.chainingAllowed === false ? 'chaining not allowed' : 'chaining allowed'].filter(Boolean).join(' · '),
    );
  }
  replMessage([r.statusError ? `Member details need the clusterMonitor role: ${r.statusError}` : '', r.oplogError ? `Oplog: ${r.oplogError}` : ''].filter(Boolean).join('\n'), true);
  el('replInfo').textContent = r.at ? `as of ${clock(new Date(r.at).toISOString())}` : '';
  const step = el<HTMLButtonElement>('stepDown');
  step.disabled = !r.primary;
  step.title = r.primary ? `Make ${r.primary} step down so that the members elect another primary (replSetStepDown), e.g. to try a failover` : 'There is no primary';
  renderMembers();
}

function renderMembers(): void {
  const table = el<HTMLTableElement>('memberTable');
  table.replaceChildren();
  const members = repl?.members ?? [];
  header(table, ['member', 'state', 'lag', 'last applied', 'heartbeat', 'ping', 'sync source', 'priority', 'votes', 'notes', 'uptime']);
  const body = table.createTBody();
  const at = repl?.at ?? Date.now();
  for (const m of members) {
    const row = body.insertRow();
    row.className = 'clickable';
    if (expandedMembers.has(m.name)) row.classList.add('expanded');
    cell(row, m.name + (m.self ? ' ★' : ''), m.self ? 'self' : '', m.self ? 'The server Mongoster is connected to' : undefined);
    cell(row, m.health || m.state === '?' || m.state.startsWith('(') ? m.state : `${m.state} (down)`, stateClass(m));
    const lagCell = cell(row, m.lag === undefined ? '' : seconds(m.lag), 'num');
    if (m.lag !== undefined && !m.delay) lagCell.classList.add(m.lag >= 60 ? 'very-slow' : m.lag >= 10 ? 'slow' : 'ok');
    if (m.delay) lagCell.title = `Delayed by ${seconds(m.delay)} on purpose`;
    cell(row, m.optime ? clock(m.optime) : '', '', m.optime);
    cell(row, m.lastHeartbeat ? `${seconds(Math.max(0, (at - Date.parse(m.lastHeartbeat)) / 1000))} ago` : m.self ? '—' : '', 'num', m.lastHeartbeat);
    cell(row, m.pingMs === undefined ? '' : `${m.pingMs} ms`, 'num');
    cell(row, m.syncSource ?? '');
    cell(row, m.priority === undefined ? '' : String(m.priority), 'num');
    cell(row, m.votes === undefined ? '' : String(m.votes), 'num');
    const notes = [
      m.hidden ? 'hidden' : '',
      m.delay ? `delayed ${seconds(m.delay)}` : '',
      m.priority === 0 && !m.arbiter ? 'never primary' : '',
      m.buildIndexes === false ? 'no index builds' : '',
      m.tags ? Object.entries(m.tags).map(([k, v]) => `${k}: ${v}`).join(', ') : '',
      m.message ?? '',
    ].filter(Boolean);
    cell(row, notes.join(' · '), m.message ? 'command' : '', notes.join('\n'));
    cell(row, m.uptime === undefined ? '' : uptime(m.uptime), 'num');
    row.addEventListener('click', () => {
      if (expandedMembers.has(m.name)) expandedMembers.delete(m.name);
      else expandedMembers.add(m.name);
      renderMembers();
    });
    if (expandedMembers.has(m.name)) detailRow(table, 11, m.raw);
  }
}

function renderOplog(): void {
  const table = el<HTMLTableElement>('oplogTable');
  table.replaceChildren();
  header(table, ['time', 'op', 'namespace', '_id', 'change']);
  const body = table.createTBody();
  for (const e of oplog) {
    const row = body.insertRow();
    row.className = `clickable op-${['insert', 'update', 'delete'].includes(e.op) ? e.op : e.op === 'noop' ? 'noop' : 'other'}`;
    if (expandedOplog.has(e.key)) row.classList.add('expanded');
    cell(row, clock(e.time, true), 'time', `${e.time} · timestamp ${e.key}`);
    cell(row, e.op, 'op');
    cell(row, e.ns, 'ns');
    cell(row, e.id ?? '', 'key', e.id);
    cell(row, e.summary, 'command', e.summary);
    row.addEventListener('click', () => {
      if (expandedOplog.has(e.key)) expandedOplog.delete(e.key);
      else expandedOplog.add(e.key);
      renderOplog();
    });
    if (expandedOplog.has(e.key)) detailRow(table, 5, e.raw);
  }
  if (!oplog.length) {
    const c = body.insertRow().insertCell();
    c.colSpan = 5;
    c.className = 'empty';
    c.textContent = state.oplogNs.trim() || state.oplogOp ? 'No entry matches.' : 'The oplog is empty.';
  }
  el('oplogInfo').textContent = oplog.length ? `${oplogLimited ? 'the' : 'all'} ${count(oplog.length)} most recent${oplogLimited ? '' : ' matching'} entr${oplog.length === 1 ? 'y' : 'ies'}, newest first` : '';
}

// ---------------------------------------------------------------------------
// Sharding

function shardingRequest(full: boolean): void {
  shardingFull = full;
  vscode.postMessage({ type: 'loadSharding', requestId: request('sharding'), full });
}

function shardEventsRequest(): void {
  vscode.postMessage({ type: 'loadShardingEvents', requestId: request('shardEvents'), scope: state.shardEventsScope, ns: state.shardEventsNs.trim(), limit: SHARD_EVENTS });
}

/** Per-collection values (balancer status, data per shard) are only read on a full refresh: an automatic one keeps the previous ones. */
function mergeSharding(next: ShardingStatus, full: boolean): ShardingStatus {
  const prev = sharding;
  if (full || !prev?.collections || !next.collections) return next;
  const before = new Map(prev.collections.map((c) => [c.ns, c]));
  for (const c of next.collections) {
    const p = before.get(c.ns);
    if (!p) continue;
    if (c.balancerCompliant === undefined) {
      c.balancerCompliant = p.balancerCompliant;
      c.violation = p.violation;
    }
    c.data ??= p.data;
  }
  for (const s of next.shards ?? []) {
    const p = prev.shards?.find((x) => x.name === s.name);
    if (s.dataSize === undefined && p) {
      s.dataSize = p.dataSize;
      s.documents = p.documents;
    }
  }
  next.errors = [...next.errors, ...prev.errors.filter((e) => /^(balancer status of the collections|data per shard)/.test(e))];
  next.dataLimited ??= prev.dataLimited;
  return next;
}

/** A stable color per shard, in the order of the shards table. */
function shardColor(name: string): string {
  const i = Math.max(0, sharding?.shards?.findIndex((s) => s.name === name) ?? 0);
  return `var(--shard-${i % 6})`;
}

function swatch(name: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'swatch';
  s.style.background = shardColor(name);
  return s;
}

const VIOLATIONS: Record<string, string> = {
  chunksImbalance: 'uneven chunks',
  zoneViolation: 'zone violation',
  draining: 'draining',
  defragmentingChunks: 'defragmenting',
};

const totalSize = (c: ShardedCollectionInfo) => (c.data ? Object.values(c.data).reduce((a, d) => a + d.size, 0) : undefined);
const totalDocs = (c: ShardedCollectionInfo) => (c.data ? Object.values(c.data).reduce((a, d) => a + d.count, 0) : undefined);

/**
 * Whether the data is unevenly spread: the balancer's own verdict when it could be read, otherwise when
 * the most loaded shard has 1.5 times its even share and the gap exceeds the balancer's threshold (3 chunks).
 */
function balanceOf(c: ShardedCollectionInfo): { text: string; className: string; title: string } {
  if (c.balancerCompliant) return { text: 'balanced', className: 'ok', title: 'balancerCollectionStatus: compliant' };
  if (c.balancerCompliant === false) {
    return { text: VIOLATIONS[c.violation ?? ''] ?? c.violation ?? 'not balanced', className: 'slow', title: `balancerCollectionStatus: ${c.violation ?? 'not compliant'}: the balancer has chunks of this collection to move or merge` };
  }
  const shards = (sharding?.shards ?? []).filter((s) => !s.draining).map((s) => s.name);
  if (!c.data || shards.length < 2) return { text: '', className: '', title: '' };
  const sizes = shards.map((s) => c.data?.[s]?.size ?? 0);
  const total = sizes.reduce((a, n) => a + n, 0);
  const max = Math.max(...sizes);
  const threshold = 3 * (sharding?.balancer?.chunkSize ?? 128) * 1024 * 1024;
  const uneven = total > 0 && max >= (1.5 * total) / shards.length && max - Math.min(...sizes) > threshold;
  return uneven ? { text: 'uneven', className: 'slow', title: `The largest shard holds ${Math.round((max / total) * 100)}% of the data` } : { text: '', className: '', title: '' };
}

function distributionBar(values: Record<string, number>, format: (n: number) => string): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'dist';
  const total = Object.values(values).reduce((a, n) => a + n, 0);
  const lines: string[] = [];
  for (const s of sharding?.shards ?? []) {
    const v = values[s.name] ?? 0;
    lines.push(`${s.name}: ${format(v)} (${total ? Math.round((v / total) * 100) : 0}%)`);
    if (!v) continue;
    const seg = document.createElement('span');
    seg.style.width = `${(v / total) * 100}%`;
    seg.style.background = shardColor(s.name);
    bar.append(seg);
  }
  // Shards no longer listed (removed) still own chunks in the counts.
  for (const [name, v] of Object.entries(values)) if (!sharding?.shards?.some((s) => s.name === name)) lines.push(`${name}: ${format(v)}`);
  bar.title = lines.join('\n');
  return bar;
}

function shardMessage(text: string, failed = false): void {
  const box = el('shardMessage');
  box.textContent = text;
  box.classList.toggle('hidden', !text);
  box.classList.toggle('failed', failed);
}

function renderSharding(): void {
  const cards = el('shardCards');
  cards.replaceChildren();
  const s = sharding;
  const mongos = s?.kind === 'mongos';
  el('shardBody').classList.toggle('hidden', !mongos);
  if (!s) return;
  if (!mongos) {
    const me = s.me ?? 'This server';
    shardMessage(
      s.kind === 'shardMember'
        ? s.shardName === 'config'
          ? `${me} is a config server of a sharded cluster: connect to a mongos to see the shards, the sharded collections and the balancer.`
          : `${me} is a member of the shard ${s.shardName ?? ''} of a sharded cluster${s.configServer ? ` (config servers ${s.configServer})` : ''}: connect to a mongos to see the whole cluster.`
        : s.kind === 'replicaSet'
          ? `${me} is a replica set member, not a mongos: it is not part of a sharded cluster.`
          : `${me} is a standalone server: it is not part of a sharded cluster.`,
    );
    return;
  }
  const shards = s.shards ?? [];
  const colls = s.collections ?? [];
  if (s.shards) {
    const draining = shards.filter((x) => x.draining).length;
    const inactive = shards.filter((x) => x.state !== undefined && x.state !== 1).length;
    card(
      cards,
      'Shards',
      count(shards.length),
      [draining ? `${draining} draining` : '', inactive ? `${inactive} not active` : '', s.zones?.length ? `zones: ${s.zones.join(', ')}` : 'no zones'].filter(Boolean).join(' · '),
      draining || inactive ? 'slow' : '',
    );
  }
  if (s.collections) {
    const off = colls.filter((c) => !c.balancing).length;
    const unbalanced = colls.filter((c) => c.balancerCompliant === false).length;
    card(cards, 'Sharded collections', count(colls.length), [off ? `${off} with balancing off` : '', unbalanced ? `${unbalanced} not balanced` : ''].filter(Boolean).join(' · ') || undefined);
    const chunks = colls.reduce((a, c) => a + c.totalChunks, 0);
    const jumbo = colls.reduce((a, c) => a + c.jumbo, 0);
    card(
      cards,
      'Chunks',
      count(chunks),
      [jumbo ? `${count(jumbo)} jumbo` : 'no jumbo chunks', s.balancer?.chunkSize ? `chunk size ${s.balancer.chunkSize} MB` : ''].filter(Boolean).join(' · '),
      jumbo ? 'slow' : '',
    );
  }
  const b = s.balancer;
  if (b) {
    const enabled = b.mode !== 'off';
    card(
      cards,
      'Balancer',
      b.mode === undefined ? '?' : enabled ? (b.mode === 'full' ? 'enabled' : b.mode) : 'disabled',
      [
        b.running === undefined ? '' : b.running ? 'round in progress' : 'idle',
        b.rounds !== undefined ? `${count(b.rounds)} rounds` : '',
        b.window ? `window ${b.window.start}–${b.window.stop} (config server time)` : '',
        b.secondaryThrottle === false ? 'no secondary throttle' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      enabled ? (b.running ? 'ok' : '') : 'slow',
    );
  }
  if (s.migrations) {
    const m = s.migrations;
    card(
      cards,
      'Migrations (24 h)',
      `${count(m.done)} done${m.failed ? ` · ${count(m.failed)} failed` : ''}`,
      m.failedRounds ? `${count(m.failedRounds)} balancer round${m.failedRounds === 1 ? '' : 's'} with errors` : m.failed ? 'see the recent events' : undefined,
      m.failed || m.failedRounds ? 'very-slow' : '',
    );
  }
  if (s.configServer) {
    const { replSet, members } = splitHost(s.configServer);
    card(
      cards,
      'Config servers',
      replSet ?? members[0] ?? '',
      [
        `${members.length} member${members.length === 1 ? '' : 's'}`,
        s.routers ? `${s.routers.active} of ${s.routers.total} mongos active` : '',
        s.version ? `mongos ${s.version}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }
  shardMessage(s.errors.length ? `Not everything could be read (the cluster's state needs the clusterMonitor role, the balancer status of each collection clusterManager):\n${s.errors.join('\n')}` : '', true);
  el('shardInfo').textContent = `as of ${clock(new Date(s.at).toISOString())}`;
  const toggle = el<HTMLButtonElement>('balancerToggle');
  toggle.classList.toggle('hidden', !b?.mode);
  toggle.textContent = b?.mode === 'off' ? 'Start Balancer…' : 'Stop Balancer…';
  toggle.title = b?.mode === 'off' ? 'Let the balancer move chunks between the shards again (balancerStart)' : 'Stop moving chunks between the shards (balancerStop)';
  renderShards();
  renderShardCollections();
}

function splitHost(host: string): { replSet?: string; members: string[] } {
  const slash = host.indexOf('/');
  return { replSet: slash >= 0 ? host.slice(0, slash) : undefined, members: (slash >= 0 ? host.slice(slash + 1) : host).split(',').filter(Boolean) };
}

function renderShards(): void {
  const table = el<HTMLTableElement>('shardTable');
  table.replaceChildren();
  const shards = sharding?.shards ?? [];
  const columns = ['shard', 'replica set', 'members', 'state', 'draining', 'zones', 'chunks', 'data', 'documents', 'primary of'];
  header(table, columns);
  for (const [i, label] of columns.entries()) {
    const th = table.tHead!.rows[0].cells[i];
    if (['chunks', 'data', 'documents'].includes(label)) th.className = 'num';
    if (label === 'data' || label === 'documents') th.title = 'Of the sharded collections (unsharded collections are on the primary shard of their database)';
  }
  const body = table.createTBody();
  const totalData = shards.reduce((a, s) => a + (s.dataSize ?? 0), 0);
  for (const s of shards) {
    const row = body.insertRow();
    row.className = 'clickable';
    row.classList.toggle('expanded', expandedShards.has(s.name));
    const name = cell(row, s.name, 'self');
    name.prepend(swatch(s.name));
    cell(row, s.replSet ?? '(standalone)', s.replSet ? '' : 'slow');
    cell(row, s.members.join(', '), 'muted', s.host);
    cell(row, s.state === undefined || s.state === 1 ? 'active' : `state ${s.state}`, s.state === undefined || s.state === 1 ? 'ok' : 'slow');
    cell(row, s.draining ? 'draining' : '', s.draining ? 'slow' : '', s.draining ? 'Being removed: its chunks are moved to the other shards' : undefined);
    cell(row, s.tags.join(', '));
    cell(row, count(s.chunks), 'num');
    cell(row, bytes(s.dataSize), 'num', s.dataSize !== undefined && totalData ? `${Math.round((s.dataSize / totalData) * 100)}% of the sharded data` : undefined);
    cell(row, count(s.documents), 'num');
    cell(row, s.primaryOf.join(', '), 'muted', s.primaryOf.length ? `Primary shard of ${s.primaryOf.join(', ')}: their unsharded collections are here` : undefined);
    row.addEventListener('click', () => {
      if (expandedShards.has(s.name)) expandedShards.delete(s.name);
      else expandedShards.add(s.name);
      renderShards();
    });
    if (expandedShards.has(s.name)) detailRow(table, columns.length, s.raw);
  }
  if (!shards.length) {
    const c = body.insertRow().insertCell();
    c.colSpan = columns.length;
    c.className = 'empty';
    c.textContent = sharding?.shards ? 'The cluster has no shards yet (addShard).' : 'The shards could not be read.';
  }
}

type ShardCollSortKey = 'ns' | 'key' | 'unique' | 'balancing' | 'totalChunks' | 'size' | 'docs' | 'balance' | 'jumbo';

function renderShardCollections(): void {
  const table = el<HTMLTableElement>('shardCollTable');
  table.replaceChildren();
  const all = sharding?.collections ?? [];
  const needle = state.shardCollFilter.trim().toLowerCase();
  const shown = all.filter((c) => !needle || c.ns.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle));
  const sort = state.shardCollSort ?? { key: 'ns', desc: false };
  const value = (c: ShardedCollectionInfo, key: ShardCollSortKey): number | string =>
    key === 'size' ? totalSize(c) ?? -1 : key === 'docs' ? totalDocs(c) ?? -1 : key === 'balance' ? balanceOf(c).text : key === 'unique' || key === 'balancing' ? Number(c[key]) : c[key];
  shown.sort((a, b) => {
    const x = value(a, sort.key as ShardCollSortKey);
    const y = value(b, sort.key as ShardCollSortKey);
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sort.desc ? -cmp : cmp;
  });
  const columns: [string, ShardCollSortKey | null, string, boolean?][] = [
    ['namespace', 'ns', ''],
    ['shard key', 'key', ''],
    ['unique', 'unique', 'The shard key index is unique'],
    ['balancing', 'balancing', 'Whether the balancer may move the chunks of this collection'],
    ['chunks', 'totalChunks', '', true],
    ['chunks per shard', null, ''],
    ['data', 'size', 'Data size (uncompressed) on all the shards', true],
    ['documents', 'docs', '', true],
    ['distribution', null, 'Share of the data on each shard'],
    ['balance', 'balance', 'From balancerCollectionStatus: whether the balancer considers the collection balanced'],
    ['jumbo', 'jumbo', 'Chunks too large to be moved by the balancer', true],
  ];
  const head = table.createTHead().insertRow();
  for (const [label, key, title, num] of columns) {
    const th = document.createElement('th');
    th.textContent = label + (key && sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : '');
    th.title = title || (key ? 'Sort' : '');
    if (num) th.className = 'num';
    if (key) {
      th.addEventListener('click', () => {
        state.shardCollSort = { key, desc: sort.key === key ? !sort.desc : !!num };
        save();
        renderShardCollections();
      });
    } else th.style.cursor = 'default';
    head.append(th);
  }
  const body = table.createTBody();
  for (const c of shown) {
    const row = body.insertRow();
    row.className = 'clickable';
    row.classList.toggle('expanded', expandedShardColls.has(c.ns));
    cell(row, c.ns);
    cell(row, c.key, 'shard-key', c.key);
    cell(row, c.unique ? 'unique' : '');
    cell(row, c.balancing ? 'on' : 'off', c.balancing ? '' : 'slow', c.balancing ? undefined : 'Balancing is disabled for this collection (noBalance)');
    cell(row, count(c.totalChunks), 'num');
    const perShard = Object.entries(c.chunks).sort(([a], [b]) => a.localeCompare(b));
    cell(row, perShard.map(([s, n]) => `${s} ${count(n)}`).join(' · '), 'muted');
    const size = totalSize(c);
    cell(row, bytes(size), 'num', c.data ? undefined : 'Not read');
    cell(row, count(totalDocs(c)), 'num');
    const dist = row.insertCell();
    if (c.data) dist.append(distributionBar(Object.fromEntries(Object.entries(c.data).map(([k, d]) => [k, d.size])), bytes));
    else if (c.totalChunks) dist.append(distributionBar(c.chunks, (n) => `${count(n)} chunk${n === 1 ? '' : 's'}`));
    const balance = balanceOf(c);
    cell(row, balance.text, balance.className, balance.title || undefined);
    cell(row, c.jumbo ? count(c.jumbo) : '', `num ${c.jumbo ? 'slow' : ''}`);
    row.addEventListener('click', () => {
      if (expandedShardColls.has(c.ns)) expandedShardColls.delete(c.ns);
      else expandedShardColls.add(c.ns);
      renderShardCollections();
    });
    if (expandedShardColls.has(c.ns)) shardCollectionDetail(table, columns.length, c);
  }
  if (!shown.length) {
    const cellOf = body.insertRow().insertCell();
    cellOf.colSpan = columns.length;
    cellOf.className = 'empty';
    cellOf.textContent = all.length ? 'No collection matches the filter.' : sharding?.collections ? 'No collection is sharded yet.' : 'The sharded collections could not be read.';
  }
  const limited = sharding?.dataLimited ? ` · data per shard of the first ${count(sharding.dataLimited)} only` : '';
  el('shardCollInfo').textContent = all.length ? `${shown.length === all.length ? '' : `${count(shown.length)} of `}${count(all.length)} collection${all.length === 1 ? '' : 's'}${limited}` : '';
}

function shardCollectionDetail(table: HTMLTableElement, colspan: number, c: ShardedCollectionInfo): void {
  const row = table.tBodies[0].insertRow();
  row.className = 'detail';
  const cellOf = row.insertCell();
  cellOf.colSpan = colspan;
  const box = document.createElement('div');
  box.className = 'detail-box';
  cellOf.append(box);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.append(
    button(
      c.balancing ? 'Disable Balancing…' : 'Enable Balancing…',
      c.balancing ? `Stop the balancer from moving the chunks of ${c.ns}` : `Let the balancer move the chunks of ${c.ns} again`,
      () => vscode.postMessage({ type: 'setCollectionBalancing', ns: c.ns, enabled: !c.balancing }),
      'secondary small not-locked',
    ),
    button('Copy Shard Key', 'Copy the shard key (mongosh syntax)', () => vscode.postMessage({ type: 'copy', text: c.key })),
  );
  if (c.violation) {
    const facts = document.createElement('span');
    facts.className = 'info';
    facts.textContent = `balancer: ${VIOLATIONS[c.violation] ?? c.violation}`;
    actions.append(facts);
  }
  box.append(actions);

  // Chunks and data per shard
  const per = document.createElement('table');
  per.className = 'mini';
  header(per, ['shard', 'chunks', 'data', 'documents', 'share']);
  for (const i of [1, 2, 3, 4]) per.tHead!.rows[0].cells[i].className = 'num';
  const pbody = per.createTBody();
  const names = [...new Set([...(sharding?.shards ?? []).map((s) => s.name), ...Object.keys(c.chunks), ...Object.keys(c.data ?? {})])];
  const total = totalSize(c) ?? 0;
  for (const name of names) {
    const chunks = c.chunks[name] ?? 0;
    const d = c.data?.[name];
    if (!chunks && !d?.count) continue;
    const r = pbody.insertRow();
    cell(r, name).prepend(swatch(name));
    cell(r, count(chunks), 'num');
    cell(r, bytes(d?.size), 'num');
    cell(r, count(d?.count), 'num');
    cell(r, d && total ? `${Math.round((d.size / total) * 100)}%` : '', 'num');
  }
  box.append(per);

  const zones = document.createElement('div');
  zones.className = 'zones';
  const title = document.createElement('div');
  title.className = 'info';
  title.textContent = c.zones.length ? 'Zones' : 'No zone ranges for this collection.';
  zones.append(title);
  for (const z of c.zones) {
    const line = document.createElement('div');
    const shardsOf = (sharding?.shards ?? []).filter((s) => s.tags.includes(z.zone)).map((s) => s.name);
    const name = document.createElement('b');
    name.textContent = z.zone;
    const range = document.createElement('code');
    range.textContent = `${z.min} → ${z.max}`;
    const where = document.createElement('span');
    where.className = shardsOf.length ? 'info' : 'slow';
    where.textContent = shardsOf.length ? ` on ${shardsOf.join(', ')}` : ' no shard in this zone';
    line.append(name, ' ', range, where);
    zones.append(line);
  }
  box.append(zones);

  const raw = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'config.collections document';
  const pre = document.createElement('pre');
  raw.addEventListener('toggle', () => {
    if (raw.open && !pre.textContent) pre.textContent = prettyShell(c.raw, 0, 110);
  });
  raw.append(summary, pre);
  box.append(raw);
}

const eventClass = (e: ShardingEvent) =>
  e.error ? 'event-error' : e.what.startsWith('moveChunk') || e.what.startsWith('moveRange') ? 'op-update' : /^(split|multi-split|merge)/.test(e.what) ? 'op-insert' : e.what.startsWith('balancer') ? 'op-other' : '';

function renderShardEvents(): void {
  const table = el<HTMLTableElement>('shardEventsTable');
  table.replaceChildren();
  header(table, ['time', 'event', 'namespace', 'shard', 'details']);
  const body = table.createTBody();
  for (const e of shardEvents) {
    const row = body.insertRow();
    row.className = `clickable ${eventClass(e)}`;
    if (expandedEvents.has(e.key)) row.classList.add('expanded');
    cell(row, e.time ? clock(e.time, true) : '', 'time', e.time);
    cell(row, e.what + (e.error ? ' ⚠' : ''), 'op', e.action ? 'config.actionlog' : 'config.changelog');
    cell(row, e.ns, 'ns');
    cell(row, e.shard ?? '', 'ns');
    cell(row, e.summary, 'command', e.summary);
    row.addEventListener('click', () => {
      if (expandedEvents.has(e.key)) expandedEvents.delete(e.key);
      else expandedEvents.add(e.key);
      renderShardEvents();
    });
    if (expandedEvents.has(e.key)) detailRow(table, 5, e.raw);
  }
  if (!shardEvents.length) {
    const c = body.insertRow().insertCell();
    c.colSpan = 5;
    c.className = 'empty';
    c.textContent = state.shardEventsNs.trim() ? 'No event for this namespace.' : 'No events recorded.';
  }
  const errors = shardEvents.filter((e) => e.error).length;
  el('shardEventsInfo').textContent = shardEvents.length ? `the ${count(shardEvents.length)} most recent, newest first${errors ? ` · ${errors} with errors` : ''}` : '';
}

// ---------------------------------------------------------------------------
// Messages

window.addEventListener('message', (e: MessageEvent<MonitorHostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      readOnly = m.readOnly;
      document.body.classList.toggle('locked', readOnly);
      if (m.color) document.body.dataset.color = m.color;
      else delete document.body.dataset.color;
      el('title').textContent = m.connectionName;
      if (readOnly) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'read-only';
        badge.title = 'The connection is read-only: operations can not be killed and the profiler can not be changed';
        el('title').append(' ', badge);
      }
      databases = m.databases;
      if (!state.profileDb || !databases.includes(state.profileDb)) {
        state.profileDb = databases.find((d) => !['admin', 'local', 'config'].includes(d)) ?? databases[0];
      }
      if (state.logDb && !databases.includes(state.logDb)) state.logDb = '';
      fillProfileDbs();
      setTab(state.tab);
      break;
    }
    case 'ops':
      if (m.requestId !== latest.ops) return;
      showError('opsError', m.error);
      ops = m.ops ?? [];
      // Forget expanded rows of finished operations.
      for (const id of [...expandedOps]) if (!ops.some((op) => String(op.opid) === id)) expandedOps.delete(id);
      renderOps();
      break;
    case 'killResult':
      killing.delete(String(m.opid));
      if (m.message) el('opsInfo').textContent = m.message;
      if (!m.ok && m.message) showError('opsError', m.message);
      vscode.postMessage({ type: 'loadOps', requestId: request('ops'), includeIdle: state.idle });
      break;
    case 'profile':
      if (m.requestId !== latest.profile) return;
      showError('profileError', m.error);
      profile = m.entries ?? [];
      profileInfo = { level: m.level, slowms: m.slowms, limited: m.limited };
      renderProfile();
      break;
    case 'profileAction': {
      const box = el('profileMessage');
      box.textContent = m.message ?? '';
      box.classList.toggle('hidden', !m.message);
      box.classList.toggle('failed', !m.ok);
      if (m.ok) profileRequest();
      break;
    }
    case 'server':
      if (m.requestId !== latest.server) return;
      showError('serverError', m.error);
      if (m.stats) {
        lastServer = server;
        server = m.stats;
      }
      renderServer();
      break;
    case 'databases':
      if (m.requestId !== latest.databases) return;
      showError('dbError', m.error);
      dbStats = m.databases ?? [];
      renderDatabases();
      break;
    case 'collections':
      if (m.requestId !== latest.collections || m.database !== state.statsDb) return;
      showError('collError', m.error);
      collStats = m.collections ?? [];
      renderCollections();
      break;
    case 'replication':
      if (m.requestId !== latest.repl) return;
      showError('replError', m.error);
      if (m.status) repl = m.status;
      for (const name of [...expandedMembers]) if (!repl?.members?.some((x) => x.name === name)) expandedMembers.delete(name);
      renderRepl();
      break;
    case 'oplog':
      if (m.requestId !== latest.oplog) return;
      showError('oplogError', m.error);
      oplog = m.entries ?? [];
      oplogLimited = !!m.limited;
      for (const key of [...expandedOplog]) if (!oplog.some((x) => x.key === key)) expandedOplog.delete(key);
      renderOplog();
      break;
    case 'replAction':
      el<HTMLButtonElement>('stepDown').disabled = false;
      if (m.message) replMessage(m.message, !m.ok);
      if (m.ok) setTimeout(() => refresh(false), 1500);
      break;
    case 'sharding':
      if (m.requestId !== latest.sharding) return;
      showError('shardError', m.error);
      if (m.status) sharding = mergeSharding(m.status, shardingFull);
      for (const name of [...expandedShards]) if (!sharding?.shards?.some((x) => x.name === name)) expandedShards.delete(name);
      for (const ns of [...expandedShardColls]) if (!sharding?.collections?.some((x) => x.ns === ns)) expandedShardColls.delete(ns);
      renderSharding();
      break;
    case 'shardingEvents':
      if (m.requestId !== latest.shardEvents) return;
      showError('shardEventsError', m.error);
      shardEvents = m.events ?? [];
      for (const key of [...expandedEvents]) if (!shardEvents.some((x) => x.key === key)) expandedEvents.delete(key);
      renderShardEvents();
      break;
    case 'shardingAction': {
      el<HTMLButtonElement>('balancerToggle').disabled = false;
      const box = el('shardAction');
      box.textContent = m.message ?? '';
      box.classList.toggle('hidden', !m.message);
      box.classList.toggle('failed', !m.ok);
      if (m.ok) setTimeout(() => refresh(true), 1000);
      break;
    }
  }
});

el('tabOps').addEventListener('click', () => setTab('ops'));
el('tabProfile').addEventListener('click', () => setTab('profile'));
el('tabStats').addEventListener('click', () => setTab('stats'));
el('tabRepl').addEventListener('click', () => setTab('repl'));
el('tabShard').addEventListener('click', () => setTab('shard'));
el('refresh').addEventListener('click', () => refresh(true));
const auto = el<HTMLSelectElement>('auto');
auto.value = String(state.auto);
auto.addEventListener('change', () => setAuto(Number(auto.value)));

const filter = el<HTMLInputElement>('opsFilter');
filter.value = state.filter;
filter.addEventListener('input', () => {
  state.filter = filter.value;
  save();
  renderOps();
});
const minSeconds = el<HTMLInputElement>('opsMin');
minSeconds.value = String(state.minSeconds);
minSeconds.addEventListener('input', () => {
  state.minSeconds = Math.max(0, Number(minSeconds.value) || 0);
  save();
  renderOps();
});
const idle = el<HTMLInputElement>('opsIdle');
idle.checked = state.idle;
idle.addEventListener('change', () => {
  state.idle = idle.checked;
  save();
  refresh(false);
});
const system = el<HTMLInputElement>('opsSystem');
system.checked = state.system;
system.addEventListener('change', () => {
  state.system = system.checked;
  save();
  renderOps();
});

/** Shows other operations: the expanded rows and the last message no longer apply. */
function profileChanged(): void {
  save();
  profile = [];
  expandedProfile.clear();
  el('profileMessage').classList.add('hidden');
  profileRequest();
}
el<HTMLSelectElement>('profileSource').addEventListener('change', (e) => {
  state.profileSource = (e.target as HTMLSelectElement).value as SlowOpSource;
  fillProfileDbs();
  profileChanged();
});
el<HTMLSelectElement>('profileDb').addEventListener('change', (e) => {
  const value = (e.target as HTMLSelectElement).value;
  if (state.profileSource === 'log') state.logDb = value;
  else state.profileDb = value;
  profileChanged();
});
const since = el<HTMLSelectElement>('profileSince');
since.value = String(state.profileSince);
since.addEventListener('change', () => {
  state.profileSince = Number(since.value);
  profileChanged();
});
for (const [id, view] of [
  ['profileGrouped', 'grouped'],
  ['profileAll', 'all'],
] as const) {
  el(id).addEventListener('click', () => {
    state.profileView = view;
    save();
    renderProfile();
  });
}
const profileFilter = el<HTMLInputElement>('profileFilter');
profileFilter.value = state.profileFilter;
profileFilter.addEventListener('input', () => {
  state.profileFilter = profileFilter.value;
  save();
  renderProfile();
});
const slowmsOf = (id: string) => Math.max(0, Math.round(Number(el<HTMLInputElement>(id).value) || 0));
el('profileApply').addEventListener('click', () => {
  if (!state.profileDb) return;
  const level = Number(el<HTMLSelectElement>('profileLevel').value) as 0 | 1 | 2;
  vscode.postMessage({ type: 'setProfile', database: state.profileDb, level, slowms: slowmsOf('profileSlowms') });
});
el('logApply').addEventListener('click', () => vscode.postMessage({ type: 'setProfile', database: '', level: -1, slowms: slowmsOf('logSlowms') }));
el('profileClear').addEventListener('click', () => {
  if (state.profileDb) vscode.postMessage({ type: 'clearProfile', database: state.profileDb });
});

const oplogNs = el<HTMLInputElement>('oplogNs');
oplogNs.value = state.oplogNs;
let oplogTimer: ReturnType<typeof setTimeout> | undefined;
oplogNs.addEventListener('input', () => {
  state.oplogNs = oplogNs.value;
  save();
  clearTimeout(oplogTimer);
  oplogTimer = setTimeout(oplogRequest, 300);
});
for (const [id, key] of [
  ['oplogOp', 'oplogOp'],
  ['oplogLimit', 'oplogLimit'],
] as const) {
  const select = el<HTMLSelectElement>(id);
  select.value = String(state[key]);
  select.addEventListener('change', () => {
    if (key === 'oplogOp') state.oplogOp = select.value as OplogOp;
    else state.oplogLimit = Number(select.value);
    save();
    expandedOplog.clear();
    oplogRequest();
  });
}
el('stepDown').addEventListener('click', () => {
  el<HTMLButtonElement>('stepDown').disabled = true;
  vscode.postMessage({ type: 'stepDown' });
});

const shardCollFilter = el<HTMLInputElement>('shardCollFilter');
shardCollFilter.value = state.shardCollFilter;
shardCollFilter.addEventListener('input', () => {
  state.shardCollFilter = shardCollFilter.value;
  save();
  renderShardCollections();
});
const shardEventsNs = el<HTMLInputElement>('shardEventsNs');
shardEventsNs.value = state.shardEventsNs;
let shardEventsTimer: ReturnType<typeof setTimeout> | undefined;
shardEventsNs.addEventListener('input', () => {
  state.shardEventsNs = shardEventsNs.value;
  save();
  clearTimeout(shardEventsTimer);
  shardEventsTimer = setTimeout(shardEventsRequest, 300);
});
const shardEventsScope = el<HTMLSelectElement>('shardEventsScope');
shardEventsScope.value = state.shardEventsScope;
shardEventsScope.addEventListener('change', () => {
  state.shardEventsScope = shardEventsScope.value as 'balancer' | 'all';
  save();
  expandedEvents.clear();
  shardEventsRequest();
});
el('balancerToggle').addEventListener('click', () => {
  if (!sharding?.balancer?.mode) return;
  el<HTMLButtonElement>('balancerToggle').disabled = true;
  vscode.postMessage({ type: 'setBalancer', enabled: sharding.balancer.mode === 'off' });
});

setAuto(state.auto);
vscode.postMessage({ type: 'ready' });
