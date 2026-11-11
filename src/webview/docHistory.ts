// History tab of a document: its versions from the oplog, newest first, with what each write changed,
// who wrote it, the document at that point and the button to restore it.
import { UNKNOWN_TEXT, VersionDiff } from '../shared/docHistory';
import type { DocHistoryHostMessage, DocHistoryInfo, DocHistoryViewMessage, DocVersionView } from '../shared/messages';
import { prettyShell } from '../shared/query';

declare function acquireVsCodeApi(): { postMessage(m: DocHistoryViewMessage): void };

const vscode = acquireVsCodeApi();
const post = (m: DocHistoryViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Result = Extract<DocHistoryHostMessage, { type: 'result' }>;

let info: DocHistoryInfo | undefined;
let result: Result | undefined;
let loading = false;
const expanded = new Set<string>();

const UNKNOWN_TOKEN = JSON.stringify(UNKNOWN_TEXT);
const UNKNOWN_TITLE = "Not known: the oplog keeps the new values of an update, not the old ones (it may also have been missing)";
const KIND_LABELS: Record<DocVersionView['kind'], string> = { insert: 'Insert', update: 'Update', replace: 'Replace', delete: 'Delete', drop: 'Removed', renamed: 'Renamed' };
const fmt = (n: number) => n.toLocaleString('en-US');
const localTime = (iso: string) => new Date(iso).toLocaleString();

function span(text: string, className: string, title?: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  if (title) s.title = title;
  return s;
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

/** Text in mongosh syntax into `node`, the unknown values drawn as "?". */
function fill(node: HTMLElement, text: string): void {
  const parts = text.split(UNKNOWN_TOKEN);
  parts.forEach((part, i) => {
    if (i) node.append(span('?', 'unknown', UNKNOWN_TITLE));
    if (part) node.append(document.createTextNode(part));
  });
}

function showMessage(text: string, failed = false): void {
  const m = el('message');
  m.textContent = text;
  m.classList.toggle('hidden', !text);
  m.classList.toggle('failed', failed);
}

function showError(text: string | null): void {
  el('error').textContent = text ?? '';
  el('error').classList.toggle('hidden', !text);
}

// ---------------------------------------------------------------------------
// Header and oplog window

function renderHeader(): void {
  if (!info) return;
  const target = el('target');
  target.replaceChildren(span(`${info.database}.${info.collection}`, 'ns'), span(` _id: ${info.id}`, 'id'), span(` · ${info.connectionName}`, 'conn'));
  if (info.color) document.body.dataset.color = info.color;
  else delete document.body.dataset.color;
  el('badge').classList.toggle('hidden', !info.readOnly);
  el('badge').title = info.readOnly ?? '';
}

/** "3.2 h", "45 min", "12 days" between two ISO times. */
function duration(from: string, to: string): string {
  const s = Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
  if (s < 120) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 3 * 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

function renderWindow(): void {
  const box = el('window');
  const more = el('more');
  if (!result) {
    box.textContent = loading ? 'Reading the oplog…' : '';
    more.classList.add('hidden');
    return;
  }
  const r = result;
  const parts: string[] = [];
  if (r.oplogFirst && r.oplogLast) parts.push(`The oplog goes back to ${localTime(r.oplogFirst)} (${duration(r.oplogFirst, r.oplogLast)}): older writes are no longer there.`);
  else parts.push('The oplog is empty.');
  parts.push(`${fmt(r.versions.length)} write${r.versions.length === 1 ? '' : 's'} found in ${(r.durationMs / 1000).toFixed(1)} s.`);
  box.textContent = parts.join(' ');
  more.classList.toggle('hidden', r.complete);
  el('moreInfo').textContent = r.complete
    ? ''
    : `${r.timedOut ? 'Reading stopped at the time limit: the' : 'The'} oplog was read back to ${r.readFrom ? localTime(r.readFrom) : '?'}. Older writes of this document may be in the rest.`;
  el<HTMLButtonElement>('older').disabled = loading;
}

// ---------------------------------------------------------------------------
// Versions

function changesText(v: DocVersionView): string {
  if (v.command) return v.command;
  switch (v.kind) {
    case 'insert':
    case 'replace': {
      const n = v.doc && typeof v.doc === 'object' ? Object.keys(v.doc).length : 0;
      return `${v.kind === 'insert' ? 'inserted' : 'replaced with'} a document of ${fmt(n)} field${n === 1 ? '' : 's'}`;
    }
    case 'delete':
      return 'deleted';
    case 'update': {
      const parts = [
        v.set?.length ? `set ${v.set.join(', ')}` : '',
        v.unset?.length ? `unset ${v.unset.join(', ')}` : '',
        v.truncated?.length ? `resized ${v.truncated.join(', ')}` : '',
      ].filter(Boolean);
      return parts.join(' · ') || 'no change';
    }
    default:
      return '';
  }
}

/** Who or what wrote the version: Mongoster, a transaction, a retryable write, a chunk migration. */
function byCell(v: DocVersionView): HTMLElement[] {
  const out: HTMLElement[] = [];
  const session = [v.lsid && `session ${v.lsid}`, v.txnNumber && `txnNumber ${v.txnNumber}`].filter(Boolean).join(', ');
  if (v.mongoster) out.push(span('Mongoster', 'by by-mongoster', `Written from Mongoster: ${v.mongoster} (in the Undo History)`));
  if (v.group === 'transaction') {
    const notes = [v.partial && 'part of a large transaction (several oplog entries)', v.prepared && 'prepared transaction'].filter(Boolean).join(', ');
    out.push(span('transaction', 'by', [session, notes].filter(Boolean).join('\n')));
  } else if (v.group === 'batch') out.push(span('batch', 'by', `One command writing several documents, logged as one applyOps${session ? `\n${session}` : ''}`));
  else if (session) out.push(span('retryable write', 'by', session));
  if (v.migrate) out.push(span('chunk migration', 'by', 'Written by the balancer moving a chunk to another shard, not by a client'));
  return out;
}

function stateBadge(v: DocVersionView): HTMLElement | undefined {
  if (v.current) return span('current', 'state state-current', 'The document as it is now');
  switch (v.state) {
    case 'partial':
      return span('partial', 'state state-partial', `Some values of this version aren't known: ${v.unknown?.join(', ')}`);
    case 'unknown':
      return span('unknown', 'state state-unknown', "What the document was at this point isn't known: the write before it isn't in the part of the oplog read");
    case 'absent':
      return span('no document', 'state state-absent', 'The document didn’t exist after this write');
    default:
      return undefined;
  }
}

/** The Restore button of a version; undefined when it can't be restored. */
function restoreButton(v: DocVersionView, label: string): HTMLButtonElement | undefined {
  if (v.state !== 'exact' || !v.doc || v.current || !result) return undefined;
  const text = result.exists ? `${label}…` : 'Insert again…';
  const title = result.exists ? 'Replace the document as it is now with this version (after a confirmation)' : 'The document was deleted: insert it again as it was in this version (after a confirmation)';
  const b = button(text, 'small secondary', () => post({ type: 'restore', key: v.key }), info?.readOnly ?? title);
  b.disabled = loading || !!info?.readOnly;
  return b;
}

function valueCell(row: HTMLTableRowElement, f: VersionDiff, side: 'left' | 'right'): void {
  const c = row.insertCell();
  c.className = `value ${side}`;
  if (f[`${side}Unknown`]) {
    c.append(span('?', 'unknown', UNKNOWN_TITLE));
    c.classList.add('missing');
  } else if (!(side in f)) {
    c.textContent = '—';
    c.classList.add('missing');
    c.title = 'The field is missing';
  } else {
    fill(c, prettyShell(f[side], 0, 70));
    if (f.types) c.append(span(` ${f.types[side === 'left' ? 0 : 1]}`, 'type'));
  }
}

function diffTable(fields: VersionDiff[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'diff';
  const head = table.createTHead().insertRow();
  for (const label of ['field', 'before', 'after']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const f of fields) {
    const row = body.insertRow();
    const left = 'left' in f || f.leftUnknown;
    const right = 'right' in f || f.rightUnknown;
    row.className = !left ? 'added' : !right ? 'removed' : 'changed';
    const name = row.insertCell();
    name.className = 'field';
    name.textContent = f.path;
    valueCell(row, f, 'left');
    valueCell(row, f, 'right');
  }
  return table;
}

function detail(v: DocVersionView): HTMLElement {
  const box = document.createElement('div');
  box.className = 'detail-box';
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const restore = restoreButton(v, 'Restore this version');
  if (restore) actions.append(restore);
  if (v.doc !== undefined && v.state === 'exact') actions.append(button('Copy', 'small secondary', () => post({ type: 'copy', text: prettyShell(v.doc, 0, 100) }), 'Copy this version of the document'));
  actions.append(span(`${localTime(v.time)} · ${v.ts}`, 'info'));
  box.append(actions);

  const notes: string[] = [];
  if (v.state === 'partial') notes.push(`Partial: the values marked ? aren't known (${v.unknown?.join(', ')}). The oplog keeps the new values of an update, not the old ones: a version is known in full from an insert or a replacement still in the oplog, or when it is the current document.`);
  if (v.state === 'unknown') notes.push("The document at this point isn't known: it was rebuilt neither from an insert or replacement in the oplog nor back from the current document.");
  if (v.mismatch) notes.push(`This write doesn't fit the version before as rebuilt (${v.mismatch}): some writes are missing from the part of the oplog read.`);
  if (v.mongoster) notes.push(`Written from Mongoster: ${v.mongoster}.`);
  for (const n of notes) box.append(span(n, 'note'));

  if (v.diff.length) box.append(diffTable(v.diff));
  else if (v.kind === 'update' && v.state !== 'unknown') box.append(span('No field changed.', 'note'));
  if (v.doc !== undefined) {
    const details = document.createElement('details');
    details.open = !v.diff.length;
    const summary = document.createElement('summary');
    summary.textContent = v.state === 'partial' ? 'Document after this write (partial)' : 'Document after this write';
    const pre = document.createElement('pre');
    fill(pre, prettyShell(v.doc, 0, 100));
    details.append(summary, pre);
    box.append(details);
  }
  return box;
}

function renderList(): void {
  const list = el('list');
  list.replaceChildren();
  if (!result) return;
  if (!result.versions.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = result.complete
      ? `No write to this document is left in the oplog: it was last written before ${result.oplogFirst ? localTime(result.oplogFirst) : 'the oplog starts'}.`
      : 'No write to this document in the part of the oplog read: Load older reads further back.';
    list.append(p);
    return;
  }
  if (result.conflict) {
    list.append(
      span(
        'Some writes rebuilt from an insert lead to a different document than the one there is now (writes missing from the oplog read, or made while reading): those versions are shown from the current document instead.',
        'note conflict',
      ),
    );
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of ['time', 'write', 'changes', 'by', 'version', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const v of result.versions) {
    const row = body.insertRow();
    row.className = `entry k-${v.kind}${expanded.has(v.key) ? ' expanded' : ''}`;
    row.title = 'Click to show the version and what changed';
    const time = row.insertCell();
    time.className = 'time';
    time.textContent = localTime(v.time);
    time.title = `${v.time}\n${v.ts}`;
    const kind = row.insertCell();
    kind.className = 'kind';
    kind.textContent = KIND_LABELS[v.kind];
    const what = row.insertCell();
    what.className = 'what';
    what.textContent = changesText(v);
    what.title = what.textContent;
    const by = row.insertCell();
    by.className = 'by-cell';
    by.append(...byCell(v));
    const state = row.insertCell();
    state.className = 'state-cell';
    const badge = stateBadge(v);
    if (badge) state.append(badge);
    const act = row.insertCell();
    act.className = 'action';
    const restore = restoreButton(v, 'Restore');
    if (restore) act.append(restore);
    row.addEventListener('click', () => {
      if (expanded.has(v.key)) expanded.delete(v.key);
      else expanded.add(v.key);
      renderList();
    });
    if (expanded.has(v.key)) {
      const d = body.insertRow();
      d.className = 'detail';
      const c = d.insertCell();
      c.colSpan = 6;
      c.append(detail(v));
    }
  }
  list.append(table);
  if (result.complete && result.before !== 'absent') {
    list.append(span('Older versions are no longer in the oplog.', 'note end'));
  }
}

function setLoading(on: boolean): void {
  loading = on;
  document.body.classList.toggle('loading', on);
  el<HTMLButtonElement>('refresh').disabled = on;
  renderWindow();
}

// ---------------------------------------------------------------------------
// Messages

window.addEventListener('message', (event: MessageEvent<DocHistoryHostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      info = m.info;
      renderHeader();
      renderList();
      break;
    case 'loading':
      if (!m.older) showError(null);
      setLoading(true);
      if (m.older) el('moreInfo').textContent = 'Reading older entries of the oplog…';
      break;
    case 'result': {
      const first = !result;
      result = m;
      for (const k of [...expanded]) if (!m.versions.some((v) => v.key === k)) expanded.delete(k);
      // The newest write shows what it changed right away.
      if (first && m.versions.length) expanded.add(m.versions[0].key);
      showError(null);
      setLoading(false);
      renderList();
      break;
    }
    case 'error':
      result = undefined;
      setLoading(false);
      showError(m.message);
      renderList();
      break;
    case 'restored':
      if (m.message) showMessage(m.message, !m.ok);
      break;
  }
});

el('refresh').addEventListener('click', () => {
  showMessage('');
  post({ type: 'refresh' });
});
el('older').addEventListener('click', () => post({ type: 'loadOlder' }));
el('open').addEventListener('click', () => post({ type: 'openDocument' }));

setLoading(true);
post({ type: 'ready' });
