// Server monitor tab: running operations, profiler entries and statistics, refreshed on demand or periodically.
import type {
  CollectionStats,
  DatabaseStats,
  MonitorHostMessage,
  MonitorOp,
  MonitorViewMessage,
  ProfileEntry,
  ServerStats,
} from '../shared/messages';
import { prettyShell } from '../shared/query';

type Tab = 'ops' | 'profile' | 'stats';

interface State {
  tab: Tab;
  auto: number;
  filter: string;
  minSeconds: number;
  idle: boolean;
  system: boolean;
  profileDb?: string;
  statsDb?: string;
  dbSort?: SortState;
  collSort?: SortState;
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
const state: State = { tab: 'ops', auto: 5, filter: '', minSeconds: 0, idle: false, system: false, ...vscode.getState() };
const save = () => vscode.setState(state);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let readOnly = false;
let databases: string[] = [];
let ops: MonitorOp[] = [];
let profile: ProfileEntry[] = [];
let dbStats: DatabaseStats[] = [];
let collStats: CollectionStats[] = [];
/** Previous server sample, for rates. */
let lastServer: ServerStats | undefined;
let server: ServerStats | undefined;
const expandedOps = new Set<string>();
const expandedProfile = new Set<string>();
const killing = new Set<string>();
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
  ] as const) {
    el(view).classList.toggle('hidden', t !== tab);
    el(button).setAttribute('aria-selected', String(t === tab));
  }
  refresh(true);
}

/** Reloads the current tab; `full` also reloads the slower parts (database and collection statistics). */
function refresh(full: boolean): void {
  if (state.tab === 'ops') vscode.postMessage({ type: 'loadOps', requestId: request('ops'), includeIdle: state.idle });
  else if (state.tab === 'profile') {
    if (state.profileDb) vscode.postMessage({ type: 'loadProfile', requestId: request('profile'), database: state.profileDb });
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

function renderProfile(level: number | undefined, slowms: number | undefined): void {
  const table = el<HTMLTableElement>('profileTable');
  table.replaceChildren();
  if (level !== undefined) {
    el<HTMLSelectElement>('profileLevel').value = String(level);
    if (slowms !== undefined) el<HTMLInputElement>('profileSlowms').value = String(slowms);
    el('profileStatus').textContent =
      level === 0 ? 'Profiler off' : level === 1 ? `Recording operations slower than ${slowms} ms` : 'Recording all operations';
  }
  if (!profile.length) {
    const p = table.createTBody().insertRow().insertCell();
    p.className = 'empty';
    p.textContent =
      level === 0
        ? 'The profiler of this database is off: choose "slow operations" and Apply to record the operations slower than the threshold.'
        : 'No operations recorded yet.';
    return;
  }
  header(table, ['time', 'op', 'namespace', 'ms', 'docs examined', 'keys examined', 'returned', 'plan', 'command']);
  const body = table.createTBody();
  for (const entry of profile) {
    const id = `${entry.ts}/${entry.ns}/${entry.summary.length}`;
    const row = body.insertRow();
    row.className = 'op';
    row.classList.toggle('expanded', expandedProfile.has(id));
    const ts = new Date(entry.ts);
    cell(row, ts.toLocaleTimeString(), 'num', ts.toLocaleString());
    cell(row, entry.op);
    cell(row, entry.ns);
    cell(row, count(entry.millis), `num ${entry.millis >= 1000 ? 'very-slow' : entry.millis >= 100 ? 'slow' : ''}`);
    const ratio = entry.docsExamined && entry.nreturned !== undefined ? entry.docsExamined / Math.max(entry.nreturned, 1) : 0;
    cell(row, count(entry.docsExamined), `num ${ratio >= 100 ? 'slow' : ''}`, ratio >= 100 ? `${Math.round(ratio)} documents examined per document returned` : undefined);
    cell(row, count(entry.keysExamined), 'num');
    cell(row, count(entry.nreturned), 'num');
    cell(row, entry.plan ?? '', entry.plan?.startsWith('COLLSCAN') ? 'collscan' : '');
    cell(row, entry.summary, 'command', entry.summary);
    row.addEventListener('click', () => {
      if (expandedProfile.has(id)) expandedProfile.delete(id);
      else expandedProfile.add(id);
      renderProfile(undefined, undefined);
    });
    if (expandedProfile.has(id)) detailRow(table, 9, entry.raw);
  }
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
      const select = el<HTMLSelectElement>('profileDb');
      select.replaceChildren(...databases.map((d) => new Option(d, d)));
      if (!state.profileDb || !databases.includes(state.profileDb)) {
        state.profileDb = databases.find((d) => !['admin', 'local', 'config'].includes(d)) ?? databases[0];
      }
      if (state.profileDb) select.value = state.profileDb;
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
      renderProfile(m.level, m.slowms);
      break;
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
  }
});

el('tabOps').addEventListener('click', () => setTab('ops'));
el('tabProfile').addEventListener('click', () => setTab('profile'));
el('tabStats').addEventListener('click', () => setTab('stats'));
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

el<HTMLSelectElement>('profileDb').addEventListener('change', (e) => {
  state.profileDb = (e.target as HTMLSelectElement).value;
  save();
  profile = [];
  expandedProfile.clear();
  refresh(true);
});
el('profileApply').addEventListener('click', () => {
  if (!state.profileDb) return;
  const level = Number(el<HTMLSelectElement>('profileLevel').value) as 0 | 1 | 2;
  const slowms = Math.max(0, Math.round(Number(el<HTMLInputElement>('profileSlowms').value) || 0));
  vscode.postMessage({ type: 'setProfile', requestId: request('profile'), database: state.profileDb, level, slowms });
});

setAuto(state.auto);
vscode.postMessage({ type: 'ready' });
