import { isEjsonWrapper, isPlainObject, mergeCondition, parseQuery, prettyShell, toShell } from '../shared/query';
import type { HostMessage, WebviewMessage } from '../shared/messages';
import type { PipelineStage } from '../shared/pipeline';
import { HistoryPopover } from './history';
import { PipelineEditor } from './pipeline';
import {
  ColumnNode,
  MAX_ELEMENTS,
  MISSING,
  buildColumns,
  expandableBelow,
  getAt,
  isSubdocument,
  leafCount,
  leaves,
  rowHeight,
  valueAtPath,
} from '../shared/columns';
import { CellEditor } from './cellEditor';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): Partial<QueryState> | undefined;
  setState(state: QueryState): void;
};

type Mode = 'find' | 'aggregate';

interface QueryState {
  mode: Mode;
  stages: PipelineStage[];
  /** Stage whose output is previewed, or null for the whole pipeline. */
  previewUpto: number | null;
  filter: string;
  sort: string;
  projection: string;
  limit: number;
  skip: number;
  /** Dotted paths of expanded sub-document columns. */
  expanded: string[];
}

/** `within`: the array a dragged element field belongs to; its conditions go into an $elemMatch. */
type DragPayload = { kind: 'cell'; key: string; value: unknown; within?: string } | { kind: 'column'; key: string };

interface DropZone {
  label: string;
  title: string;
  condition: (p: DragPayload) => unknown;
}

const vscode = acquireVsCodeApi();
const state: QueryState = {
  mode: 'find',
  stages: [],
  previewUpto: null,
  filter: '',
  sort: '',
  projection: '',
  limit: 50,
  skip: 0,
  expanded: [],
  ...vscode.getState(),
};
let expanded = new Set(state.expanded);

let docs: Record<string, unknown>[] = [];
let count: number | null = null;
let currentRequest = 0;
let drag: DragPayload | null = null;
let selectedCell: HTMLTableCellElement | null = null;
let openDocIndex = -1;
const columnsByKey = new Map<string, ColumnNode>();
/** Cell to select again after the grid re-renders (e.g. after an inline edit). */
let reselect: { row: number; path: string; elem?: string } | null = null;
let readOnly = false;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const filterInput = el<HTMLTextAreaElement>('filter');
const sortInput = el<HTMLInputElement>('sort');
const projectionInput = el<HTMLInputElement>('projection');
const limitSelect = el<HTMLSelectElement>('limit');
const grid = el<HTMLTableElement>('grid');
const dropzones = el('dropzones');
const pipelineDrop = el('pipelineDrop');
const modal = el('modal');

// ---------------------------------------------------------------------------
// Querying

function run(resetSkip = false): void {
  state.limit = Number(limitSelect.value);
  if (resetSkip) state.skip = 0;
  if (state.mode === 'aggregate') {
    runAggregate();
    return;
  }
  state.filter = filterInput.value;
  state.sort = sortInput.value;
  state.projection = projectionInput.value;

  let invalid = false;
  for (const input of [filterInput, sortInput, projectionInput]) {
    const ok = isValidObject(input.value);
    input.classList.toggle('invalid', !ok);
    invalid ||= !ok;
  }
  if (invalid) {
    showError('Invalid query syntax — check the highlighted field.');
    return;
  }

  vscode.setState(state);
  currentRequest++;
  setLoading(true);
  vscode.postMessage({
    type: 'query',
    requestId: currentRequest,
    filter: state.filter,
    sort: state.sort,
    projection: state.projection,
    skip: state.skip,
    limit: state.limit,
  });
}

function runAggregate(): void {
  if (!pipeline.prepare()) return;
  pipeline.markError(null);
  savePipelineState();
  currentRequest++;
  setLoading(true);
  vscode.postMessage({
    type: 'aggregate',
    requestId: currentRequest,
    stages: pipeline.stages,
    upto: pipeline.upto,
    skip: state.skip,
    limit: state.limit,
  });
}

function savePipelineState(): void {
  state.stages = pipeline.stages;
  state.previewUpto = pipeline.previewUpto;
  vscode.setState(state);
}

