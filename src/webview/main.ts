import { isEjsonWrapper, isPlainObject, mergeCondition, parseQuery, prettyShell, toShell } from '../shared/query';
import type { HostMessage, QuerySource, WebviewMessage } from '../shared/messages';
import type { PipelineStage } from '../shared/pipeline';
import { HistoryPopover } from './history';
import { PipelineEditor } from './pipeline';
import { IndexesView } from './indexes';
import { ExplainView } from './explainView';
import { BulkDialog, BulkOp } from './bulk';
import { CodeDialog, toCodeQuery } from './codeDialog';
import { ChartView } from './chartView';
import { ChartSpec, chartStages } from '../shared/chart';
import type { CodeLanguage } from '../shared/codegen';
import { SchemaView } from './schemaView';
import {
  ColumnLayout,
  ColumnNode,
  MAX_ELEMENTS,
  applyLayout,
  pinnedLeafCount,
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
import { ColumnMenu, ColumnsPanel, LayoutActions } from './columnsUi';
import { Completer } from './autocomplete';
import { CompletionKind, FieldHint, fieldHints } from '../shared/complete';
import { analyzeSchema } from '../shared/schema';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): Partial<QueryState> | undefined;
  setState(state: QueryState): void;
};

type Mode = 'find' | 'aggregate' | 'schema' | 'indexes' | 'chart';

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
  /** Documents sampled by the schema analysis. */
  schemaSize?: number;
  codeLanguage?: CodeLanguage;
  codeProgram?: boolean;
  chart?: ChartSpec;
  /** Data of the chart: the filter or the pipeline. */
  chartSource?: 'find' | 'aggregate';
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
let collectionName = '';
let databaseName = '';
/** Stage whose output the grid shows (aggregate mode), or -1 for documents of the collection. */
let docsUpto = -1;
let requestedUpto = -1;

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
  if (state.mode === 'indexes') {
    indexesView.setLoading();
    vscode.postMessage({ type: 'loadIndexes' });
    return;
  }
  if (state.mode === 'schema') {
    runSchema();
    return;
  }
  if (state.mode === 'chart') {
    runChart();
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
  requestedUpto = -1;
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

function runSchema(): void {
  const ok = isValidObject(filterInput.value);
  filterInput.classList.toggle('invalid', !ok);
  if (!ok) {
    showError('Invalid query syntax — check the highlighted field.');
    return;
  }
  showError(null);
  state.filter = filterInput.value;
  state.schemaSize = Number(schemaSize.value);
  vscode.setState(state);
  schemaRequest++;
  setLoading(true);
  schemaView.loading();
  vscode.postMessage({ type: 'analyzeSchema', requestId: schemaRequest, filter: state.filter, size: state.schemaSize });
}

function runAggregate(): void {
  if (!pipeline.prepare()) return;
  pipeline.markError(null);
  savePipelineState();
  currentRequest++;
  requestedUpto = pipeline.upto;
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
  // The chart draws what the previous tab showed: the filter's documents or the pipeline's output.
  if (mode === 'chart' && (state.mode === 'aggregate' || state.mode === 'find')) setChartSource(state.mode);
  state.mode = mode;
  if (mode === 'indexes' && el<HTMLButtonElement>('modeIndexes').disabled) mode = state.mode = 'find';
  document.body.classList.toggle('mode-aggregate', mode === 'aggregate');
  document.body.classList.toggle('mode-indexes', mode === 'indexes');
  document.body.classList.toggle('mode-schema', mode === 'schema');
  document.body.classList.toggle('mode-chart', mode === 'chart');
  el('modeSchema').setAttribute('aria-selected', String(mode === 'schema'));
  el('modeChart').setAttribute('aria-selected', String(mode === 'chart'));
  el('run').textContent = mode === 'schema' ? 'Analyze' : mode === 'chart' ? 'Draw' : 'Find';
  el('run').title = mode === 'chart' ? 'Draw the chart (Ctrl+Enter)' : 'Run query (Ctrl+Enter)';
  el('modeFind').setAttribute('aria-selected', String(mode === 'find'));
  el('modeAggregate').setAttribute('aria-selected', String(mode === 'aggregate'));
  el('modeIndexes').setAttribute('aria-selected', String(mode === 'indexes'));
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
      collectionName = m.collection;
      databaseName = m.database;
      el('ns').innerHTML = '';
      el('ns').append(
        span('ns-conn', m.connectionName),
        span('ns-sep', ' › '),
        span('ns-db', m.database),
        span('ns-sep', ' › '),
        span('ns-coll', m.collection),
      );
      if (m.view || m.locked) {
        const badge = span('ns-badge', m.locked ? 'read-only' : 'view');
        badge.title = m.locked ? 'The connection is read-only: no changes are made through it' : 'Views are read-only';
        el('ns').append(badge);
      }
      document.body.classList.toggle('locked', m.locked);
      document.body.classList.toggle('view', m.view);
      if (m.color) document.body.dataset.color = m.color;
      else delete document.body.dataset.color;
      readOnly = m.readOnly;
      if (m.expanded.length) expanded = new Set(m.expanded);
      layout = m.layout ?? {};
      columnsPanel.update();
      document.body.classList.toggle('readonly', readOnly);
      el('docEdit').textContent = readOnly ? 'Open in editor' : 'Edit';
      el('docEdit').title = el('docEdit').dataset.title = readOnly
        ? 'Open in a read-only editor tab'
        : 'Open in an editor tab (Ctrl+S saves to the database)';
      el<HTMLButtonElement>('modeIndexes').disabled = m.view;
      el('modeIndexes').title = m.view ? 'Views use the indexes of their source collection' : 'Indexes of the collection';
      if (m.view && state.mode === 'indexes') setMode('find', false);
      run();
      fieldsOfCollection();
      break;
    case 'refresh':
      fieldsState = 'none';
      run();
      break;
    case 'fields':
      collectionFields = m.fields;
      fieldsState = 'loaded';
      completer.refresh();
      break;
    case 'history':
      history.update(m.recent, m.saved);
      break;
    case 'indexes':
      indexesView.render(m.indexes, m.error);
      break;
    case 'schema':
      if (m.requestId !== schemaRequest) break;
      setLoading(false);
      schemaView.show(m);
      break;
    case 'chartData': {
      const pending = chartPending;
      if (m.requestId !== chartRequest || !pending) break;
      setLoading(false);
      if (m.error) {
        chartView.showError();
        showError(m.error);
        break;
      }
      void chartView.show(pending.spec, m.rows ?? [], m.durationMs ?? 0, pending.source.kind === 'find');
      break;
    }
    case 'indexResult':
      pendingIndex.get(m.requestId)?.(m.ok ? undefined : m.message ?? 'Failed');
      pendingIndex.delete(m.requestId);
      break;
    case 'bulkCount':
      bulk.onCount(m);
      break;
    case 'bulkResult':
      bulk.onResult(m);
      break;
    case 'explainResult':
      if (m.requestId === explainRequest) explainView.show(m);
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
      docsUpto = requestedUpto;
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

/** The user's column arrangement (hidden, order, pinned, widths), remembered per collection. */
let layout: ColumnLayout = {};
/** All columns of the page before the layout is applied (for the Columns panel). */
let allColumns: ColumnNode[] = [];

function renderGrid(): void {
  allColumns = buildColumns(docs, expanded);
  const columns = applyLayout(allColumns, layout);
  const leafList = leaves(columns);
  const widths = layout.widths ?? {};
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
  leafList.forEach((leaf, leafIndex) => {
    const { node } = leaf;
    const th = document.createElement('th');
    th.dataset.key = node.key;
    th.dataset.leaf = String(leafIndex);
    th.draggable = true;
    th.title = `${node.key}\nClick to sort · drag to the filter or onto another column · right-click for options`;
    if (widths[node.key]) setWidth(th, widths[node.key], true);
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
    const resize = span('col-resize', '');
    resize.title = 'Drag to resize · double-click for automatic width';
    th.append(resize);
    headRow.append(th);
  });

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
      td.dataset.leaf = String(firstLeaf.get(node));
      if (width === 1) {
        td.dataset.col = node.key;
        if (widths[node.key]) setWidth(td, widths[node.key], false);
      }
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
  pinColumns(pinnedLeafCount(columns, layout));
  columnsPanel.update();

  if (reselect) {
    const { row, path, elem } = reselect;
    reselect = null;
    const td = [...(grid.tBodies[row]?.querySelectorAll<HTMLTableCellElement>('td[data-path]') ?? [])].find(
      (c) => c.dataset.path === path && c.dataset.elem === elem,
    );
    if (td) selectCell(td);
  }
}

// ---------------------------------------------------------------------------
// Column layout: widths, pinned columns, reordering, hiding

function setWidth(cell: HTMLElement, px: number, header: boolean): void {
  cell.style.maxWidth = `${px}px`;
  if (header) cell.style.width = cell.style.minWidth = `${px}px`;
}

/** Keeps the first `count` leaf columns (and the row numbers) in place while scrolling sideways. */
function pinColumns(count: number): void {
  grid.classList.toggle('has-pinned', count > 0);
  if (!count) return;
  const head = grid.tHead!.rows[0];
  const lefts: number[] = [];
  let left = head.cells[0].offsetWidth;
  for (let i = 0; i < count; i++) {
    lefts.push(left);
    left += head.cells[i + 1].offsetWidth;
  }
  grid.querySelectorAll<HTMLTableCellElement>('th[data-leaf], td[data-leaf]').forEach((cell) => {
    const i = Number(cell.dataset.leaf);
    const pinned = i < count;
    cell.classList.toggle('pinned', pinned);
    cell.classList.toggle('pinned-last', pinned && i + cell.colSpan === count);
    cell.style.left = pinned ? `${lefts[i]}px` : '';
  });
}

function saveLayout(next: ColumnLayout): void {
  layout = next;
  vscode.postMessage({ type: 'saveLayout', layout });
  renderGrid();
}

const layoutActions = new LayoutActions({ columns: () => allColumns, layout: () => layout, change: saveLayout });
const columnsPanel = new ColumnsPanel({ columns: () => allColumns, layout: () => layout, change: saveLayout }, layoutActions);
const columnMenu = new ColumnMenu({ columns: () => allColumns, layout: () => layout, change: saveLayout }, layoutActions, () => columnsPanel.open());

grid.addEventListener('contextmenu', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-key]');
  if (!th) return;
  e.preventDefault();
  columnMenu.open(e.clientX, e.clientY, th.dataset.key!);
});

