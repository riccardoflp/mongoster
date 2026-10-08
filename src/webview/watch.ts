// Change stream tab: the events of a collection, database or deployment as they happen, with a field
// diff of updates and replacements.
import type { WatchEvent, WatchHostMessage, WatchOptions, WatchState, WatchViewMessage } from '../shared/messages';
import { isEjsonWrapper, isPlainObject, prettyShell, toShell } from '../shared/query';

const CATEGORIES = ['insert', 'update', 'replace', 'delete', 'other'] as const;
type Category = (typeof CATEGORIES)[number];
/** Events kept in the list; older ones are dropped. */
export const MAX_EVENTS = 1000;

interface State {
  options: WatchOptions;
  hidden: Category[];
  search: string;
}

declare function acquireVsCodeApi(): {
  postMessage(message: WatchViewMessage): void;
  getState(): Partial<State> | undefined;
  setState(state: State): void;
};

const vscode = acquireVsCodeApi();
const state: State = { options: { match: '', fullDocument: true }, hidden: [], search: '', ...vscode.getState() };
const save = () => vscode.setState(state);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let scope: { database?: string; collection?: string } = {};
let readOnly = false;
let started = false;
let streamState: WatchState = 'stopped';
let statusMessage: string | undefined;
let paused = false;
let events: WatchEvent[] = [];
/** Events received while paused. */
let held: WatchEvent[] = [];
let dropped = 0;
/** Highest seq already shown, to highlight the new rows. */
let seen = 0;
const expanded = new Set<number>();
const searchText = new Map<number, string>();
let renderQueued = false;

const category = (op: string): Category => ((CATEGORIES as readonly string[]).includes(op) ? (op as Category) : 'other');

