// Compare Structure tab: the differences between two databases grouped by collection, each with its
// definitions side by side and its steps; the script that makes the right database like the left one.
import type { FieldDiff } from '../shared/compare';
import type { StructureHostMessage, StructureSide, StructureViewMessage } from '../shared/messages';
import { prettyShell } from '../shared/query';
import { StructureCounts, StructureDiff, StructureKind, diffTitle, stepLines, structureScript } from '../shared/structure';

declare function acquireVsCodeApi(): { postMessage(m: StructureViewMessage): void; getState(): Partial<State> | undefined; setState(s: State): void };

type Side = 'left' | 'right';
type KindFilter = StructureKind | 'any';

interface State {
  /** Also what is the same on both sides. */
  all: boolean;
  kind: KindFilter;
  /** Destructive steps not commented out in the script. */
  drops: boolean;
}

const vscode = acquireVsCodeApi();
const state: State = { all: false, kind: 'any', drops: false, ...vscode.getState() };
const save = () => vscode.setState(state);
const post = (m: StructureViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let sides: Record<Side, StructureSide> | undefined;
let diffs: StructureDiff[] = [];
let counts: StructureCounts | undefined;
let notes: string[] = [];
let durationMs = 0;
let running = false;
let compared = false;
/** The result of the last change, kept over the comparison that follows it. */
let notice: { text: string; failed: boolean } | undefined;
const expanded = new Set<string>();
const collapsed = new Set<string>();

const KIND_LABELS: Record<StructureKind, string> = { same: 'Same', different: 'Different', onlyLeft: 'Only left', onlyRight: 'Only right' };
const KIND_CLASSES: Record<StructureKind, string> = { same: 'k-identical', different: 'k-different', onlyLeft: 'k-onlyLeft', onlyRight: 'k-onlyRight' };
const fmt = (n: number) => n.toLocaleString('en-US');
const where = (s: StructureSide) => `${s.connectionName} › ${s.database}`;

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

function compare(): void {
  el('error').classList.add('hidden');
  post({ type: 'compare' });
  setRunning(true, 'Reading the structures…');
}

function setRunning(on: boolean, text?: string): void {
  running = on;
  el<HTMLButtonElement>('compare').disabled = on;
  el<HTMLButtonElement>('swap').disabled = on;
  if (text !== undefined) showMessage(text);
  renderBulk();
  renderList();
}

function showMessage(text: string, failed = false): void {
  const m = el('message');
  m.textContent = text;
  m.classList.toggle('hidden', !text);
  m.classList.toggle('failed', failed);
}

/** Whether the difference has a step that a command can do. */
const applicable = (d: StructureDiff) => d.kind !== 'same' && d.steps.some((s) => s.op);

function script(list: StructureDiff[]): string {
  if (!sides) return '';
  return structureScript(list, { database: sides.right.database, left: where(sides.left), right: where(sides.right), drops: state.drops });
}

function apply(ids: string[] | null): void {
  post({ type: 'apply', ids });
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
    box.append(span(side === 'left' ? 'Left · model' : 'Right · changed by the script', 'side-label'), span(s.database, 'side-ns'), span(s.connectionName, 'side-conn'));
    if (s.readOnly) {
      const b = span('read-only', 'badge');
      b.title = s.why ?? '';
      box.append(b);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary, buttons and list

function renderSummary(): void {
  const summary = el('summary');
  summary.replaceChildren();
  if (!counts) return;
  const c = counts;
  const total = c.different + c.onlyLeft + c.onlyRight;
  const chip = (kind: StructureKind, label: string, n: number) => {
    const b = document.createElement('button');
    b.className = `chip ${KIND_CLASSES[kind]}`;
    b.append(span(fmt(n), 'chip-n'), document.createTextNode(` ${label}`));
    b.setAttribute('aria-pressed', String(state.kind === kind));
    b.disabled = !n;
    b.title = kind === 'same' ? 'Show only what is the same' : `Show only what is ${label}`;
    b.addEventListener('click', () => {
      state.kind = state.kind === kind ? 'any' : kind;
      if (state.kind === 'same') state.all = true;
      save();
      renderSummary();
      renderBulk();
      renderList();
    });
    summary.append(b);
  };
  chip('same', 'same', c.same);
  chip('different', 'different', c.different);
  chip('onlyLeft', 'only left', c.onlyLeft);
  chip('onlyRight', 'only right', c.onlyRight);
  summary.append(span(total ? `${fmt(total)} difference${total === 1 ? '' : 's'} · ${(durationMs / 1000).toFixed(1)} s` : `The structures are the same · ${(durationMs / 1000).toFixed(1)} s`, 'info'));
  const box = el('notes');
  box.replaceChildren(...notes.map((n) => span(n, 'note')));
  box.classList.toggle('hidden', !notes.length);
}

function renderBulk(): void {
  const bulk = el('bulk');
  bulk.classList.toggle('hidden', !sides || !counts);
  if (!sides || !counts) return;
  el('showDiffs').setAttribute('aria-selected', String(!state.all));
  el('showAll').setAttribute('aria-selected', String(state.all));
  el<HTMLInputElement>('drops').checked = state.drops;
  const any = diffs.some((d) => d.kind !== 'same' && d.steps.length);
  for (const id of ['copyScript', 'openPlayground']) el<HTMLButtonElement>(id).disabled = running || !any;
  const all = el<HTMLButtonElement>('applyAll');
  all.disabled = running || sides.right.readOnly || !diffs.some(applicable);
  all.title = sides.right.readOnly ? (sides.right.why ?? 'Read-only') : (all.dataset.title ?? all.title);
}

function shown(d: StructureDiff): boolean {
  if (state.kind !== 'any') return d.kind === state.kind;
  return state.all || d.kind !== 'same';
}

function valueCell(row: HTMLTableRowElement, f: FieldDiff, side: Side): void {
  const c = row.insertCell();
  c.className = `value ${side}`;
  if (!(side in f)) {
    c.textContent = '—';
    c.classList.add('missing');
    c.title = 'Missing on this side';
  } else c.textContent = prettyShell(f[side], 0, 70);
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
    row.className = !('left' in f) ? 'added' : !('right' in f) ? 'removed' : 'changed';
    const name = row.insertCell();
    name.className = 'field';
    name.textContent = f.path;
    valueCell(row, f, 'left');
    valueCell(row, f, 'right');
  }
  return table;
}

/** The definitions of both sides next to each other. */
function sideBySide(d: StructureDiff): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'sbs';
  for (const side of ['left', 'right'] as const) {
    const col = document.createElement('div');
    col.className = `sbs-col ${side}`;
    col.append(span(side === 'left' ? 'Left' : 'Right', 'sbs-label'));
    const pre = document.createElement('pre');
    const value = d[side];
    if (value === undefined) {
      pre.textContent = '—';
      pre.className = 'missing';
    } else pre.textContent = prettyShell(value, 0, 60);
    col.append(pre);
    grid.append(col);
  }
  return grid;
}

function applyButton(d: StructureDiff, label = 'Apply…'): HTMLButtonElement | undefined {
  if (!sides || !applicable(d)) return undefined;
  const right = sides.right;
  const destructive = d.steps.some((s) => s.op && s.destructive);
  const b = button(label, 'small secondary', () => apply([d.id]), right.readOnly ? right.why : destructive ? 'Change the right database, dropping something (after a confirmation)' : 'Change the right database (after a confirmation)');
  b.disabled = running || right.readOnly;
  return b;
}

function detail(d: StructureDiff): HTMLElement {
  const box = document.createElement('div');
  box.className = 'detail-box';
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const text = sides ? stepLines(d.steps, sides.right.database, state.drops).join('\n') : '';
  if (text) actions.append(button('Copy Script', 'small secondary', () => post({ type: 'copy', text: `${text}\n` }), 'Copy the steps of this difference'));
  const b = applyButton(d);
  if (b) actions.append(b);
  if (d.kind === 'same') actions.append(span('The same on both sides', 'info'));
  else if (!d.steps.some((s) => s.op)) actions.append(span("No command can do this: the script says what to do", 'info'));
  if (actions.childElementCount) box.append(actions);
  if (d.fields?.length) box.append(diffTable(d.fields));
  box.append(sideBySide(d));
  if (text) {
    const pre = document.createElement('pre');
    pre.className = 'script';
    pre.textContent = text;
    box.append(span('Steps on the right', 'sbs-label'), pre);
  }
  return box;
}

function renderList(): void {
  const list = el('list');
  list.replaceChildren();
  if (!counts) return;
  const visible = diffs.filter(shown);
  if (!visible.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = counts.different + counts.onlyLeft + counts.onlyRight ? 'Nothing of this kind.' : 'No differences: the collections, options and indexes are the same on both sides.';
    list.append(p);
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of ['', 'object', 'differences', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  const groups = new Map<string, StructureDiff[]>();
  for (const d of visible) groups.set(d.collection, [...(groups.get(d.collection) ?? []), d]);
  for (const [collection, items] of groups) {
    const all = diffs.filter((d) => d.collection === collection);
    const differing = all.filter((d) => d.kind !== 'same').length;
    const g = body.insertRow();
    g.className = `group${collapsed.has(collection) ? ' collapsed' : ''}`;
    g.title = 'Click to collapse or expand';
    const c = g.insertCell();
    c.colSpan = 3;
    const type = all[0]?.collectionType;
    c.append(
      span(collapsed.has(collection) ? '▸ ' : '▾ ', 'twisty'),
      span(collection, 'group-name'),
      span(type === 'view' ? ' view' : type === 'timeseries' ? ' time series' : '', 'info'),
      span(differing ? ` · ${differing} difference${differing === 1 ? '' : 's'}` : ' · same', 'info'),
    );
    const act = g.insertCell();
    act.className = 'action';
    const actionable = all.filter(applicable);
    if (sides && actionable.length > 1) {
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      const b = button('Apply…', 'small secondary', () => apply(actionable.map((d) => d.id)), sides.right.readOnly ? sides.right.why : `Apply the ${actionable.length} differences of ${collection} to the right database`);
      b.disabled = running || sides.right.readOnly;
      wrap.append(b);
      act.append(wrap);
    }
    g.addEventListener('click', () => {
      if (collapsed.has(collection)) collapsed.delete(collection);
      else collapsed.add(collection);
      renderList();
    });
    if (collapsed.has(collection)) continue;
    for (const d of items) {
      const row = body.insertRow();
      row.className = `entry ${KIND_CLASSES[d.kind]}${expanded.has(d.id) ? ' expanded' : ''}`;
      row.title = 'Click to show the details';
      const kind = row.insertCell();
      kind.className = 'kind';
      kind.textContent = KIND_LABELS[d.kind];
      const obj = row.insertCell();
      obj.className = 'id';
      obj.textContent = diffTitle(d);
      const what = row.insertCell();
      what.className = 'what';
      what.textContent = d.summary;
      what.title = d.summary;
      const actCell = row.insertCell();
      actCell.className = 'action';
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      const b = applyButton(d);
      if (b) wrap.append(b);
      actCell.append(wrap);
      row.addEventListener('click', () => {
        if (expanded.has(d.id)) expanded.delete(d.id);
        else expanded.add(d.id);
        renderList();
      });
      if (expanded.has(d.id)) {
        const dr = body.insertRow();
        dr.className = 'detail';
        const cell = dr.insertCell();
        cell.colSpan = 4;
        cell.append(detail(d));
      }
    }
  }
  list.append(table);
}

// ---------------------------------------------------------------------------
// Messages

window.addEventListener('message', (event: MessageEvent<StructureHostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'init': {
      const first = !sides;
      sides = { left: m.left, right: m.right };
      renderSides();
      renderBulk();
      renderList();
      if (first && !compared && !running) compare();
      break;
    }
    case 'progress':
      if (!running) setRunning(true);
      showMessage(m.text);
      break;
    case 'result':
      compared = true;
      diffs = m.diffs;
      counts = m.counts;
      notes = m.notes;
      durationMs = m.durationMs;
      for (const k of [...expanded]) if (!diffs.some((d) => d.id === k)) expanded.delete(k);
      if (state.kind !== 'any' && !counts[state.kind]) state.kind = 'any';
      setRunning(false, notice?.text ?? '');
      if (notice) showMessage(notice.text, notice.failed);
      notice = undefined;
      renderSummary();
      renderBulk();
      renderList();
      break;
    case 'error':
      setRunning(false, notice?.text ?? '');
      notice = undefined;
      el('error').textContent = m.message;
      el('error').classList.remove('hidden');
      break;
    case 'applied':
      if (m.message) showMessage(m.message, !m.ok);
      notice = m.message ? { text: m.message, failed: !m.ok } : undefined;
      if (m.comparing) setRunning(true);
      break;
  }
});

// ---------------------------------------------------------------------------
// Controls

el('compare').addEventListener('click', () => {
  if (!running) compare();
});
el('swap').addEventListener('click', () => {
  if (running) return;
  expanded.clear();
  collapsed.clear();
  setRunning(true, 'Swapping the sides…');
  post({ type: 'swap' });
  compare();
});
el('showDiffs').addEventListener('click', () => {
  state.all = false;
  if (state.kind === 'same') state.kind = 'any';
  save();
  renderSummary();
  renderBulk();
  renderList();
});
el('showAll').addEventListener('click', () => {
  state.all = true;
  save();
  renderBulk();
  renderList();
});
el<HTMLInputElement>('drops').addEventListener('change', () => {
  state.drops = el<HTMLInputElement>('drops').checked;
  save();
  renderList();
});
el('copyScript').addEventListener('click', () => post({ type: 'copy', text: script(diffs) }));
el('openPlayground').addEventListener('click', () => post({ type: 'openPlayground', script: script(diffs) }));
el('applyAll').dataset.title = el('applyAll').title;
el('applyAll').addEventListener('click', () => apply(null));

post({ type: 'ready' });