function setMode(mode: Mode, runNow = true): void {
  state.mode = mode;
  document.body.classList.toggle('mode-aggregate', mode === 'aggregate');
  el('modeFind').setAttribute('aria-selected', String(mode === 'find'));
  el('modeAggregate').setAttribute('aria-selected', String(mode === 'aggregate'));
  vscode.setState(state);
  if (!runNow) return;
  showError(null);
  run(true);
}

function isValidObject(text: string): boolean {
  if (!text.trim()) return true;
  try {
    return isPlainObject(parseQuery(text));
  } catch {
    return false;
  }
}

function setLoading(loading: boolean): void {
  document.body.classList.toggle('loading', loading);
}

function showError(message: string | null): void {
  const box = el('error');
  box.textContent = message ?? '';
  box.classList.toggle('hidden', !message);
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      el('ns').innerHTML = '';
      el('ns').append(
        span('ns-conn', m.connectionName),
        span('ns-sep', ' › '),
        span('ns-db', m.database),
        span('ns-sep', ' › '),
        span('ns-coll', m.collection),
      );
      readOnly = m.readOnly;
      if (m.expanded.length) expanded = new Set(m.expanded);
      document.body.classList.toggle('readonly', readOnly);
      el('docEdit').textContent = readOnly ? 'Open in editor' : 'Edit';
      if (readOnly) el('docEdit').title = el('docEdit').dataset.title = 'Open in a read-only editor tab';
      run();
      break;
    case 'refresh':
      run();
      break;
    case 'history':
      history.update(m.recent, m.saved);
      break;
    case 'fieldResult':
      pendingFields.get(m.requestId)?.(m.ok ? undefined : m.message ?? 'Not saved');
      pendingFields.delete(m.requestId);
      break;
    case 'result':
      if (m.requestId !== currentRequest) return;
      setLoading(false);
      showError(null);
      docs = m.docs as Record<string, unknown>[];
      count = m.count;
      el('empty').textContent =
        m.note ?? (state.mode === 'aggregate' ? 'The pipeline returned no documents.' : 'No documents match this query.');
      renderGrid();
      renderStatus(m.durationMs);
      if (m.note) el('status').textContent = `${m.note} · ${m.durationMs} ms`;
      if (openDocIndex >= 0) {
        if (openDocIndex < docs.length) openDocument(openDocIndex);
        else closeDocument();
      }
      break;
    case 'error':
      if (m.requestId !== currentRequest) return;
      setLoading(false);
      showError(m.message);
      if (m.stage !== undefined) pipeline.markError(m.stage);
      break;
  }
});

// ---------------------------------------------------------------------------
// Grid


function typeClass(v: unknown): string {
  if (v === null || v === undefined) return 't-null';
  if (Array.isArray(v)) return 't-array';
  switch (typeof v) {
    case 'string':
      return 't-string';
    case 'number':
      return 't-number';
    case 'boolean':
      return 't-bool';
  }
  if (isEjsonWrapper(v)) {
    const key = Object.keys(v)[0];
    if (key === '$oid') return 't-oid';
    if (key === '$date' || key === '$timestamp') return 't-date';
    if (key.startsWith('$number')) return 't-number';
    if (key === '$regularExpression') return 't-regex';
    return 't-special';
  }
  return 't-object';
}