function time(iso: string): string {
  const d = new Date(iso);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function pre(value: unknown): HTMLPreElement {
  const p = document.createElement('pre');
  p.textContent = prettyShell(value, 0, 100);
  return p;
}

// ---------------------------------------------------------------------------
// Field diff

const MISSING = Symbol('missing');
type Value = unknown | typeof MISSING;

export interface DiffRow {
  field: string;
  kind: 'added' | 'changed' | 'removed' | 'truncated';
  before?: Value;
  after?: Value;
  note?: string;
}

function getPath(doc: unknown, path: string): Value {
  let cur: unknown = doc;
  for (const part of path.split('.')) {
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (isPlainObject(cur) && !isEjsonWrapper(cur) && part in cur) cur = cur[part];
    else return MISSING;
    if (cur === undefined) return MISSING;
  }
  return cur;
}

/** Leaf fields of a document, descending into sub-documents (not arrays or type wrappers). */
function flatten(doc: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (isPlainObject(doc) && !isEjsonWrapper(doc) && (Object.keys(doc).length || !prefix)) {
    for (const [k, v] of Object.entries(doc)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, doc);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diff(ev: WatchEvent): DiffRow[] {
  const rows: DiffRow[] = [];
  const hasBefore = ev.before !== undefined;
  if (ev.updated || ev.removed || ev.truncated) {
    for (const [field, after] of Object.entries(ev.updated ?? {})) {
      const before = hasBefore ? getPath(ev.before, field) : undefined;
      rows.push({ field, kind: hasBefore && before === MISSING ? 'added' : 'changed', before, after });
    }
    for (const field of ev.removed ?? []) rows.push({ field, kind: 'removed', before: hasBefore ? getPath(ev.before, field) : undefined, after: MISSING });
    for (const t of ev.truncated ?? []) rows.push({ field: t.field, kind: 'truncated', note: `truncated to ${t.newSize} element${t.newSize === 1 ? '' : 's'}` });
    return rows;
  }
  if (hasBefore && ev.after !== undefined) {
    const a = flatten(ev.before);
    const b = flatten(ev.after);
    for (const [field, before] of a) {
      if (!b.has(field)) rows.push({ field, kind: 'removed', before, after: MISSING });
      else if (!same(before, b.get(field))) rows.push({ field, kind: 'changed', before, after: b.get(field) });
    }
    for (const [field, after] of b) if (!a.has(field)) rows.push({ field, kind: 'added', before: MISSING, after });
  }
  return rows;
}

function valueCell(row: HTMLTableRowElement, v: Value | undefined, className: string): void {
  const c = row.insertCell();
  c.className = `value ${className}`;
  if (v === MISSING) {
    c.textContent = row.className === 'removed' && className === 'after' ? '(removed)' : '—';
    c.classList.add('missing');
  } else c.textContent = toShell(v);
}

function diffTable(ev: WatchEvent, rows: DiffRow[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'diff';
  const withBefore = ev.before !== undefined;
  const head = table.createTHead().insertRow();
  for (const label of withBefore ? ['field', 'before', 'after'] : ['field', 'value']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const row = body.insertRow();
    row.className = r.kind;
    const f = row.insertCell();
    f.className = 'field';
    f.textContent = r.field;
    if (r.note) {
      const c = row.insertCell();
      c.colSpan = withBefore ? 2 : 1;
      c.className = 'value missing';
      c.textContent = r.note;
      continue;
    }
    if (withBefore) valueCell(row, r.before, 'before');
    valueCell(row, r.after, 'after');
  }
  return table;
}

// ---------------------------------------------------------------------------
// Rendering

function visible(): WatchEvent[] {
  const needle = state.search.trim().toLowerCase();
  return events.filter((ev) => {
    if (state.hidden.includes(category(ev.op))) return false;
    if (!needle) return true;
    let text = searchText.get(ev.seq);
    if (text === undefined) {
      text = [ev.op, ev.ns, ev.key, ev.summary, JSON.stringify(ev.after ?? ''), JSON.stringify(ev.updated ?? '')].join(' ').toLowerCase();
      searchText.set(ev.seq, text);
    }
    return text.includes(needle);
  });
}

function renderOps(): void {
  const counts = new Map<Category, number>();
  for (const ev of events) counts.set(category(ev.op), (counts.get(category(ev.op)) ?? 0) + 1);
  el('ops').replaceChildren(
    ...CATEGORIES.map((c) => {
      const b = document.createElement('button');
      b.className = `op-toggle op-${c}`;
      b.setAttribute('aria-pressed', String(!state.hidden.includes(c)));
      b.textContent = `${c} ${counts.get(c) ?? 0}`;
      b.title = c === 'other' ? 'drop, rename, dropDatabase, invalidate…' : `Show the ${c} events`;
      b.addEventListener('click', () => {
        state.hidden = state.hidden.includes(c) ? state.hidden.filter((x) => x !== c) : [...state.hidden, c];
        save();
        render();
      });
      return b;
    }),
  );
}

function detail(table: HTMLTableElement, ev: WatchEvent, colspan: number): void {
  const row = table.tBodies[0].insertRow();
  row.className = 'detail';
  const c = row.insertCell();
  c.colSpan = colspan;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const dot = ev.ns.indexOf('.');
  if (ev.id !== undefined && dot > 0 && ev.op !== 'delete') {
    actions.append(
      button('Open document', 'secondary small', () =>
        vscode.postMessage({ type: 'openDocument', database: ev.ns.slice(0, dot), collection: ev.ns.slice(dot + 1), id: ev.id }),
      'Open the current version of the document in an editor tab'),
    );
  }
  actions.append(button('Copy event', 'secondary small', () => vscode.postMessage({ type: 'copy', text: prettyShell(ev.raw, 0, 100) })));
  c.append(actions);

  const section = (label: string, content: HTMLElement) => {
    const h = document.createElement('div');
    h.className = 'section-label';
    h.textContent = label;
    c.append(h, content);
  };
  const rows = ev.op === 'update' || ev.op === 'replace' ? diff(ev) : [];
  if (rows.length) section(ev.before === undefined ? 'Changes (the values before are not recorded)' : 'Changes', diffTable(ev, rows));
  else if (ev.op === 'update' || ev.op === 'replace') {
    if (ev.before !== undefined && ev.after !== undefined) section('Changes', Object.assign(document.createElement('div'), { className: 'note', textContent: 'No field changed.' }));
  }
  if (ev.op === 'insert' && ev.after !== undefined) section('Inserted document', pre(ev.after));
  if (ev.op === 'replace' && ev.after !== undefined && ev.before === undefined) section('New document', pre(ev.after));
  if (ev.op === 'delete') {
    if (ev.before !== undefined) section('Deleted document', pre(ev.before));
    else section('Deleted document', Object.assign(document.createElement('div'), { className: 'note', textContent: 'Not recorded: the collection does not store pre-images.' }));
  }
  if (ev.op === 'update') {
    const after = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = ev.after !== undefined ? 'Current document' : 'Current document (not read: enable "Current document on update", or the document was deleted)';
    after.append(s);
    if (ev.after !== undefined) after.append(pre(ev.after));
    c.append(after);
  }
  const raw = document.createElement('details');
  const s = document.createElement('summary');
  s.textContent = 'Change event';
  raw.append(s, pre(ev.raw));
  c.append(raw);
}

function render(): void {
  renderQueued = false;
  renderOps();
  const table = el<HTMLTableElement>('events');
  table.replaceChildren();
  const shown = visible();
  const total = events.length + dropped;
  el('info').textContent = `${shown.length === events.length ? '' : `${shown.length} of `}${events.length} event${events.length === 1 ? '' : 's'}${dropped ? ` (${dropped} older dropped)` : ''}`;
  const withNs = !scope.collection;
  const labels = ['time', 'operation', ...(withNs ? ['namespace'] : []), '_id', 'changes'];
  if (!shown.length) {
    const p = table.createTBody().insertRow().insertCell();
    p.className = 'empty';
    p.textContent = total
      ? 'No event matches the filters.'
      : streamState === 'watching'
        ? 'Waiting for changes… Insert, update or delete a document to see it here.'
        : streamState === 'starting'
          ? 'Starting the change stream…'
          : 'Not watching. Press Start.';
    seen = Math.max(seen, events.at(-1)?.seq ?? 0);
    return;
  }
  const head = table.createTHead().insertRow();
  for (const label of labels) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  // Newest first.
  for (let i = shown.length - 1; i >= 0; i--) {
    const ev = shown[i];
    const row = body.insertRow();
    row.className = 'clickable';
    if (ev.seq > seen) row.classList.add('fresh');
    if (expanded.has(ev.seq)) row.classList.add('expanded');
    const cell = (text: string, className = '', title?: string) => {
      const c = row.insertCell();
      c.textContent = text;
      if (className) c.className = className;
      if (title) c.title = title;
    };
    cell(time(ev.time), 'time', new Date(ev.time).toLocaleString());
    cell(ev.op, `op op-${category(ev.op)}`);
    if (withNs) cell(ev.ns, 'ns');
    cell(ev.key ?? '', 'key');
    cell(ev.summary, 'command', ev.summary);
    row.addEventListener('click', () => {
      if (expanded.has(ev.seq)) expanded.delete(ev.seq);
      else expanded.add(ev.seq);
      render();
    });
    if (expanded.has(ev.seq)) detail(table, ev, labels.length);
  }
  seen = Math.max(seen, events.at(-1)?.seq ?? 0);
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function renderStatus(): void {
  const status = el('status');
  const label =
    paused && streamState === 'watching'
      ? `❚❚ Paused${held.length ? ` · ${held.length} new` : ''}`
      : { starting: '○ Starting…', watching: '● Watching', stopped: '■ Stopped', error: '■ Stopped' }[streamState];
  status.textContent = label;
  status.dataset.state = paused && streamState === 'watching' ? 'paused' : streamState;
  const running = streamState === 'starting' || streamState === 'watching';
  el('startStop').textContent = running ? 'Stop' : 'Start';
  el('startStop').title = running ? 'Close the change stream' : 'Open the change stream (changes made while stopped are not shown)';
  el('pause').textContent = paused ? `Resume${held.length ? ` (${held.length})` : ''}` : 'Pause';
  (el('pause') as HTMLButtonElement).disabled = !running && !paused;
  const error = el('error');
  const text = streamState === 'error' || streamState === 'stopped' ? (statusMessage ?? '') : '';
  error.textContent = text;
  error.classList.toggle('hidden', !text);
  error.classList.toggle('notice', streamState === 'stopped');
}

function add(list: WatchEvent[]): void {
  events.push(...list);
  if (events.length > MAX_EVENTS) {
    const extra = events.length - MAX_EVENTS;
    for (const ev of events.slice(0, extra)) {
      expanded.delete(ev.seq);
      searchText.delete(ev.seq);
    }
    events = events.slice(extra);
    dropped += extra;
  }
  scheduleRender();
}

function start(): void {
  paused = false;
  if (held.length) add(held.splice(0));
  vscode.postMessage({ type: 'start', options: state.options });
}

// ---------------------------------------------------------------------------
// Messages and controls

window.addEventListener('message', (e: MessageEvent<WatchHostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      scope = { database: m.database, collection: m.collection };
      readOnly = m.readOnly;
      const where = m.collection ? `${m.database}.${m.collection}` : (m.database ?? 'all databases');
      el('title').textContent = `${m.connectionName} › ${where}`;
      if (m.color) document.body.dataset.color = m.color;
      else delete document.body.dataset.color;
      const pi = el('preImages');
      pi.replaceChildren();
      pi.classList.toggle('hidden', m.preImages === undefined);
      if (m.preImages) {
        pi.textContent = 'Pre-images recorded';
        pi.title = 'The collection stores the document before each change: updates show the values before.';
      } else if (m.preImages === false) {
        pi.append('Values before a change: not recorded');
        pi.title = 'The collection does not store pre-images (changeStreamPreAndPostImages).';
        if (!readOnly) pi.append(' ', button('Enable…', 'link', () => vscode.postMessage({ type: 'enablePreImages' }), 'Record the document before each change (collMod)'));
      }
      if (!started) {
        started = true;
        start();
      }
      render();
      break;
    }
    case 'status':
      streamState = m.state;
      statusMessage = m.message;
      if (m.state === 'stopped' || m.state === 'error') {
        paused = false;
        if (held.length) add(held.splice(0));
      }
      renderStatus();
      scheduleRender();
      break;
    case 'events':
      if (paused) {
        held.push(...m.events);
        renderStatus();
      } else add(m.events);
      break;
  }
});

el('startStop').addEventListener('click', () => {
  if (streamState === 'starting' || streamState === 'watching') vscode.postMessage({ type: 'stop' });
  else start();
});
el('pause').addEventListener('click', () => {
  paused = !paused;
  if (!paused && held.length) add(held.splice(0));
  renderStatus();
});
el('clear').addEventListener('click', () => {
  events = [];
  held = [];
  dropped = 0;
  expanded.clear();
  searchText.clear();
  renderStatus();
  render();
});

const search = el<HTMLInputElement>('search');
search.value = state.search;
search.addEventListener('input', () => {
  state.search = search.value;
  save();
  scheduleRender();
});

const match = el<HTMLInputElement>('match');
match.value = state.options.match;
match.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  state.options = { ...state.options, match: match.value };
  save();
  start();
});

const fullDocument = el<HTMLInputElement>('fullDocument');
fullDocument.checked = state.options.fullDocument;
fullDocument.addEventListener('change', () => {
  state.options = { ...state.options, fullDocument: fullDocument.checked };
  save();
  if (streamState === 'starting' || streamState === 'watching') start();
});

renderStatus();
render();
vscode.postMessage({ type: 'ready' });
