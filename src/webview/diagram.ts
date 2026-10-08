// Relationship diagram tab: the collections as boxes with their fields, the references as curves from a
// field to the collection it points to. Boxes can be dragged, the view panned and zoomed.
import type { DiagramHostMessage, DiagramViewMessage } from '../shared/messages';
import { Box, HEAD_H, RelCollection, RelGraph, Relation, ROW_H, describe, edgePath, layout, rowLabel, rowY, shownFields, toMermaid } from '../shared/relations';

interface State {
  sample: number;
  keysOnly: boolean;
  /** Boxes moved by hand. */
  moved: Record<string, { x: number; y: number }>;
}

declare function acquireVsCodeApi(): {
  postMessage(message: DiagramViewMessage): void;
  getState(): Partial<State> | undefined;
  setState(state: State): void;
};

const vscode = acquireVsCodeApi();
const state: State = { sample: 100, keysOnly: false, moved: {}, ...vscode.getState() };
const save = () => vscode.setState(state);
const el = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const SVG = 'http://www.w3.org/2000/svg';

let database = '';
let focus: string | undefined;
let graph: RelGraph | undefined;
let boxes = new Map<string, Box>();
let requestId = 0;
let loading = false;
/** The selected collection or relation: its links stand out. */
let selected: { collection?: string; relation?: string } = {};
const view = { x: 20, y: 20, scale: 1 };
let fitted = false;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const collection = (name: string) => graph?.collections.find((c) => c.name === name);

function setStatus(text: string): void {
  el('status').textContent = text;
}

function applyView(): void {
  el('viewport').setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
}

// ---------------------------------------------------------------------------
// Drawing

function nodeElement(c: RelCollection, box: Box): SVGGElement {
  const g = svg('g', { class: `node${c.view ? ' view' : ''}`, transform: `translate(${box.x} ${box.y})`, tabindex: 0, role: 'button', 'data-name': c.name });
  g.setAttribute('aria-label', `${c.name}${c.view ? ' (view)' : ''}: double-click or Enter opens it`);
  g.append(svg('rect', { class: 'box', width: box.w, height: box.h, rx: 4 }));
  g.append(svg('rect', { class: 'head', width: box.w, height: HEAD_H, rx: 4 }));
  g.append(svg('rect', { class: 'head-fill', y: HEAD_H - 4, width: box.w, height: 4 }));
  const name = svg('text', { class: 'name', x: 10, y: 19 }, c.name);
  g.append(name);
  const count = c.view ? 'view' : c.documents !== undefined ? `${c.documents.toLocaleString('en-US')} docs` : '';
  if (count) g.append(svg('text', { class: 'count', x: box.w - 10, y: 19, 'text-anchor': 'end' }, count));
  const rels = graph!.relations;
  const { rows, more } = shownFields(c, rels, state.keysOnly);
  rows.forEach((f, i) => {
    const y = HEAD_H + i * ROW_H + ROW_H / 2 + 6;
    const fk = rels.some((r) => r.from === c.name && r.field === f.path && r.kind !== 'view');
    const target = rels.some((r) => r.to === c.name && r.toField === f.path);
    const key = f.path === '_id' ? 'PK' : fk ? 'FK' : c.unique.includes(f.path) ? 'UK' : '';
    const label = rowLabel(f, rows);
    const row = svg('text', { class: `field${key ? ' key' : ''}${target ? ' target' : ''}`, x: 10 + label.indent * 10, y, 'data-path': f.path }, label.text);
    const title = svg('title', {}, `${f.label}: ${f.types.join(' | ')}${f.ratio < 1 ? ` · in ${Math.round(f.ratio * 100)}% of the sampled documents` : ''}`);
    row.append(title);
    g.append(row);
    const type = f.types.filter((t) => t !== 'null')[0] ?? f.types[0] ?? '';
    g.append(svg('text', { class: 'type', x: box.w - 10, y, 'text-anchor': 'end' }, [key, type].filter(Boolean).join(' · ')));
  });
  if (more) g.append(svg('text', { class: 'more', x: 10, y: HEAD_H + rows.length * ROW_H + ROW_H / 2 + 6 }, `+${more} more field${more === 1 ? '' : 's'}`));
  if (!c.view && !c.sampled && !c.fields.length) g.append(svg('text', { class: 'more', x: 10, y: HEAD_H + ROW_H / 2 + 6 }, 'empty, or not readable'));
  return g;
}

