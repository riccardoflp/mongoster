// Index advisor tab: the indexes to create for the slow operations, and those redundant or unused,
// each with its reason and actions.
import './tokenColors';
import type { Advice, AdvisorIndex, AdvisorQuery } from '../shared/advisor';
import type { AdvisorHostMessage, AdvisorReport, AdvisorViewMessage } from '../shared/messages';
import { toShell } from '../shared/query';

declare function acquireVsCodeApi(): {
  postMessage(message: AdvisorViewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let scope: { database?: string; collection?: string } = {};
let readOnly = false;
let requestId = 0;
let loading = false;
let report: AdvisorReport | undefined;
/** Advice whose queries are all listed. */
const expanded = new Set<string>();
const QUERIES_SHOWN = 3;

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const plural = (n: number, word: string, words = `${word}s`) => `${fmt(n)} ${n === 1 ? word : words}`;

function bytes(n: number | undefined): string {
  if (n === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = n > 0 ? Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024))) : 0;
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function ms(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${fmt(n)} ms`;
}

function ago(iso: string | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'a minute ago';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = node('button', className, label);
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

const nsOf = (a: { database: string; collection: string }) => (scope.collection ? a.collection : scope.database ? a.collection : `${a.database}.${a.collection}`);

function indexLabel(ix: AdvisorIndex): HTMLElement {
  const box = node('span', 'index');
  box.append(node('span', 'index-name', ix.name), node('code', 'keys', toShell(ix.key)));
  const opts = [ix.unique && 'unique', ix.sparse && 'sparse', ix.partialFilterExpression !== undefined && 'partial', ix.collation && `collation ${ix.collation}`, ix.hidden && 'hidden'].filter(Boolean) as string[];
  if (opts.length) box.append(node('span', 'opts', opts.join(' · ')));
  return box;
}

function card(a: Advice, head: HTMLElement[], body: (HTMLElement | string)[], actions: HTMLButtonElement[]): HTMLElement {
  const box = node('div', `advice kind-${a.kind}`);
  const top = node('div', 'card-head');
  top.append(node('span', 'ns', nsOf(a)), ...head, node('span', 'spacer'));
  const acts = node('span', 'actions');
  acts.append(...actions);
  top.append(acts);
  box.append(top);
  for (const b of body) box.append(typeof b === 'string' ? node('p', 'why', b) : b);
  return box;
}

function write(b: HTMLButtonElement): HTMLButtonElement {
  if (readOnly) {
    b.disabled = true;
    b.title = 'The connection is read-only';
  }
  return b;
}

function queryRow(a: Extract<Advice, { kind: 'create' }>, q: AdvisorQuery, i: number): HTMLElement {
  const row = node('div', 'query');
  const flags = [q.collscan && 'collection scan', q.sortStage && 'in-memory sort'].filter(Boolean).join(', ');
  row.append(node('span', 'op', q.kind), node('code', 'shape', q.shape));
  const stats = node('span', 'qstats', `${plural(q.count, 'time')} · avg ${ms(q.avgMs)} · ${fmt(q.docsExamined / q.count)} examined / ${fmt(q.nreturned / q.count)} returned${flags ? ` · ${flags}` : ''}`);
  row.append(stats);
  const acts = node('span', 'qactions');
  acts.append(
    button('Open', 'link', () => vscode.postMessage({ type: 'openQuery', id: a.id, query: i, explain: false }), 'Open the slowest of these queries in the collection tab'),
    button('Explain', 'link', () => vscode.postMessage({ type: 'openQuery', id: a.id, query: i, explain: true }), 'Open it and show how the server runs it now'),
  );
  row.append(acts);
  return row;
}

function createCard(a: Extract<Advice, { kind: 'create' }>): HTMLElement {
  const keys = toShell(a.keys);
  const queries = node('div', 'queries');
  const all = expanded.has(a.id);
  a.queries.slice(0, all ? undefined : QUERIES_SHOWN).forEach((q, i) => queries.append(queryRow(a, q, i)));
  if (a.queries.length > QUERIES_SHOWN) {
    queries.append(
      button(all ? 'Fewer queries' : `+${plural(a.queries.length - QUERIES_SHOWN, 'more query', 'more queries')}`, 'link more', () => {
        if (all) expanded.delete(a.id);
        else expanded.add(a.id);
        render();
      }),
    );
  }
  const scanned = a.queries.some((q) => q.collscan);
  const sorted = a.queries.some((q) => q.sortStage);
  const why = `${plural(a.count, 'slow operation')}, ${ms(a.totalMs)} in total, ${scanned ? 'read the whole collection' : sorted ? 'sorted in memory' : 'examined many more documents than they returned'}. This index (equality fields, then sort, then range) can serve ${a.queries.length === 1 ? 'it' : `all ${plural(a.queries.length, 'query shape')}`}.`;
  return card(
    a,
    [node('code', 'keys', keys)],
    [why, queries],
    [
      write(button('Create Index…', '', () => vscode.postMessage({ type: 'create', id: a.id }), `Create ${keys} on ${a.database}.${a.collection}`)),
      button('Copy', 'secondary', () => vscode.postMessage({ type: 'copy', text: `db.getSiblingDB(${JSON.stringify(a.database)}).getCollection(${JSON.stringify(a.collection)}).createIndex(${keys})` }), 'Copy the mongosh command'),
    ],
  );
}

function dropActions(a: Extract<Advice, { kind: 'redundant' | 'unused' | 'hidden' }>, why: string): HTMLButtonElement[] {
  const { database, collection } = a;
  const name = a.index.name;
  const hide = a.kind === 'hidden'
    ? button('Unhide', 'secondary', () => vscode.postMessage({ type: 'hide', database, collection, name, hidden: false }), 'Let queries use the index again')
    : button('Hide', 'secondary', () => vscode.postMessage({ type: 'hide', database, collection, name, hidden: true }), 'Queries stop using it, but it is kept up to date: unhide it at once if something gets slower');
  return [write(hide), write(button('Drop…', 'secondary danger', () => vscode.postMessage({ type: 'drop', database, collection, name, why })))];
}

function adviceCard(a: Advice): HTMLElement {
  if (a.kind === 'create') return createCard(a);
  const size = a.index.size !== undefined ? node('span', 'size', bytes(a.index.size)) : undefined;
  const head = [indexLabel(a.index), ...(size ? [size] : [])];
  if (a.kind === 'redundant') {
    const by = node('p', 'why');
    by.append('Every query that can use it can use ', indexLabel(a.by), ', which starts with the same fields: this one only costs writes and memory.');
    const use = a.index.ops !== undefined ? node('p', 'why muted', `Used ${plural(a.index.ops, 'time')} since ${ago(a.index.since)} (the planner may pick either index).`) : undefined;
    return card(a, head, [by, ...(use ? [use] : [])], dropActions(a, `Its fields are the start of ${a.by.name} ${toShell(a.by.key)}, which serves the same queries.`));
  }
  if (a.kind === 'hidden') {
    return card(a, head, ['Hidden: no query uses it, yet every write keeps it up to date. If nothing got slower since it was hidden, drop it.'], dropActions(a, 'It is hidden, so no query uses it.'));
  }
  const since = ago(a.index.since);
  return card(
    a,
    head,
    [`Not used by any query since ${since || 'the statistics started'}${a.index.since ? ` (${new Date(a.index.since).toLocaleString()})` : ''}.`],
    dropActions(a, `No query used it since ${since || 'the statistics started'}.`),
  );
}

function section(title: string, list: Advice[], empty: string, note?: string): HTMLElement {
  const box = node('section', 'group');
  const h = node('h2', '', title);
  if (list.length) h.append(node('span', 'count', String(list.length)));
  box.append(h);
  if (note) box.append(node('p', 'note', note));
  if (!list.length) box.append(node('p', 'empty', empty));
  for (const a of list) box.append(adviceCard(a));
  return box;
}

function renderSources(r: AdvisorReport): void {
  const box = el('sources');
  box.textContent = '';
  const s = r.sources;
  const profilerOps = s.profiler.reduce((n, p) => n + p.ops, 0);
  const line = node('p');
  const parts: string[] = [];
  if (profilerOps) parts.push(`${plural(profilerOps, 'operation')} from the profiler${s.profiler.filter((p) => p.ops).length === 1 ? ` of ${s.profiler.find((p) => p.ops)!.database}` : ''}`);
  if (s.log.ops) parts.push(`${plural(s.log.ops, 'operation')} from the server log`);
  line.textContent = `Slow operations${s.slowms ? ` (slower than ${s.slowms} ms)` : ''}: ${parts.join(', ') || 'none'}${s.since ? `, since ${ago(s.since)}` : ''}.`;
  box.append(line);
  if (s.log.error) box.append(node('p', 'warn', `The server log can't be read: ${s.log.error}`));
  const off = s.profiler.filter((p) => p.level === 0 && !p.ops);
  if (off.length) {
    const p = node('p', 'off');
    p.append(off.length === 1 ? `The profiler of ${off[0].database} is off: only the slow operations still in the server log are seen. ` : `The profiler is off on ${plural(off.length, 'database')}: only the slow operations still in the server log are seen. `);
    if (!readOnly) {
      for (const db of off.slice(0, 8)) p.append(button(off.length === 1 ? 'Turn On…' : `Turn on for ${db.database}…`, 'link', () => vscode.postMessage({ type: 'enableProfiler', database: db.database }), `Record the operations on ${db.database} slower than ${s.slowms ?? 100} ms`), ' ');
    }
    box.append(p);
  }
  for (const p of s.profiler.filter((x) => x.error)) box.append(node('p', 'warn', `${p.database}: ${p.error}`));
  for (const f of r.failed) box.append(node('p', 'warn', `${f.ns}: ${f.error}`));
}

function render(): void {
  const r = report;
  const root = el('report');
  root.textContent = '';
  el('refresh').toggleAttribute('disabled', loading);
  el('refresh').textContent = loading ? 'Analyzing…' : 'Refresh';
  if (!r) {
    el('summary').textContent = loading ? 'Reading the indexes and the slow operations…' : '';
    return;
  }
  const create = r.advice.filter((a) => a.kind === 'create');
  const redundant = r.advice.filter((a) => a.kind === 'redundant');
  const unused = r.advice.filter((a) => a.kind === 'unused' || a.kind === 'hidden');
  el('summary').textContent = `${plural(r.collections, 'collection')} · ${plural(r.indexes, 'index', 'indexes')} · ${bytes(r.indexBytes)} of indexes · ${r.advice.length ? plural(r.advice.length, 'suggestion') : 'nothing to suggest'}`;
  renderSources(r);
  const anyOps = r.sources.log.ops + r.sources.profiler.reduce((n, p) => n + p.ops, 0) > 0;
  root.append(
    section('Indexes to create', create, anyOps ? 'No slow operation needs a new index.' : 'No slow operations recorded yet: turn on the profiler, use the application for a while, then refresh.'),
    section('Redundant indexes', redundant, 'No index is the start of another one.'),
    section(
      'Unused indexes',
      unused,
      r.tooRecent ? 'No index has been unused for a day or more.' : 'Every index was used since the statistics started.',
      `Use is counted since the server started (or the index was created), on the server Mongoster is connected to: on a replica set, check the other members too before dropping. Unique and TTL indexes are not listed: they work without being read by queries.${r.tooRecent ? ` ${plural(r.tooRecent, 'more index wasn’t', 'more indexes weren’t')} used yet, but ${r.tooRecent === 1 ? 'its' : 'their'} statistics started less than a day ago: check again later.` : ''}`,
    ),
  );
}

function showMessage(ok: boolean, text: string | undefined): void {
  const box = el('message');
  box.textContent = text ?? '';
  box.classList.toggle('hidden', !text);
  box.classList.toggle('failed', !ok);
}

function analyze(): void {
  requestId++;
  loading = true;
  el('error').classList.add('hidden');
  render();
  vscode.postMessage({ type: 'analyze', requestId });
}

window.addEventListener('message', (e: MessageEvent<AdvisorHostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const first = !scope.database && !scope.collection && !el('title').textContent;
      scope = { database: m.database, collection: m.collection };
      readOnly = m.readOnly;
      el('title').textContent = `Index Advisor · ${m.collection ? `${m.database}.${m.collection}` : (m.database ?? 'every database')} · ${m.connectionName}`;
      el('locked').classList.toggle('hidden', !readOnly);
      if (m.color) document.body.dataset.color = m.color;
      else delete document.body.dataset.color;
      if (first) analyze();
      else render();
      break;
    }
    case 'report':
      if (m.requestId !== requestId) return;
      loading = false;
      if (m.error) {
        el('error').textContent = m.error;
        el('error').classList.remove('hidden');
      } else report = m.report;
      el('updated').textContent = `Analyzed at ${new Date().toLocaleTimeString()}`;
      render();
      break;
    case 'actionResult':
      if (m.message) showMessage(m.ok, m.message);
      if (m.ok) analyze();
      break;
  }
});

el('refresh').addEventListener('click', () => {
  showMessage(true, undefined);
  analyze();
});
render();
vscode.postMessage({ type: 'ready' });