function cellText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}] ${toShell(v)}`;
  if (isPlainObject(v) && !isEjsonWrapper(v)) return `{${Object.keys(v).length}} ${toShell(v)}`;
  return toShell(v);
}

function currentSort(): Record<string, unknown> {
  if (state.mode === 'aggregate') return pipeline.currentSort();
  try {
    const v = sortInput.value.trim() ? parseQuery(sortInput.value) : {};
    return isPlainObject(v) ? v : {};
  } catch {
    return {};
  }
}

function renderGrid(): void {
  const columns = buildColumns(docs, expanded);
  const leafList = leaves(columns);
  const sort = currentSort();
  selectedCell = null;
  cellEditor.close();
  grid.replaceChildren();
  el('empty').classList.toggle('hidden', docs.length > 0);
  if (!docs.length) return;

  const thead = grid.createTHead();
  const headRow = thead.insertRow();
  const corner = document.createElement('th');
  corner.className = 'rownum';
  corner.textContent = '#';
  headRow.append(corner);
  for (const leaf of leafList) {
    const { node } = leaf;
    const th = document.createElement('th');
    th.dataset.key = node.key;
    th.draggable = true;
    th.title = `${node.key}\nClick to sort · drag to the filter`;
    groupClasses(th, leaf.starts.length > 0, leaf.ends.length > 0);
    // Parent segments of an expanded column: click one to collapse that group.
    node.path.slice(0, -1).forEach((segment, i) => {
      const prefix = span('col-prefix', `${segment}${node.arrayDepth === i + 1 ? '[]' : ''}.`);
      prefix.dataset.collapse = node.path.slice(0, i + 1).join('.');
      prefix.title = `Collapse ${prefix.dataset.collapse}`;
      th.append(prefix);
    });
    th.append(span('col-name', node.path[node.path.length - 1]));
    if (node.expandable && !node.children) {
      const expander = span('expander', node.array ? '▸[]' : '▸');
      expander.dataset.expand = node.key;
      expander.title = node.array
        ? `Expand the elements of ${node.key} into columns, one sub-row per element (Alt+click: expand all levels)`
        : `Expand ${node.key} into columns (Alt+click: expand all levels)`;
      th.append(expander);
    }
    const dir = sort[node.key];
    if (dir === 1 || dir === -1) th.append(span('sort-indicator', dir === 1 ? ' ▲' : ' ▼'));
    headRow.append(th);
  }

  // Index of the first leaf under each column, for the group borders.
  const firstLeaf = new Map<ColumnNode, number>();
  columnsByKey.clear();
  let n = 0;
  const index = (nodes: ColumnNode[]) => {
    for (const node of nodes) {
      firstLeaf.set(node, n);
      columnsByKey.set(node.key, node);
      if (node.children) index(node.children);
      else n++;
    }
  };
  index(columns);

  docs.forEach((doc, rowIndex) => {
    // One tbody per document: expanded arrays add a sub-row per element.
    const tbody = grid.createTBody();
    const height = rowHeight(doc, columns);
    const rows = Array.from({ length: height }, () => {
      const tr = tbody.insertRow();
      tr.dataset.row = String(rowIndex);
      return tr;
    });
    const num = rows[0].insertCell();
    num.className = 'rownum';
    num.rowSpan = height;
    num.title = 'Open document';
    num.append(span('expand', '{ }'), document.createTextNode(String(state.skip + rowIndex + 1)));

    /** A leaf, or an expanded group whose value here can't be expanded: one cell spanning the group. */
    const addCell = (tr: HTMLTableRowElement, node: ColumnNode, value: unknown, rowSpan: number, elem?: number) => {
      const width = leafCount(node);
      const first = leafList[firstLeaf.get(node)!];
      const last = leafList[firstLeaf.get(node)! + width - 1];
      const td = tr.insertCell();
      td.colSpan = width;
      td.rowSpan = rowSpan;
      td.dataset.path = JSON.stringify(node.path);
      if (elem !== undefined) {
        td.dataset.elem = String(elem);
        td.dataset.depth = String(node.arrayDepth ?? node.path.length);
      }
      if (value === MISSING) {
        td.className = 'missing';
      } else {
        const text = cellText(value);
        td.className = typeClass(value);
        if (node.children) {
          td.classList.add('mixed');
          td.title =
            elem !== undefined && node.array
              ? `This element of ${node.key} is not a sub-document\n`
              : `${node.key} is not ${node.array ? 'an array of sub-documents' : 'a sub-document'} here\n`;
        }
        td.textContent = text.length > 300 ? text.slice(0, 300) + '…' : text;
        td.title = (td.title ?? '') + (text.length > 2000 ? text.slice(0, 2000) + '…' : text);
        td.draggable = true;
      }
      if (elem !== undefined) td.classList.add('elem');
      groupClasses(td, first.starts.length > 0, last.ends.length > 0);
      return td;
    };

    /** Cells of `nodes`, with values read from `source` (the document, or an array element at path length `base`). */
    const renderNodes = (nodes: ColumnNode[], source: unknown, base: number, tr: HTMLTableRowElement, rowSpan: number, elem?: number) => {
      for (const node of nodes) {
        const value = getAt(source, node.path.slice(base));
        if (node.children && isSubdocument(value)) renderNodes(node.children, source, base, tr, rowSpan, elem);
        else if (node.children && node.array && elem === undefined && Array.isArray(value) && value.length) renderElements(node, value);
        else addCell(tr, node, value, rowSpan, elem);
      }
    };

    const renderElements = (node: ColumnNode, array: unknown[]) => {
      const shown = Math.min(array.length, MAX_ELEMENTS);
      for (let i = 0; i < shown; i++) {
        const element = array[i];
        if (isSubdocument(element)) renderNodes(node.children!, element, node.path.length, rows[i], 1, i);
        else addCell(rows[i], node, element, 1, i);
      }
      let next = shown;
      if (array.length > shown) {
        const more = addCell(rows[next++], node, MISSING, 1);
        more.classList.replace('missing', 'more');
        more.textContent = `… ${array.length - shown} more elements — open the document to see all`;
      }
      if (next < height) addCell(rows[next], node, MISSING, height - next).classList.add('filler');
    };

    renderNodes(columns, doc, 0, rows[0], height);
  });

  if (reselect) {
    const { row, path, elem } = reselect;
    reselect = null;
    const td = [...(grid.tBodies[row]?.querySelectorAll<HTMLTableCellElement>('td[data-path]') ?? [])].find(
      (c) => c.dataset.path === path && c.dataset.elem === elem,
    );
    if (td) selectCell(td);
  }
}

function groupClasses(cell: HTMLElement, start: boolean, end: boolean): void {
  if (start) cell.classList.add('group-start');
  if (end) cell.classList.add('group-end');
}

function setExpanded(keys: string[], on: boolean): void {
  for (const key of keys) {
    if (on) expanded.add(key);
    else expanded.delete(key);
  }
  state.expanded = [...expanded];
  vscode.setState(state);
  vscode.postMessage({ type: 'saveExpanded', expanded: state.expanded });
  renderGrid();
}

function renderStatus(durationMs: number): void {
  const from = docs.length ? state.skip + 1 : 0;
  const to = state.skip + docs.length;
  const total = count === null ? '?' : count.toLocaleString();
  el('range').textContent = `${from.toLocaleString()}–${to.toLocaleString()} of ${total}`;
  el('status').textContent = `${docs.length} document${docs.length === 1 ? '' : 's'} · ${durationMs} ms`;
  el<HTMLButtonElement>('prev').disabled = state.skip === 0;
  el<HTMLButtonElement>('next').disabled = count !== null ? to >= count : docs.length < state.limit;
}

function cellValue(td: HTMLElement): { key: string; value: unknown; within?: string } | null {
  const tr = td.closest('tr');
  if (!tr?.dataset.row || !td.dataset.path) return null;
  const path = JSON.parse(td.dataset.path) as string[];
  const doc = docs[Number(tr.dataset.row)];
  if (td.dataset.elem === undefined) {
    const value = getAt(doc, path);
    return value === MISSING ? null : { key: path.join('.'), value };
  }
  // A field of an array element: the array, the element, then the path inside the element.
  const depth = Number(td.dataset.depth);
  const array = getAt(doc, path.slice(0, depth));
  if (!Array.isArray(array)) return null;
  const element = array[Number(td.dataset.elem)];
  const value = path.length === depth ? element : getAt(element, path.slice(depth));
  if (value === MISSING) return null;
  return { key: path.join('.'), value, within: path.length > depth ? path.slice(0, depth).join('.') : undefined };
}

/** "items[].sku" for a field of an array element, else the dotted key. */
function displayKey(p: DragPayload): string {
  return p.kind === 'cell' && p.within ? `${p.within}[].${p.key.slice(p.within.length + 1)}` : p.key;
}

grid.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const collapse = target.closest<HTMLElement>('[data-collapse]');
  if (collapse) {
    setExpanded([collapse.dataset.collapse!], false);
    return;
  }
  const expand = target.closest<HTMLElement>('[data-expand]');
  if (expand) {
    const key = expand.dataset.expand!;
    const node = columnsByKey.get(key);
    setExpanded(e.altKey && node ? expandableBelow(docs, node) : [key], true);
    return;
  }
  const th = target.closest('th');
  if (th?.dataset.key) {
    toggleSort(th.dataset.key);
    return;
  }
  const td = target.closest('td');
  if (!td) return;
  if (td.classList.contains('rownum')) {
    openDocument(Number(td.closest('tr')!.dataset.row));
    return;
  }
  selectCell(td);
});

function selectCell(td: HTMLTableCellElement): void {
  selectedCell?.classList.remove('selected');
  selectedCell = td;
  td.classList.add('selected');
}

// Double-click edits the value in place where possible, otherwise opens the document.
grid.addEventListener('dblclick', (e) => {
  const td = (e.target as HTMLElement).closest('td');
  if (td && !td.classList.contains('rownum') && startEdit(td)) return;
  const tr = (e.target as HTMLElement).closest('tbody tr') as HTMLTableRowElement | null;
  if (tr?.dataset.row) openDocument(Number(tr.dataset.row));
});

// ---------------------------------------------------------------------------
// Inline editing

const cellEditor = new CellEditor(el('gridWrap'));
const pendingFields = new Map<number, (error: string | undefined) => void>();
let fieldRequest = 0;

/** The document and full path (with array indexes) a cell edits, or null when it can't be edited in place. */
function editTarget(td: HTMLElement): { row: number; doc: Record<string, unknown>; path: string[]; original: unknown } | null {
  if (state.mode !== 'find' || readOnly) return null;
  const tr = td.closest('tr');
  if (!tr?.dataset.row || !td.dataset.path || td.classList.contains('more') || td.classList.contains('filler')) return null;
  const row = Number(tr.dataset.row);
  const doc = docs[row];
  if (!doc || !('_id' in doc)) return null;
  let path = JSON.parse(td.dataset.path) as string[];
  if (path[0] === '_id') return null;
  if (td.dataset.elem !== undefined) {
    const depth = Number(td.dataset.depth);
    path = [...path.slice(0, depth), td.dataset.elem, ...path.slice(depth)];
  }
  return { row, doc, path, original: valueAtPath(doc, path) };
}

function startEdit(td: HTMLTableCellElement): boolean {
  const target = editTarget(td);
  if (!target) return false;
  const { row, doc, path, original } = target;
  const missing = original === MISSING;
  const text = missing ? '' : isPlainObject(original) || Array.isArray(original) ? prettyShell(original, 0, 60) : toShell(original);
  const quoted = typeof original === 'string';
  selectCell(td);
  cellEditor.open(td, text, quoted ? [1, text.length - 1] : [0, text.length], {
    save: (value) =>
      new Promise((resolve) => {
        const requestId = ++fieldRequest;
        pendingFields.set(requestId, resolve);
        reselect = { row, path: td.dataset.path!, elem: td.dataset.elem };
        vscode.postMessage({
          type: 'updateField',
          requestId,
          id: doc._id,
          path,
          original: missing ? undefined : original,
          missing,
          value,
        });
      }),
  });
  return true;
}

function toggleSort(key: string): void {
  if (state.mode === 'aggregate') {
    pipeline.toggleSort(key);
    return;
  }
  const dir = currentSort()[key];
  sortInput.value = dir === 1 ? toShell({ [key]: -1 }) : dir === -1 ? '' : toShell({ [key]: 1 });
  run(true);
}

// ---------------------------------------------------------------------------
// Drag & drop into the filter

const COMPARABLE = new Set(['t-number', 't-date', 't-string']);

function zonesFor(p: DragPayload): DropZone[] {
  if (p.kind === 'column') {
    return [
      { label: 'exists', title: `${p.key}: { $exists: true }`, condition: () => ({ $exists: true }) },
      { label: 'missing', title: `${p.key}: { $exists: false }`, condition: () => ({ $exists: false }) },
      { label: 'is null', title: `${p.key}: null`, condition: () => null },
    ];
  }
  const zones: DropZone[] = [
    { label: '= equals', title: 'Match this exact value', condition: (d) => (d as { value: unknown }).value },
    { label: '≠ not equal', title: '$ne', condition: (d) => ({ $ne: (d as { value: unknown }).value }) },
  ];
  if (COMPARABLE.has(typeClass(p.value))) {
    zones.push(
      { label: '≥ from', title: '$gte (combines with ≤ for a range)', condition: (d) => ({ $gte: (d as { value: unknown }).value }) },
      { label: '≤ to', title: '$lte (combines with ≥ for a range)', condition: (d) => ({ $lte: (d as { value: unknown }).value }) },
    );
  }
  if (Array.isArray(p.value) && p.value.length) {
    zones.push({ label: '∈ in', title: '$in: any of these values', condition: (d) => ({ $in: (d as { value: unknown }).value }) });
  }
  return zones;
}

function showDropzones(p: DragPayload): void {
  const aggregate = state.mode === 'aggregate';
  const container = aggregate ? document.createElement('div') : dropzones;
  if (aggregate) {
    container.className = 'dz-row';
    pipelineDrop.replaceChildren(span('dz-caption', `Drop to add the condition ${pipeline.dropTarget()}`), container);
  }
  dropzones.replaceChildren();
  for (const zone of zonesFor(p)) {
    const div = document.createElement('div');
    div.className = 'dropzone';
    div.title = zone.title;
    div.append(span('dz-label', zone.label), span('dz-key', displayKey(p)));
    if (p.kind === 'cell' && p.within) div.title += ` · same element of ${p.within} ($elemMatch)`;
    div.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      div.classList.add('over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      if (drag) addCondition(drag.key, zone.condition(drag), drag.kind === 'cell' ? drag.within : undefined);
      endDrag();
    });
    container.append(div);
  }
  document.body.classList.add('dragging');
}

function endDrag(): void {
  drag = null;
  document.body.classList.remove('dragging');
  dropzones.replaceChildren();
  pipelineDrop.replaceChildren();
}

grid.addEventListener('dragstart', (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'TH' && target.dataset.key) {
    drag = { kind: 'column', key: target.dataset.key };
  } else if (target.tagName === 'TD') {
    const cell = cellValue(target);
    if (!cell) return;
    drag = { kind: 'cell', ...cell };
  } else {
    return;
  }
  const label = drag.kind === 'cell' ? `${displayKey(drag)}: ${toShell(drag.value)}` : drag.key;
  e.dataTransfer!.setData('text/plain', label);
  e.dataTransfer!.effectAllowed = 'copy';
  showDropzones(drag);
});

grid.addEventListener('dragend', endDrag);

function addCondition(key: string, condition: unknown, within?: string): void {
  if (state.mode === 'aggregate') {
    pipeline.addCondition(key, condition, within);
    return;
  }
  try {
    filterInput.value = mergeCondition(filterInput.value, key, condition, within);
  } catch (err) {
    showError(`Fix the filter before adding conditions by drag & drop: ${(err as Error).message}`);
    filterInput.classList.add('invalid');
    return;
  }
  autosize();
  flash(el('filterWrap'));
  run(true);
}

function flash(node: HTMLElement): void {
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

// ---------------------------------------------------------------------------
// Document dialog

function openDocument(index: number): void {
  if (index < 0 || index >= docs.length) return;
  openDocIndex = index;
  const doc = docs[index];
  el('docTitle').textContent = `Document ${state.skip + index + 1}${'_id' in doc ? ' · ' + toShell(doc._id) : ''}`;
  el<HTMLButtonElement>('docPrev').disabled = index === 0;
  el<HTMLButtonElement>('docNext').disabled = index === docs.length - 1;
  for (const id of ['docEdit', 'docDelete']) {
    const button = el<HTMLButtonElement>(id);
    button.disabled = !('_id' in doc);
    button.dataset.title ??= button.title;
    button.title = '_id' in doc ? button.dataset.title : 'Not available: the document has no _id (excluded by the projection?)';
  }
  const body = el('docBody');
  body.replaceChildren(jsonNode(null, doc, true, 0));
  body.scrollTop = 0;
  modal.classList.remove('hidden');
  el('docClose').focus();
}

function closeDocument(): void {
  modal.classList.add('hidden');
  openDocIndex = -1;
}

function jsonNode(key: string | null, value: unknown, last: boolean, depth: number): HTMLElement {
  const comma = last ? '' : ',';
  const isContainer = Array.isArray(value) || (isPlainObject(value) && !isEjsonWrapper(value));
  const keyPart = () => (key === null ? [] : [span('jkey', key), span('jpunc', ': ')]);

  if (!isContainer) {
    const leaf = document.createElement('div');
    leaf.className = 'jleaf';
    leaf.append(...keyPart(), span(typeClass(value), toShell(value)), span('jpunc', comma));
    return leaf;
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];

  const node = document.createElement('div');
  node.className = 'jnode';
  if (depth >= 3 && entries.length > 0) node.classList.add('collapsed');

  const head = document.createElement('div');
  head.className = 'jhead';
  const toggle = span('jtoggle', '');
  head.append(toggle, ...keyPart(), span('jpunc', open));
  const summary = `${entries.length} ${isArray ? 'item' : 'field'}${entries.length === 1 ? '' : 's'}`;
  head.append(span('jsummary', ` ${summary} `), span('jpunc jsummary', close + comma));
  if (!entries.length) {
    head.append(span('jpunc', close + comma));
    node.classList.add('empty');
  }
  head.addEventListener('click', () => node.classList.toggle('collapsed'));
  node.append(head);

  if (entries.length) {
    const children = document.createElement('div');
    children.className = 'jchildren';
    entries.forEach(([k, v], i) =>
      children.append(jsonNode(isArray ? null : k, v, i === entries.length - 1, depth + 1)),
    );
    const tail = document.createElement('div');
    tail.className = 'jtail';
    tail.append(span('jpunc', close + comma));
    node.append(children, tail);
  }
  return node;
}

el('docClose').addEventListener('click', closeDocument);
el('docPrev').addEventListener('click', () => openDocument(openDocIndex - 1));
el('docNext').addEventListener('click', () => openDocument(openDocIndex + 1));
el('docExpand').addEventListener('click', () =>
  el('docBody').querySelectorAll('.jnode').forEach((n) => n.classList.remove('collapsed')),
);
el('docCollapse').addEventListener('click', () =>
  el('docBody').querySelectorAll('.jchildren .jnode').forEach((n) => n.classList.add('collapsed')),
);
el('docCopy').addEventListener('click', () => {
  if (openDocIndex >= 0) vscode.postMessage({ type: 'copy', text: toShell(docs[openDocIndex], 2) });
});
el('docEdit').addEventListener('click', () => {
  if (openDocIndex >= 0) vscode.postMessage({ type: 'editDocument', id: docs[openDocIndex]._id });
});
el('docDuplicate').addEventListener('click', () => {
  if (openDocIndex >= 0) vscode.postMessage({ type: 'duplicateDocument', doc: docs[openDocIndex] });
});
el('docDelete').addEventListener('click', () => {
  if (openDocIndex >= 0) vscode.postMessage({ type: 'deleteDocument', id: docs[openDocIndex]._id });
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeDocument();
});

// ---------------------------------------------------------------------------
// Toolbar & keyboard

function autosize(): void {
  filterInput.style.height = 'auto';
  const borders = filterInput.offsetHeight - filterInput.clientHeight;
  filterInput.style.height = `${Math.min(filterInput.scrollHeight + borders, 240)}px`;
}

el('run').addEventListener('click', () => run(true));
el('insert').addEventListener('click', () => vscode.postMessage({ type: 'insertDocument' }));
el('export').addEventListener('click', () => {
  // Exports what the table shows: the last query run, or the pipeline up to the previewed stage.
  if (state.mode === 'aggregate' && !pipeline.prepare()) return;
  vscode.postMessage({
    type: 'export',
    source:
      state.mode === 'aggregate'
        ? { kind: 'aggregate', stages: pipeline.stages, upto: pipeline.upto }
        : { kind: 'find', filter: state.filter, sort: state.sort, projection: state.projection },
    expanded: [...expanded],
    page: { skip: state.skip, limit: state.limit },
    count,
  });
});
el('reset').addEventListener('click', () => {
  filterInput.value = sortInput.value = projectionInput.value = '';
  autosize();
  run(true);
});
el('prev').addEventListener('click', () => {
  state.skip = Math.max(0, state.skip - state.limit);
  run();
});
el('next').addEventListener('click', () => {
  state.skip += state.limit;
  run();
});
limitSelect.addEventListener('change', () => run(true));
filterInput.addEventListener('input', () => {
  autosize();
  filterInput.classList.remove('invalid');
});
for (const input of [sortInput, projectionInput]) {
  input.addEventListener('input', () => input.classList.remove('invalid'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run(true);
  });
}
filterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run(true);
  }
});

document.addEventListener('keydown', (e) => {
  if (!modal.classList.contains('hidden')) {
    if (e.key === 'Escape') closeDocument();
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') openDocument(openDocIndex - 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') openDocument(openDocIndex + 1);
    else return;
    e.preventDefault();
    return;
  }
  const inField = (e.target as HTMLElement).closest('input, textarea, select');
  if (inField || !selectedCell) return;
  if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
    const cell = cellValue(selectedCell);
    if (cell) vscode.postMessage({ type: 'copy', text: toShell(cell.value) });
    e.preventDefault();
  } else if (e.key === 'F2') {
    e.preventDefault();
    startEdit(selectedCell);
  } else if (e.key === 'Enter') {
    openDocument(Number(selectedCell.closest('tr')!.dataset.row));
  } else if (e.key === 'Delete' && !readOnly && state.mode === 'find') {
    const doc = docs[Number(selectedCell.closest('tr')!.dataset.row)];
    if (doc && '_id' in doc) vscode.postMessage({ type: 'deleteDocument', id: doc._id });
  }
});

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

// ---------------------------------------------------------------------------
// History

const history = new HistoryPopover({
  apply(q) {
    if (q.pipeline) {
      pipeline.setStages(q.pipeline);
      setMode('aggregate');
      return;
    }
    filterInput.value = q.filter;
    sortInput.value = q.sort;
    projectionInput.value = q.projection;
    autosize();
    setMode('find');
  },
  save: (q) =>
    vscode.postMessage({
      type: 'saveQuery',
      query: { filter: q.filter, sort: q.sort, projection: q.projection, ...(q.pipeline && { pipeline: q.pipeline }) },
    }),
  remove: (id) => vscode.postMessage({ type: 'removeQuery', id }),
  clear: () => vscode.postMessage({ type: 'clearHistory' }),
  current: () =>
    state.mode === 'aggregate'
      ? { filter: '', sort: '', projection: '', pipeline: pipeline.prepare() ? pipeline.stages : [] }
      : { filter: filterInput.value, sort: sortInput.value, projection: projectionInput.value },
  notify: showError,
});

// ---------------------------------------------------------------------------
// Aggregation pipeline

const pipeline = new PipelineEditor({
  run: () => run(true),
  changed: savePipelineState,
  notify: showError,
  copy: (text) => vscode.postMessage({ type: 'copy', text }),
});
el('modeFind').addEventListener('click', () => state.mode !== 'find' && setMode('find'));
el('modeAggregate').addEventListener('click', () => state.mode !== 'aggregate' && setMode('aggregate'));

// ---------------------------------------------------------------------------
// Boot

filterInput.value = state.filter;
sortInput.value = state.sort;
projectionInput.value = state.projection;
limitSelect.value = String(state.limit);
pipeline.setStages(state.stages, state.previewUpto);
setMode(state.mode, false);
new ResizeObserver(autosize).observe(filterInput.parentElement!);
vscode.postMessage({ type: 'ready' });