function edgeElement(r: Relation): SVGGElement | undefined {
  const a = boxes.get(r.from);
  const b = boxes.get(r.to);
  const ca = collection(r.from);
  const cb = collection(r.to);
  if (!a || !b || !ca || !cb) return undefined;
  const rels = graph!.relations;
  const fy = rowY(a, ca, rels, state.keysOnly, r.field);
  const ty = rowY(b, cb, rels, state.keysOnly, r.toField);
  const { d, sx } = edgePath(a, fy, b, ty);
  const g = svg('g', { class: `edge ${r.kind}`, 'data-id': r.id });
  g.append(svg('path', { class: 'hit', d }));
  const path = svg('path', { class: 'line', d, 'marker-end': 'url(#arrow)' });
  g.append(path);
  if (r.many) g.append(svg('text', { class: 'many', x: sx + (sx === a.x ? -12 : 6), y: fy - 4 }, 'N'));
  g.append(svg('title', {}, describe(r)));
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    select({ relation: r.id });
  });
  return g;
}

function drawEdges(): void {
  const layer = el<SVGGElement>('edges');
  layer.textContent = '';
  for (const r of graph?.relations ?? []) {
    const e = edgeElement(r);
    if (e) layer.append(e);
  }
  highlight();
}

function draw(): void {
  const root = el<SVGSVGElement>('diagram');
  root.textContent = '';
  const defs = svg('defs');
  const marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrow' }));
  defs.append(marker);
  root.append(defs);
  const viewport = svg('g', { id: 'viewport' });
  viewport.append(svg('g', { id: 'edges' }), svg('g', { id: 'nodes' }));
  root.append(viewport);
  applyView();
  boxes = new Map();
  if (!graph) return;
  const auto = layout(graph, state.keysOnly);
  for (const b of auto.boxes) {
    const moved = state.moved[b.name];
    boxes.set(b.name, moved ? { ...b, x: moved.x, y: moved.y } : b);
  }
  const nodes = el<SVGGElement>('nodes');
  for (const c of graph.collections) {
    const box = boxes.get(c.name);
    if (box) nodes.append(nodeElement(c, box));
  }
  drawEdges();
  renderList();
}

/** The selected collection's or relation's links, and what they connect, stand out; the rest fades. */
function highlight(): void {
  const rels = graph?.relations ?? [];
  const active = rels.filter((r) => (selected.relation ? r.id === selected.relation : selected.collection ? r.from === selected.collection || r.to === selected.collection : false));
  const some = !!selected.relation || !!selected.collection;
  const ids = new Set(active.map((r) => r.id));
  const names = new Set(active.flatMap((r) => [r.from, r.to]));
  if (selected.collection) names.add(selected.collection);
  document.querySelectorAll<SVGGElement>('#edges .edge').forEach((e) => {
    e.classList.toggle('active', ids.has(e.dataset.id!));
    e.classList.toggle('faded', some && !ids.has(e.dataset.id!));
  });
  document.querySelectorAll<SVGGElement>('#nodes .node').forEach((n) => {
    n.classList.toggle('selected', n.dataset.name === selected.collection);
    n.classList.toggle('faded', some && !names.has(n.dataset.name!));
  });
  document.querySelectorAll<HTMLElement>('#relations li').forEach((li) => li.classList.toggle('active', ids.has(li.dataset.id!)));
}

function select(s: typeof selected): void {
  selected = s;
  highlight();
}

function renderList(): void {
  const list = el('relations');
  list.textContent = '';
  const rels = graph?.relations ?? [];
  el('relationsTitle').textContent = `Relations (${rels.length})`;
  for (const r of rels) {
    const li = document.createElement('li');
    li.dataset.id = r.id;
    li.tabIndex = 0;
    li.textContent = describe(r);
    const show = () => {
      select({ relation: r.id });
      center([r.from, r.to]);
    };
    li.addEventListener('click', show);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') show();
    });
    list.append(li);
  }
  if (!rels.length && graph) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'No field of the sampled documents refers to another collection.';
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// View