// Dragging a header onto another one moves the column there (among its siblings).
function headerDropSide(e: DragEvent): { th: HTMLElement; after: boolean } | null {
  if (drag?.kind !== 'column') return null;
  const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-key]');
  if (!th || th.dataset.key === drag.key) return null;
  const rect = th.getBoundingClientRect();
  return { th, after: e.clientX > rect.left + rect.width / 2 };
}
function clearDropMarks(): void {
  grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
}
grid.addEventListener('dragover', (e) => {
  const side = headerDropSide(e);
  clearDropMarks();
  if (!side) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  side.th.classList.add(side.after ? 'drop-after' : 'drop-before');
});
grid.addEventListener('dragleave', clearDropMarks);
grid.addEventListener('drop', (e) => {
  const side = headerDropSide(e);
  clearDropMarks();
  if (!side || drag?.kind !== 'column') return;
  e.preventDefault();
  const source = drag.key;
  endDrag();
  if (!layoutActions.move(source, side.th.dataset.key!, side.after)) {
    showError(`${source} can only be moved among the columns at its level.`);
  }
});

// Resizing: drag the right edge of a header.
let resizing = false;
grid.addEventListener('pointerdown', (e) => {
  const handle = (e.target as HTMLElement).closest('.col-resize');
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const th = handle.closest('th')!;
  const key = th.dataset.key!;
  const startX = e.clientX;
  const startWidth = th.getBoundingClientRect().width;
  const cells = [...grid.querySelectorAll<HTMLElement>(`td[data-col="${CSS.escape(key)}"]`)];
  let width = startWidth;
  th.draggable = false;
  resizing = true;
  document.body.classList.add('resizing');
  const move = (ev: PointerEvent) => {
    width = Math.max(40, Math.round(startWidth + ev.clientX - startX));
    setWidth(th, width, true);
    cells.forEach((c) => setWidth(c, width, false));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('resizing');
    th.draggable = true;
    // The click that ends the drag must not sort.
    setTimeout(() => (resizing = false));
    if (width !== startWidth) saveLayout({ ...layout, widths: { ...layout.widths, [key]: width } });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
grid.addEventListener(
  'click',
  (e) => {
    if (resizing || (e.target as HTMLElement).closest('.col-resize')) e.stopImmediatePropagation();
  },
  true,
);
grid.addEventListener('dblclick', (e) => {
  const handle = (e.target as HTMLElement).closest('.col-resize');
  if (!handle) return;
  e.stopImmediatePropagation();
  layoutActions.resetWidth(handle.closest('th')!.dataset.key!);
}, true);

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
  // Columns can also be moved onto another header.
  e.dataTransfer!.effectAllowed = drag.kind === 'column' ? 'copyMove' : 'copy';
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
    layout,
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
  if (explainView.isOpen || bulk.isOpen || codeDialog.isOpen) {
    if (e.key === 'Escape') {
      if (explainView.isOpen) explainView.close();
      else if (codeDialog.isOpen) codeDialog.close();
      else bulk.close();
      e.preventDefault();
    }
    return;
  }
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

// ---------------------------------------------------------------------------
// Autocompletion

const completer = new Completer();
let collectionFields: FieldHint[] = [];
let fieldsState: 'none' | 'loading' | 'loaded' = 'none';
let resultFields: { docs: unknown[]; hints: FieldHint[] } | null = null;

/** Fields of a sample of the collection, loaded on first use (and again after the documents changed). */
function fieldsOfCollection(): FieldHint[] {
  if (fieldsState === 'none') {
    fieldsState = 'loading';
    vscode.postMessage({ type: 'loadFields' });
  }
  return collectionFields;
}

/** Fields at the input of stage `index`: the grid's documents when they are the previous stage's output. */
function fieldsBefore(index: number): FieldHint[] {
  if (index > 0 && state.mode === 'aggregate' && docsUpto === index - 1 && docs.length) {
    if (resultFields?.docs !== docs) resultFields = { docs, hints: fieldHints(analyzeSchema(docs)) };
    return resultFields.hints;
  }
  return fieldsOfCollection();
}

const completeWith = (field: HTMLTextAreaElement | HTMLInputElement, kind: CompletionKind) => {
  completer.attach(field, { kind: () => kind, fields: fieldsOfCollection });
  field.addEventListener('focus', fieldsOfCollection);
};
completeWith(filterInput, 'filter');
completeWith(sortInput, 'sort');
completeWith(projectionInput, 'project');
completeWith(el<HTMLTextAreaElement>('pipelineText'), 'pipeline');
completeWith(el<HTMLTextAreaElement>('bulkUpdate'), 'update');
completeWith(el<HTMLInputElement>('indexKeys'), 'index');

const pipeline = new PipelineEditor({
  run: () => run(true),
  changed: savePipelineState,
  notify: showError,
  copy: (text) => vscode.postMessage({ type: 'copy', text }),
  attachCompletion: (field, stage, index) => {
    completer.attach(field, { kind: () => ({ stage: stage.op }), fields: () => fieldsBefore(index) });
    field.addEventListener('focus', () => fieldsBefore(index));
  },
});
el('modeFind').addEventListener('click', () => state.mode !== 'find' && setMode('find'));
el('watch').addEventListener('click', () => vscode.postMessage({ type: 'watch' }));
el('modeIndexes').addEventListener('click', () => state.mode !== 'indexes' && setMode('indexes'));
el('modeSchema').addEventListener('click', () => state.mode !== 'schema' && setMode('schema'));
el('modeChart').addEventListener('click', () => state.mode !== 'chart' && setMode('chart'));

// ---------------------------------------------------------------------------
// Schema

let schemaRequest = 0;
const schemaSize = el<HTMLSelectElement>('schemaSize');
if (state.schemaSize) schemaSize.value = String(state.schemaSize);
schemaSize.addEventListener('change', () => run());
const schemaView = new SchemaView({ filter: (path, condition) => addCondition(path, condition) });

// ---------------------------------------------------------------------------
// Chart

let chartRequest = 0;
let chartPending: { spec: ChartSpec; source: QuerySource } | null = null;
const chartSourceSelect = el<HTMLSelectElement>('chartSource');

function setChartSource(source: 'find' | 'aggregate'): void {
  state.chartSource = chartSourceSelect.value = source;
  document.body.classList.toggle('chart-pipeline', source === 'aggregate');
  updateChartPipelineInfo();
}

function updateChartPipelineInfo(): void {
  const enabled = pipeline.stages.slice(0, pipeline.upto + 1).filter((s) => s.enabled).length;
  el('chartPipelineInfo').textContent =
    state.chartSource !== 'aggregate'
      ? ''
      : !enabled
        ? 'Aggregate tab: no stages'
        : `Aggregate tab: ${enabled} stage${enabled === 1 ? '' : 's'}${pipeline.previewUpto !== null ? ` (up to ${pipeline.upto + 1})` : ''}`;
}

/** The documents to chart: the filter (sort and projection don't matter) or the pipeline. */
function chartSourceOf(): QuerySource | undefined {
  if (state.chartSource === 'aggregate') {
    if (!pipeline.prepare()) return undefined;
    return { kind: 'aggregate', stages: pipeline.stages, upto: pipeline.upto };
  }
  const ok = isValidObject(filterInput.value);
  filterInput.classList.toggle('invalid', !ok);
  if (!ok) {
    showError('Invalid query syntax — check the highlighted field.');
    return undefined;
  }
  state.filter = filterInput.value;
  return { kind: 'find', filter: filterInput.value, sort: '', projection: '' };
}

function runChart(): void {
  showError(null);
  updateChartPipelineInfo();
  if (chartView.needsFields()) return;
  const source = chartSourceOf();
  const spec = source && chartView.validSpec();
  if (!source || !spec) return;
  vscode.setState(state);
  chartRequest++;
  chartPending = { spec, source };
  setLoading(true);
  chartView.loading();
  vscode.postMessage({ type: 'chart', requestId: chartRequest, source, spec });
}

const chartView = new ChartView(
  {
    draw: () => run(),
    filter: (conditions) => {
      try {
        let text = filterInput.value;
        for (const c of conditions) text = mergeCondition(text, c.field, c.value);
        filterInput.value = text;
      } catch (err) {
        showError(`Fix the filter first: ${(err as Error).message}`);
        return;
      }
      autosize();
      setMode('find');
      flash(el('filterWrap'));
    },
    code: () => {
      const spec = chartView.validSpec();
      const source = spec && chartSourceOf();
      if (!spec || !source) return;
      let prefix: unknown[] = [];
      let error: string | undefined;
      try {
        const query = toCodeQuery(source.kind === 'aggregate' ? { ...source, stages: source.stages.slice(0, source.upto + 1) } : source);
        if (query.kind === 'aggregate') prefix = query.pipeline;
        else if (isPlainObject(query.filter) && Object.keys(query.filter).length) prefix = [{ $match: query.filter }];
      } catch (err) {
        error = `Invalid query: ${(err as Error).message}`;
      }
      codeDialog.show(error ? undefined : { kind: 'aggregate', pipeline: [...prefix, ...chartStages(spec)] }, error, `${spec.type} chart`, databaseName, collectionName);
    },
    savePng: (dataUrl) => vscode.postMessage({ type: 'savePng', dataUrl, name: `${collectionName}-${state.chart?.type ?? 'chart'}` }),
    fields: () => {
      const hints = state.chartSource === 'aggregate' ? fieldsBefore(pipeline.upto + 1) : fieldsOfCollection();
      return hints.filter((h) => !h.types.every((t) => t === 'object')).map((h) => h.path);
    },
    changed: (spec) => {
      state.chart = spec;
      vscode.setState(state);
    },
    error: showError,
  },
  state.chart,
);
chartSourceSelect.addEventListener('change', () => {
  setChartSource(chartSourceSelect.value as 'find' | 'aggregate');
  vscode.setState(state);
  run();
});

// ---------------------------------------------------------------------------
// Indexes & explain

const pendingIndex = new Map<number, (error: string | undefined) => void>();
let indexRequest = 0;
const indexesView = new IndexesView({
  create: (keys, options) =>
    new Promise((resolve) => {
      const requestId = ++indexRequest;
      pendingIndex.set(requestId, resolve);
      vscode.postMessage({ type: 'createIndex', requestId, keys, options });
    }),
  drop: (name) => vscode.postMessage({ type: 'dropIndex', name }),
  hide: (name, hidden) => vscode.postMessage({ type: 'hideIndex', name, hidden }),
});

let explainRequest = 0;
const explainView = new ExplainView({
  jsonTree: (value) => jsonNode(null, value, true, 0),
  suggest: (keys) => {
    setMode('indexes');
    indexesView.prefill(keys);
  },
});

function explain(): void {
  let source: QuerySource;
  if (state.mode === 'aggregate') {
    if (!pipeline.prepare()) return;
    source = { kind: 'aggregate', stages: pipeline.stages, upto: pipeline.upto };
  } else {
    // Explain what is in the fields, even if not run yet.
    for (const input of [filterInput, sortInput, projectionInput]) {
      if (!isValidObject(input.value)) {
        input.classList.add('invalid');
        showError('Invalid query syntax — check the highlighted field.');
        return;
      }
    }
    source = { kind: 'find', filter: filterInput.value, sort: sortInput.value, projection: projectionInput.value };
  }
  explainRequest++;
  explainView.loading(state.mode === 'aggregate' ? 'Explain · pipeline' : 'Explain · find');
  vscode.postMessage({ type: 'explain', requestId: explainRequest, source });
}
el('explainFind').addEventListener('click', explain);

// ---------------------------------------------------------------------------
// Code

const codeDialog = new CodeDialog({
  post: (message) => vscode.postMessage(message),
  prefs: () => ({ language: state.codeLanguage ?? 'javascript', program: state.codeProgram ?? false }),
  savePrefs: (prefs) => {
    state.codeLanguage = prefs.language;
    state.codeProgram = prefs.program;
    vscode.setState(state);
  },
});

function showCode(): void {
  if (state.mode === 'aggregate') {
    if (!pipeline.prepare()) return;
    codeDialog.open({ kind: 'aggregate', stages: pipeline.stages, upto: pipeline.upto }, databaseName, collectionName);
    return;
  }
  codeDialog.open({ kind: 'find', filter: filterInput.value, sort: sortInput.value, projection: projectionInput.value }, databaseName, collectionName);
}
el('codeFind').addEventListener('click', showCode);
el('codePipeline').addEventListener('click', showCode);

// ---------------------------------------------------------------------------
// Update many / Delete many

const bulk = new BulkDialog((message) => vscode.postMessage(message));

function openBulk(op: BulkOp): void {
  if (!isValidObject(filterInput.value)) {
    filterInput.classList.add('invalid');
    showError('Invalid query syntax — check the highlighted field.');
    return;
  }
  // Show the documents that will be affected behind the dialog.
  if (filterInput.value !== state.filter) run(true);
  bulk.open(op, filterInput.value, collectionName);
}
el('updateMany').addEventListener('click', () => openBulk('update'));
el('deleteMany').addEventListener('click', () => openBulk('delete'));
el('explainPipeline').addEventListener('click', explain);
el('saveView').addEventListener('click', () => {
  if (!pipeline.prepare()) return;
  vscode.postMessage({ type: 'saveView', stages: pipeline.stages, upto: pipeline.upto });
});
el('editValidation').addEventListener('click', () => vscode.postMessage({ type: 'editValidation' }));
el('modeAggregate').addEventListener('click', () => state.mode !== 'aggregate' && setMode('aggregate'));

// ---------------------------------------------------------------------------
// Boot

filterInput.value = state.filter;
sortInput.value = state.sort;
projectionInput.value = state.projection;
limitSelect.value = String(state.limit);
pipeline.setStages(state.stages, state.previewUpto);
setChartSource(state.chartSource ?? 'find');
setMode(state.mode, false);
new ResizeObserver(autosize).observe(filterInput.parentElement!);
vscode.postMessage({ type: 'ready' });
