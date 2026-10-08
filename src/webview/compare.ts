// Compare tab: two collections side by side, their differences by _id and the buttons to copy documents
// from one side to the other.
import type { CompareCounts, CompareOptions, DiffKind, FieldDiff } from '../shared/compare';
import { fieldsSummary, parseIgnore } from '../shared/compare';
import type { CompareEntry, CompareHostMessage, CompareSide, CompareViewMessage } from '../shared/messages';
import { prettyShell, toShell } from '../shared/query';

declare function acquireVsCodeApi(): { postMessage(m: CompareViewMessage): void; getState(): Partial<State> | undefined; setState(s: State): void };

type Side = 'left' | 'right';
type Shown = DiffKind | 'all';

interface State {
  filter: string;
  ignore: string;
  ignoreOrder: boolean;
  numbersByValue: boolean;
  shown: Shown;
}

const vscode = acquireVsCodeApi();
const state: State = { filter: '', ignore: '', ignoreOrder: true, numbersByValue: true, shown: 'all', ...vscode.getState() };
const save = () => vscode.setState(state);
const post = (m: CompareViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let sides: Record<Side, CompareSide> | undefined;
let counts: CompareCounts | undefined;
let entries: CompareEntry[] = [];
let durationMs = 0;
let running = false;
let compared = false;
/** The result of the last write, kept over the comparison that follows it. */
let notice: { text: string; failed: boolean } | undefined;
const expanded = new Set<string>();
/** Full documents of the entries on one side only, by `${side}:${key}`. */
const documents = new Map<string, { doc?: unknown; error?: string }>();

const KIND_LABELS: Record<DiffKind, string> = { different: 'Different', onlyLeft: 'Only left', onlyRight: 'Only right' };
const fmt = (n: number) => n.toLocaleString('en-US');
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

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

function options(): CompareOptions {
  return { filter: state.filter.trim(), ignore: parseIgnore(state.ignore), ignoreOrder: state.ignoreOrder, numbersByValue: state.numbersByValue };
}

function compare(): void {
  el('error').classList.add('hidden');
  post({ type: 'compare', options: options() });
  setRunning(true, 'Reading the left side…');
}

function setRunning(on: boolean, text?: string): void {
  running = on;
  el('compare').classList.toggle('hidden', on);
  el('cancel').classList.toggle('hidden', !on);
  el<HTMLButtonElement>('swap').disabled = on;
  if (text !== undefined) showMessage(text);
  renderBulk();
}

function showMessage(text: string, failed = false): void {
  const m = el('message');
  m.textContent = text;
  m.classList.toggle('hidden', !text);
  m.classList.toggle('failed', failed);
}

// ---------------------------------------------------------------------------
// Header

function renderSides(): void {
  if (!sides) return;
  for (const side of ['left', 'right'] as const) {
    const s = sides[side];
    const box = el(`${side}Side`);
    box.replaceChildren();
    if (s.color) box.dataset.color = s.color;
    else delete box.dataset.color;
    box.append(span(side === 'left' ? 'Left' : 'Right', 'side-label'), span(`${s.database}.${s.collection}`, 'side-ns'), span(s.connectionName, 'side-conn'));
    if (s.readOnly) {
      const b = span('read-only', 'badge');
      b.title = s.why ?? '';
      box.append(b);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary and list

function renderSummary(): void {
  const summary = el('summary');
  summary.replaceChildren();
  if (!counts) return;
  const c = counts;
  const total = c.different + c.onlyLeft + c.onlyRight;
  const chip = (shown: Shown | null, label: string, n: number, className: string) => {
    const b = document.createElement('button');
    b.className = `chip ${className}`;
    b.append(span(fmt(n), 'chip-n'), document.createTextNode(` ${label}`));
    if (shown === null) b.disabled = true;
    else {
      b.setAttribute('aria-pressed', String(state.shown === shown));
      b.disabled = shown !== 'all' && !n;
      b.addEventListener('click', () => {
        state.shown = state.shown === shown ? 'all' : shown;
        save();
        renderSummary();
        renderList();
      });
    }
    summary.append(b);
  };
  chip(null, 'identical', c.identical, 'k-identical');
  chip('different', 'different', c.different, 'k-different');
  chip('onlyLeft', 'only left', c.onlyLeft, 'k-onlyLeft');
  chip('onlyRight', 'only right', c.onlyRight, 'k-onlyRight');
  summary.append(
    span(
      total
        ? `${fmt(total)} difference${total === 1 ? '' : 's'} · ${(durationMs / 1000).toFixed(1)} s`
        : `The collections are the same${state.filter.trim() ? ' for the filter' : ''} · ${(durationMs / 1000).toFixed(1)} s`,
      'info',
    ),
  );
}

function renderBulk(): void {
  const bulk = el('bulk');
  const total = counts ? counts.different + counts.onlyLeft + counts.onlyRight : 0;
  bulk.classList.toggle('hidden', !sides || !total);
  if (!sides || !counts) return;
  for (const [id, to] of [
    ['toRight', 'right'],
    ['toLeft', 'left'],
  ] as const) {
    const b = el<HTMLButtonElement>(id);
    const target = sides[to];
    b.disabled = running || target.readOnly;
    b.title = target.readOnly ? (target.why ?? 'Read-only') : b.dataset.title ?? b.title;
  }
  const shownCount = entries.filter((e) => state.shown === 'all' || e.kind === state.shown).length;
  const ofKind = state.shown === 'all' ? total : counts[state.shown];
  el('shownInfo').textContent = shownCount < ofKind ? `Showing the first ${fmt(shownCount)} of ${fmt(ofKind)}; the buttons above apply to all of them.` : '';
}

/** The row's buttons: copy the document to the other side, or delete it where the other side lacks it. */
function rowActions(e: CompareEntry): HTMLElement[] {
  if (!sides) return [];
  const action = (to: Side, label: string, title: string) => {
    const target = sides![to];
    const b = button(label, 'small secondary', () => apply(to, [e.key]), target.readOnly ? target.why : title);
    b.disabled = running || target.readOnly;
    return b;
  };
  switch (e.kind) {
    case 'different':
      return [action('right', '→ Right', 'Replace the right document with the left one'), action('left', '← Left', 'Replace the left document with the right one')];
    case 'onlyLeft':
      return [action('right', '→ Right', 'Insert the document into the right collection'), action('left', 'Delete', 'Delete the document from the left collection')];
    case 'onlyRight':
      return [action('right', 'Delete', 'Delete the document from the right collection'), action('left', '← Left', 'Insert the document into the left collection')];
  }
}

function apply(to: Side, keys: string[] | null): void {
  post({ type: 'apply', to, keys });
}

function valueCell(row: HTMLTableRowElement, f: FieldDiff, side: Side): void {
  const c = row.insertCell();
  c.className = `value ${side}`;
  if (!(side in f)) {
    c.textContent = '—';
    c.classList.add('missing');
    c.title = 'The field is missing';
  } else {
    c.textContent = prettyShell(f[side], 0, 70);
    if (f.types) c.append(span(` ${f.types[side === 'left' ? 0 : 1]}`, 'type'));
  }
}

function diffTable(fields: FieldDiff[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'diff';
  const head = table.createTHead().insertRow();
  for (const label of ['field', 'left', 'right']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const f of fields) {
    const row = body.insertRow();
    row.className = !('left' in f) && !('right' in f) ? 'order' : !('left' in f) ? 'added' : !('right' in f) ? 'removed' : 'changed';
    const name = row.insertCell();
    name.className = 'field';
    name.textContent = f.path;
    if (row.className === 'order') {
      const c = row.insertCell();
      c.colSpan = 2;
      c.className = 'value missing';
      c.textContent = 'Same fields and values in a different order';
      continue;
    }
    valueCell(row, f, 'left');
    valueCell(row, f, 'right');
  }
  return table;
}

function detail(e: CompareEntry): HTMLElement {
  const box = document.createElement('div');
  box.className = 'detail-box';
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const open = (side: Side) =>
    button(`Open ${side === 'left' ? 'Left' : 'Right'}`, 'small secondary', () => post({ type: 'openDocument', key: e.key, side }), `Open the ${side} document in an editor`);
  if (e.kind === 'different') {
    actions.append(open('left'), open('right'));
    box.append(actions, diffTable(e.fields ?? []));
    return box;
  }
  const side: Side = e.kind === 'onlyLeft' ? 'left' : 'right';
  const loaded = documents.get(`${side}:${e.key}`);
  actions.append(open(side));
  if (loaded?.doc !== undefined) actions.append(button('Copy', 'small secondary', () => post({ type: 'copy', text: prettyShell(loaded.doc, 0, 100) }), 'Copy the document'));
  actions.append(span(`Missing on the ${other(side)} side`, 'info'));
  box.append(actions);
  const pre = document.createElement('pre');
  if (!loaded) {
    pre.textContent = 'Loading…';
    pre.className = 'loading';
    post({ type: 'loadDocument', key: e.key, side });
    documents.set(`${side}:${e.key}`, {});
  } else if (loaded.error) {
    pre.textContent = loaded.error;
    pre.className = 'failed';
  } else if (loaded.doc === undefined) {
    pre.textContent = 'Loading…';
    pre.className = 'loading';
  } else pre.textContent = prettyShell(loaded.doc, 0, 100);
  box.append(pre);
  return box;
}

function renderList(): void {
  const list = el('list');
  list.replaceChildren();
  renderBulk();
  if (!counts) return;
  const shown = entries.filter((e) => state.shown === 'all' || e.kind === state.shown);
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = counts.different + counts.onlyLeft + counts.onlyRight ? 'Nothing of this kind.' : 'No differences.';
    list.append(p);
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of ['', '_id', 'differences', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const e of shown) {
    const row = body.insertRow();
    row.className = `entry k-${e.kind}${expanded.has(e.key) ? ' expanded' : ''}`;
    row.title = 'Click to show the details';
    const kind = row.insertCell();
    kind.className = 'kind';
    kind.textContent = KIND_LABELS[e.kind];
    const id = row.insertCell();
    id.className = 'id';
    id.textContent = toShell(e.id);
    const what = row.insertCell();
    what.className = 'what';
    what.textContent = e.kind === 'different' ? fieldsSummary(e.fields ?? []) : (e.preview ?? '');
    const act = row.insertCell();
    act.className = 'action';
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    wrap.append(...rowActions(e));
    act.append(wrap);
    row.addEventListener('click', () => {
      if (expanded.has(e.key)) expanded.delete(e.key);
      else expanded.add(e.key);
      renderList();
    });
    if (expanded.has(e.key)) {
      const d = body.insertRow();
      d.className = 'detail';
      const c = d.insertCell();
      c.colSpan = 4;
      c.append(detail(e));
    }
  }
  list.append(table);
}

// ---------------------------------------------------------------------------
// Messages

window.addEventListener('message', (event: MessageEvent<CompareHostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'init': {
      const first = !sides;
      sides = { left: m.left, right: m.right };
      if (m.options) {
        state.filter = m.options.filter;
        state.ignore = m.options.ignore.join(', ');
        state.ignoreOrder = m.options.ignoreOrder;
        state.numbersByValue = m.options.numbersByValue;
      }
      syncInputs();
      renderSides();
      renderBulk();
      renderList();
      if (first && !compared && !running) compare();
      break;
    }
    case 'progress':
      if (!running) setRunning(true);
      showMessage(
        m.phase === 'left'
          ? `Reading the left side… ${fmt(m.left)} documents`
          : m.phase === 'right'
            ? `Comparing with the right side… ${fmt(m.right)} of ${fmt(m.left)}+ documents`
            : `Reading the differences… (${fmt(m.left)} left, ${fmt(m.right)} right documents)`,
      );
      break;
    case 'result':
      compared = true;
      counts = m.counts;
      entries = m.entries;
      durationMs = m.durationMs;
      documents.clear();
      for (const k of [...expanded]) if (!entries.some((e) => e.key === k)) expanded.delete(k);
      if (state.shown !== 'all' && !counts[state.shown]) state.shown = 'all';
      setRunning(false, notice?.text ?? '');
      if (notice) showMessage(notice.text, notice.failed);
      notice = undefined;
      renderSummary();
      renderList();
      break;
    case 'error':
      setRunning(false, notice?.text ?? '');
      notice = undefined;
      el('error').textContent = m.message;
      el('error').classList.remove('hidden');
      break;
    case 'cancelled':
      setRunning(false, 'Comparison cancelled.');
      break;
    case 'document':
      documents.set(`${m.side}:${m.key}`, { doc: m.doc, error: m.error });
      renderList();
      break;
    case 'applied':
      if (m.message) showMessage(m.message, !m.ok);
      notice = m.message ? { text: m.message, failed: !m.ok } : undefined;
      if (m.ok) setRunning(true);
      break;
  }
});

// ---------------------------------------------------------------------------
// Controls

const filter = el<HTMLInputElement>('filter');
const ignore = el<HTMLInputElement>('ignore');
const ignoreOrder = el<HTMLInputElement>('ignoreOrder');
const numbersByValue = el<HTMLInputElement>('numbersByValue');

function syncInputs(): void {
  filter.value = state.filter;
  ignore.value = state.ignore;
  ignoreOrder.checked = state.ignoreOrder;
  numbersByValue.checked = state.numbersByValue;
}

for (const input of [filter, ignore]) {
  input.addEventListener('input', () => {
    state.filter = filter.value;
    state.ignore = ignore.value;
    save();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !running) compare();
  });
}
for (const input of [ignoreOrder, numbersByValue]) {
  input.addEventListener('change', () => {
    state.ignoreOrder = ignoreOrder.checked;
    state.numbersByValue = numbersByValue.checked;
    save();
    if (compared && !running) compare();
  });
}
el('compare').addEventListener('click', compare);
el('cancel').addEventListener('click', () => post({ type: 'cancel' }));
el('swap').addEventListener('click', () => {
  if (running) return;
  expanded.clear();
  setRunning(true, 'Swapping the sides…');
  post({ type: 'swap' });
  compare();
});
for (const id of ['toRight', 'toLeft']) el(id).dataset.title = el(id).title;
el('toRight').addEventListener('click', () => apply('right', null));
el('toLeft').addEventListener('click', () => apply('left', null));

syncInputs();
post({ type: 'ready' });