function bounds(names?: string[]): { x: number; y: number; w: number; h: number } | undefined {
  const list = [...boxes.values()].filter((b) => !names || names.includes(b.name));
  if (!list.length) return undefined;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
}

function fit(names?: string[], maxScale = 1): void {
  const b = bounds(names);
  if (!b) return;
  const rect = el<SVGSVGElement>('diagram').getBoundingClientRect();
  const pad = 40;
  view.scale = Math.max(0.15, Math.min(maxScale, (rect.width - pad * 2) / Math.max(b.w, 1), (rect.height - pad * 2) / Math.max(b.h, 1)));
  view.x = (rect.width - b.w * view.scale) / 2 - b.x * view.scale;
  view.y = Math.max(pad / 2, (rect.height - b.h * view.scale) / 2) - b.y * view.scale;
  applyView();
}

function center(names: string[]): void {
  const b = bounds(names);
  if (!b) return;
  const rect = el<SVGSVGElement>('diagram').getBoundingClientRect();
  if (b.w * view.scale > rect.width - 40 || b.h * view.scale > rect.height - 40) return fit(names, view.scale);
  view.x = rect.width / 2 - (b.x + b.w / 2) * view.scale;
  view.y = rect.height / 2 - (b.y + b.h / 2) * view.scale;
  applyView();
}

function zoom(factor: number, cx?: number, cy?: number): void {
  const rect = el<SVGSVGElement>('diagram').getBoundingClientRect();
  const px = cx ?? rect.width / 2;
  const py = cy ?? rect.height / 2;
  const next = Math.max(0.15, Math.min(3, view.scale * factor));
  view.x = px - ((px - view.x) * next) / view.scale;
  view.y = py - ((py - view.y) * next) / view.scale;
  view.scale = next;
  applyView();
}

// Dragging a box moves it; dragging the background pans; a click without moving selects.
let drag: { kind: 'node' | 'pan'; name?: string; startX: number; startY: number; x: number; y: number; moved: boolean } | undefined;
const diagram = el<SVGSVGElement>('diagram');

diagram.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const node = (e.target as Element).closest<SVGGElement>('.node');
  if ((e.target as Element).closest('.edge')) return;
  if (node) {
    const b = boxes.get(node.dataset.name!)!;
    drag = { kind: 'node', name: b.name, startX: e.clientX, startY: e.clientY, x: b.x, y: b.y, moved: false };
  } else drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, x: view.x, y: view.y, moved: false };
});
diagram.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  if (!drag.moved) diagram.setPointerCapture(e.pointerId); // only now: a capture sends clicks to the svg, not the box
  drag.moved = true;
  diagram.classList.add('dragging');
  if (drag.kind === 'pan') {
    view.x = drag.x + dx;
    view.y = drag.y + dy;
    applyView();
    return;
  }
  const b = boxes.get(drag.name!)!;
  b.x = Math.round(drag.x + dx / view.scale);
  b.y = Math.round(drag.y + dy / view.scale);
  document.querySelector<SVGGElement>(`#nodes .node[data-name="${CSS.escape(b.name)}"]`)?.setAttribute('transform', `translate(${b.x} ${b.y})`);
  drawEdges();
});
const endDrag = (e: PointerEvent) => {
  if (!drag) return;
  const d = drag;
  drag = undefined;
  diagram.classList.remove('dragging');
  if (diagram.hasPointerCapture(e.pointerId)) diagram.releasePointerCapture(e.pointerId);
  if (d.kind === 'node' && d.moved) {
    const b = boxes.get(d.name!)!;
    state.moved[b.name] = { x: b.x, y: b.y };
    save();
  } else if (!d.moved) select(d.kind === 'node' ? { collection: d.name } : {});
};
diagram.addEventListener('pointerup', endDrag);
diagram.addEventListener('pointercancel', endDrag);
diagram.addEventListener('dblclick', (e) => {
  const node = (e.target as Element).closest<SVGGElement>('.node');
  if (node) vscode.postMessage({ type: 'openCollection', name: node.dataset.name! });
});
diagram.addEventListener('keydown', (e) => {
  const node = (e.target as Element).closest<SVGGElement>('.node');
  if (node && e.key === 'Enter') vscode.postMessage({ type: 'openCollection', name: node.dataset.name! });
  else if (node && e.key === ' ') {
    e.preventDefault();
    select({ collection: node.dataset.name });
  }
});
diagram.addEventListener('focusin', (e) => {
  const node = (e.target as Element).closest<SVGGElement>('.node');
  if (node) select({ collection: node.dataset.name });
});
diagram.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = diagram.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Host

