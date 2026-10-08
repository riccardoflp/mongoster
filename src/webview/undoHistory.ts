// Undo History tab: the recorded operations, newest first, with what undoing each one does to its
// documents and the space the history takes on disk.
import type { FieldDiff } from '../shared/compare';
import type { HistoryDocument, HistoryEntry, HistoryHostMessage, HistoryUsage, HistoryViewMessage } from '../shared/messages';
import { prettyShell } from '../shared/query';

interface State {
  search: string;
}

declare function acquireVsCodeApi(): { postMessage(m: HistoryViewMessage): void; getState(): Partial<State> | undefined; setState(s: State): void };

const vscode = acquireVsCodeApi();
const state: State = { search: '', ...vscode.getState() };
const post = (m: HistoryViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let entries: HistoryEntry[] = [];
let usage: HistoryUsage | undefined;
const expanded = new Set<string>();
const details = new Map<string, Extract<HistoryHostMessage, { type: 'details' }> | 'loading'>();
/** Entries with an undo in progress. */
const undoing = new Set<string>();

function size(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function when(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `${time}:${p(d.getSeconds())}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

const plural = (n: number, what: string) => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

function documentsText(e: HistoryEntry): string {
  return [e.inserted ? `${e.inserted.toLocaleString('en-US')} inserted` : '', e.updated ? `${e.updated.toLocaleString('en-US')} updated` : '', e.deleted ? `${e.deleted.toLocaleString('en-US')} deleted` : '']
    .filter(Boolean)
    .join(', ');
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

function span(text: string, className: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function cell(row: HTMLTableRowElement, text: string, className = '', title?: string): HTMLTableCellElement {
  const c = row.insertCell();
  c.textContent = text;
  if (className) c.className = className;
  if (title) c.title = title;
  return c;
}

function showMessage(text: string, failed = false): void {
  const box = el('message');
  box.textContent = text;
  box.classList.toggle('hidden', !text);
  box.classList.toggle('failed', failed);
}

function matches(e: HistoryEntry): boolean {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return [e.connectionName, `${e.database}.${e.collection}`, e.label].some((t) => t.toLowerCase().includes(q));
}

function valueCell(row: HTMLTableRowElement, f: FieldDiff, side: 'left' | 'right'): void {
  const c = row.insertCell();
  c.className = `value ${side}`;
  if (!(side in f)) {
    c.textContent = '—';
    c.classList.add('missing');
    c.title = side === 'left' ? 'Missing now' : 'Missing after the undo';
  } else {
    c.textContent = prettyShell(f[side], 0, 70);
    if (f.types) c.append(span(` ${f.types[side === 'left' ? 0 : 1]}`, 'type'));
  }
}

function diffTable(fields: FieldDiff[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'diff';
  const head = table.createTHead().insertRow();
  for (const label of ['field', 'now', 'after the undo']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const f of fields) {
    const row = body.insertRow();
    row.className = !('left' in f) ? 'added' : !('right' in f) ? 'removed' : 'changed';
    cell(row, f.path, 'field');
    valueCell(row, f, 'left');
    valueCell(row, f, 'right');
  }
  return table;
}

const KIND_TEXT: Record<HistoryDocument['kind'], string> = {
  inserted: 'inserted: the undo deletes it',
  updated: 'updated: the undo restores it',
  deleted: 'deleted: the undo inserts it again',
};

function documentBox(d: HistoryDocument): HTMLElement {
  const box = document.createElement('div');
  box.className = 'document';
  const head = document.createElement('div');
  head.className = 'document-head';
  head.append(span(d.id, 'doc-id'), span(KIND_TEXT[d.kind], 'kind'));
  if (d.changed) head.append(span('changed since', 'changed'));
  box.append(head);
  if (d.fields.length) box.append(diffTable(d.fields));
  else box.append(span(d.kind === 'inserted' ? 'Already deleted.' : 'Already as it was: the undo changes nothing.', 'muted'));
  return box;
}

function detailContent(e: HistoryEntry): HTMLElement {
  const box = document.createElement('div');
  box.className = 'detail-box';
  const d = details.get(e.id);
  if (!d || d === 'loading') {
    box.append(span('Loading…', 'muted'));
    return box;
  }
  if (d.error) {
    box.append(span(d.error, 'failed'));
    return box;
  }
  const docs = d.documents ?? [];
  const changed = docs.filter((x) => x.changed).length;
  const lines = [
    d.total! > docs.length ? `First ${docs.length.toLocaleString('en-US')} of ${plural(d.total!, 'document')}.` : '',
    changed ? `${plural(changed, 'document')} changed after the operation: undoing overwrites those changes too.` : '',
  ].filter(Boolean);
  if (lines.length) box.append(span(lines.join(' '), changed ? 'warning' : 'muted'));
  for (const doc of docs) box.append(documentBox(doc));
  return box;
}

function toggle(e: HistoryEntry): void {
  if (expanded.delete(e.id)) return render();
  expanded.add(e.id);
  details.set(e.id, 'loading');
  post({ type: 'details', id: e.id });
  render();
}

function render(): void {
  const shown = entries.filter(matches);
  if (usage) {
    const total = `${plural(entries.length, 'operation')} · ${size(usage.bytes)} of ${size(usage.maxBytes)}`;
    el('summary').textContent = shown.length === entries.length ? total : `${shown.length.toLocaleString('en-US')} shown · ${total}`;
    el('summary').title = `Kept for ${plural(usage.maxDays, 'day')}, up to ${plural(usage.maxEntries, 'operation')} and ${size(usage.maxBytes)}; operations of more than ${plural(usage.maxDocuments, 'document')} aren't recorded.`;
  }
  const table = el<HTMLTableElement>('entries');
  table.textContent = '';
  if (!shown.length) {
    const c = table.insertRow().insertCell();
    c.className = 'empty';
    c.textContent = entries.length ? 'No operations match the filter.' : 'No operations yet: changes made from Mongoster to documents show up here, to undo them.';
    return;
  }
  const head = table.createTHead().insertRow();
  for (const label of ['when', 'collection', 'operation', 'documents', 'size', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const e of shown) {
    const row = body.insertRow();
    row.className = `entry${e.undone ? ' undone' : ''}${expanded.has(e.id) ? ' open' : ''}`;
    cell(row, when(e.time), 'time', new Date(e.time).toLocaleString());
    const ns = cell(row, '', 'ns', `${e.connectionName} › ${e.database}.${e.collection}`);
    ns.append(span(`${e.connectionName} › `, 'conn'), `${e.database}.${e.collection}`);
    cell(row, e.label, 'label', e.label);
    cell(row, documentsText(e), 'docs');
    cell(row, e.undone ? '' : size(e.size), 'size');
    const actions = row.insertCell();
    actions.className = 'actions';
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    if (e.undone) {
      const done = span('undone', 'muted');
      done.title = `Undone ${new Date(e.undone).toLocaleString()}`;
      wrap.append(done);
    }
    else {
      const undo = button(undoing.has(e.id) ? 'Undoing…' : 'Undo', 'small', () => {
        undoing.add(e.id);
        showMessage('');
        post({ type: 'undo', id: e.id });
        render();
      }, 'Put the documents back as they were before this operation');
      undo.disabled = undoing.has(e.id);
      wrap.append(undo);
    }
    wrap.append(button('✕', 'small secondary', () => post({ type: 'remove', id: e.id }), 'Remove from the history (the operation can no longer be undone)'));
    actions.append(wrap);
    if (!e.undone) row.addEventListener('click', () => toggle(e));
    if (expanded.has(e.id) && !e.undone) {
      const detail = body.insertRow();
      detail.className = 'detail';
      const c = detail.insertCell();
      c.colSpan = 6;
      c.append(detailContent(e));
    }
  }
}

window.addEventListener('message', (event: MessageEvent<HistoryHostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      entries = m.entries;
      usage = m.usage;
      el('off').classList.toggle('hidden', m.enabled);
      // An entry that changed (undone, removed) drops its stale details.
      for (const id of [...expanded]) if (!entries.some((e) => e.id === id && !e.undone)) expanded.delete(id);
      for (const id of [...undoing]) if (!entries.some((e) => e.id === id && !e.undone)) undoing.delete(id);
      for (const id of expanded) {
        details.set(id, 'loading');
        post({ type: 'details', id });
      }
      render();
      break;
    case 'details':
      if (!expanded.has(m.id)) return;
      details.set(m.id, m);
      render();
      break;
    case 'message':
      undoing.clear();
      showMessage(m.text, m.failed);
      render();
      break;
  }
});

const search = el<HTMLInputElement>('search');
search.value = state.search;
search.addEventListener('input', () => {
  state.search = search.value;
  vscode.setState(state);
  render();
});
el('settings').addEventListener('click', () => post({ type: 'settings' }));
el('clear').addEventListener('click', () => post({ type: 'clear' }));
post({ type: 'ready' });