function analyze(): void {
  requestId++;
  loading = true;
  el('error').classList.add('hidden');
  el<HTMLButtonElement>('refresh').disabled = true;
  setStatus('Sampling the collections…');
  vscode.postMessage({ type: 'analyze', requestId, sample: state.sample });
}

function summary(): void {
  if (!graph) return;
  const views = graph.relations.filter((r) => r.kind === 'view').length;
  const refs = graph.relations.length - views;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  setStatus([plural(graph.collections.length, 'collection'), plural(refs, 'relation'), ...(views ? [plural(views, 'view')] : []), `${graph.sample.toLocaleString('en-US')} documents sampled per collection`].join(' · '));
  const empty = el('empty');
  empty.classList.toggle('hidden', graph.collections.length > 0);
  empty.textContent = graph.collections.length ? '' : `${database} has no collections.`;
}

window.addEventListener('message', (e: MessageEvent<DiagramHostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const first = !database;
      database = m.database;
      focus = m.focus;
      el('title').textContent = `Relationship Diagram · ${m.database} · ${m.connectionName}`;
      if (m.color) document.body.dataset.color = m.color;
      else delete document.body.dataset.color;
      if (first) analyze();
      else if (focus && boxes.has(focus)) {
        select({ collection: focus });
        center([focus]);
      }
      break;
    }
    case 'progress':
      if (m.requestId === requestId) setStatus(m.text);
      break;
    case 'graph':
      if (m.requestId !== requestId) return;
      loading = false;
      el<HTMLButtonElement>('refresh').disabled = false;
      if (m.error) {
        el('error').textContent = m.error;
        el('error').classList.remove('hidden');
        setStatus('');
        return;
      }
      graph = m.graph!;
      // Moved boxes of collections that are gone are forgotten.
      for (const name of Object.keys(state.moved)) if (!graph.collections.some((c) => c.name === name)) delete state.moved[name];
      save();
      draw();
      summary();
      if (!fitted || focus) {
        fitted = true;
        if (focus && boxes.has(focus)) {
          fit();
          select({ collection: focus });
          center([focus]);
        } else fit();
      }
      break;
  }
});

const sample = el<HTMLSelectElement>('sample');
sample.value = String(state.sample);
sample.addEventListener('change', () => {
  state.sample = Number(sample.value);
  save();
  analyze();
});
const keysOnly = el<HTMLInputElement>('keysOnly');
keysOnly.checked = state.keysOnly;
keysOnly.addEventListener('change', () => {
  state.keysOnly = keysOnly.checked;
  // Box heights change: the automatic layout again.
  state.moved = {};
  save();
  draw();
  fit();
});
el('refresh').addEventListener('click', () => {
  if (!loading) analyze();
});
el('zoomIn').addEventListener('click', () => zoom(1.25));
el('zoomOut').addEventListener('click', () => zoom(0.8));
el('fit').addEventListener('click', () => fit());
el('relayout').addEventListener('click', () => {
  state.moved = {};
  save();
  draw();
  fit();
});
el('mermaid').addEventListener('click', () => {
  if (graph) vscode.postMessage({ type: 'copy', text: toMermaid(graph, state.keysOnly) });
});
el('svg').addEventListener('click', () => {
  if (graph) vscode.postMessage({ type: 'saveSvg', boxes: [...boxes.values()], keysOnly: state.keysOnly });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select({});
});
draw();
vscode.postMessage({ type: 'ready' });
