// Relationship diagram: the fields of each collection from a sample of documents (canonical EJSON), the
// fields that look like references to another collection (checked against the server afterwards), a
// column layout of the collections, and exports to Mermaid and SVG.
import { isEjsonWrapper, isPlainObject } from './query';
import { BsonType, bsonType } from './schema';

/** What a reference compares on: numbers of any type match each other in MongoDB. */
export type RefType = 'objectId' | 'string' | 'number' | 'uuid';

export interface RelField {
  /** Dotted path, as in a filter: "items.productId". */
  path: string;
  /** For display, with [] for array elements: "items[].productId". */
  label: string;
  /** Nesting level (0 for top-level fields). */
  depth: number;
  /** Types seen, most frequent first ("dbref" for DBRefs). */
  types: string[];
  /** Share of the sampled documents with the field. */
  ratio: number;
  /** Inside an array: a document can hold several values. */
  many: boolean;
}

export interface RelCollection {
  name: string;
  view?: boolean;
  /** The collection a view reads. */
  viewOn?: string;
  documents?: number;
  sampled: number;
  fields: RelField[];
  /** Fields of single-field unique indexes (besides _id): possible targets of references. */
  unique: string[];
}

export interface Relation {
  /** "from.field→to.toField" */
  id: string;
  from: string;
  field: string;
  fieldLabel: string;
  to: string;
  toField: string;
  /** The field holds several references (an array). */
  many: boolean;
  kind: 'reference' | 'dbref' | 'view';
  /** Sampled values found in the target, of those looked up. */
  matched: number;
  tested: number;
}

export interface RelGraph {
  database: string;
  collections: RelCollection[];
  relations: Relation[];
  /** Documents sampled per collection. */
  sample: number;
}

/** A field to check: its distinct sampled values (canonical EJSON), and the collections it could point to. */
export interface Candidate {
  from: string;
  field: RelField;
  type: RefType;
  values: unknown[];
  targets: { to: string; toField: string }[];
}

/** Values looked up per candidate field. */
export const VALUES_TESTED = 20;
const FIELD_MAX = 300;

// ---------------------------------------------------------------------------
// Fields of a sample

interface Acc {
  label: string;
  depth: number;
  count: number;
  many: boolean;
  types: Map<string, number>;
  /** Reference-like values by type, canonical EJSON, distinct by JSON. */
  values: Map<RefType, Map<string, unknown>>;
  order: number;
}

const isDbRef = (v: unknown): v is { $ref: string; $id: unknown; $db?: string } => isPlainObject(v) && typeof v.$ref === 'string' && '$id' in v;

function refType(v: unknown, type: BsonType): RefType | undefined {
  if (type === 'objectId') return 'objectId';
  if (type === 'string') return 'string';
  if (type === 'int' || type === 'long' || type === 'double' || type === 'decimal') return 'number';
  if (type === 'binData' && isPlainObject(v)) {
    const b = (v as { $binary?: { subType?: string } }).$binary;
    if (b?.subType === '04' || b?.subType === '4') return 'uuid';
  }
  return undefined;
}

/** The fields of sampled documents (canonical EJSON), in order of first appearance, with sample values. */
export function sampleFields(docs: unknown[]): { fields: RelField[]; values: Map<string, Map<RefType, unknown[]>>; dbrefs: Map<string, Set<string>> } {
  const accs = new Map<string, Acc>();
  const dbrefs = new Map<string, Set<string>>();
  let order = 0;
  const visit = (v: unknown, path: string, label: string, depth: number, many: boolean, seen: Set<string>) => {
    let acc = accs.get(path);
    if (!acc) {
      if (accs.size >= FIELD_MAX) return;
      acc = { label, depth, count: 0, many, types: new Map(), values: new Map(), order: order++ };
      accs.set(path, acc);
    }
    // Presence counts documents, not array elements.
    if (!seen.has(path)) {
      seen.add(path);
      acc.count++;
    }
    acc.many ||= many;
    if (Array.isArray(v)) {
      if (!v.length) acc.types.set('array', (acc.types.get('array') ?? 0) + 1);
      for (const item of v) {
        if (Array.isArray(item)) continue;
        acc.types.set('array', (acc.types.get('array') ?? 0) + 1);
        visitValue(item, path, `${label}[]`, depth, true, seen, acc);
      }
      return;
    }
    visitValue(v, path, label, depth, many, seen, acc);
  };
  const visitValue = (v: unknown, path: string, label: string, depth: number, many: boolean, seen: Set<string>, acc: Acc) => {
    if (isDbRef(v)) {
      acc.types.set('dbref', (acc.types.get('dbref') ?? 0) + 1);
      const set = dbrefs.get(path) ?? new Set<string>();
      set.add(v.$db ? `${v.$db}.${v.$ref}` : v.$ref);
      dbrefs.set(path, set);
      return;
    }
    const type = bsonType(v);
    if (type === 'object' && !isEjsonWrapper(v)) {
      acc.types.set('object', (acc.types.get('object') ?? 0) + 1);
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        visit(x, `${path}.${k}`, `${label}.${k}`, depth + 1, many, seen);
      }
      return;
    }
    acc.types.set(type, (acc.types.get(type) ?? 0) + 1);
    const ref = refType(v, type);
    if (!ref) return;
    let byType = acc.values.get(ref);
    if (!byType) acc.values.set(ref, (byType = new Map()));
    if (byType.size < VALUES_TESTED * 5) byType.set(JSON.stringify(v), v);
  };
  for (const doc of docs) {
    if (!isPlainObject(doc)) continue;
    const seen = new Set<string>();
    for (const [k, v] of Object.entries(doc)) visit(v, k, k, 0, false, seen);
  }
  const total = docs.length || 1;
  const sorted = [...accs.entries()].sort((a, b) => Number(b[0] === '_id') - Number(a[0] === '_id') || a[1].order - b[1].order);
  const fields = sorted.map(([path, a]) => ({
    path,
    label: a.label,
    depth: a.depth,
    types: [...a.types.entries()].sort((x, y) => y[1] - x[1]).map(([t]) => t),
    ratio: Math.min(1, a.count / total),
    many: a.many,
  }));
  const values = new Map<string, Map<RefType, unknown[]>>();
  for (const [path, a] of accs) {
    if (!a.values.size) continue;
    values.set(path, new Map([...a.values.entries()].map(([t, m]) => [t, [...m.values()]])));
  }
  return { fields, values, dbrefs };
}

// ---------------------------------------------------------------------------
// Candidates

/** "customerId" → "customer", "user_ids" → "user", "authorRef" → "author". */
export function stem(name: string): string {
  return name
    .replace(/(_?ids?|_?refs?|_?keys?)$/i, '')
    .replace(/[_\-\s]/g, '')
    .toLowerCase();
}

/** "customers" → "customer", "categories" → "category", "addresses" → "address", "people" → "person". */
export function singular(name: string): string {
  const n = name.toLowerCase().replace(/[_\-\s]/g, '');
  if (n === 'people') return 'person';
  if (/ies$/.test(n)) return `${n.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(n)) return n.slice(0, -2);
  if (/s$/.test(n) && !/ss$/.test(n)) return n.slice(0, -1);
  return n;
}

/** Whether a field name points to a collection by name: customerId → customers, parent → (none). */
export function namesMatch(field: string, collection: string): boolean {
  const s = stem(field.split('.').pop()!);
  if (!s) return false;
  const c = collection.split('.').pop()!;
  return s === singular(c) || s === c.toLowerCase().replace(/[_\-\s]/g, '') || singular(s) === singular(c);
}

/** The _id type of a collection, from its sampled values. */
export function idType(values: Map<string, Map<RefType, unknown[]>>): RefType | undefined {
  const ids = values.get('_id');
  if (!ids) return undefined;
  let best: RefType | undefined;
  let n = 0;
  for (const [t, list] of ids) {
    if (list.length > n) {
      best = t;
      n = list.length;
    }
  }
  return best;
}

/**
 * The fields worth checking and where they could point. ObjectIds and UUIDs are unique across
 * collections, so every collection with ids of that type is a target; strings and numbers repeat
 * everywhere, so only a collection the field is named after is (customerId → customers). A unique field
 * of another collection is a target when the field is named like it (customerEmail, email → users.email).
 */
export function candidates(
  sampled: { name: string; fields: RelField[]; values: Map<string, Map<RefType, unknown[]>>; unique: string[] }[],
): Candidate[] {
  const out: Candidate[] = [];
  const ids = new Map(sampled.map((s) => [s.name, idType(s.values)]));
  for (const a of sampled) {
    for (const field of a.fields) {
      // A document's own _id is not a reference.
      if (field.path === '_id') continue;
      const byType = a.values.get(field.path);
      if (!byType) continue;
      const last = field.path.split('.').pop()!.toLowerCase();
      for (const [type, list] of byType) {
        const values = list.slice(0, VALUES_TESTED);
        if (!values.length) continue;
        const targets: Candidate['targets'] = [];
        for (const b of sampled) {
          if (ids.get(b.name) === type && (type === 'objectId' || type === 'uuid' || namesMatch(field.path, b.name))) targets.push({ to: b.name, toField: '_id' });
          for (const u of b.unique) {
            if (b.name === a.name && u === field.path) continue;
            const ul = u.split('.').pop()!.toLowerCase();
            if (last === ul || (last.endsWith(ul) && namesMatch(last.slice(0, -ul.length), b.name))) targets.push({ to: b.name, toField: u });
          }
        }
        if (targets.length) out.push({ from: a.name, field, type, values, targets });
      }
    }
  }
  return out;
}

/** A value as compared by MongoDB: numbers of any type alike. Canonical EJSON in. */
export function refKey(v: unknown): string {
  if (isPlainObject(v)) {
    if (typeof v.$oid === 'string') return `oid:${v.$oid}`;
    for (const k of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) if (k in v) return `num:${Number(v[k])}`;
    const bin = v.$binary as { base64?: string } | undefined;
    if (bin?.base64) return `bin:${bin.base64}`;
  }
  if (typeof v === 'number') return `num:${v}`;
  return `json:${JSON.stringify(v)}`;
}

/** Whether enough sampled values were found for a reference. Ids can't match by chance; other values can. */
export function isReference(type: RefType, matched: number, tested: number): boolean {
  if (!matched) return false;
  if (type === 'objectId' || type === 'uuid') return matched / tested >= 0.2;
  return matched / tested >= 0.6 && (tested < 3 || matched >= 2);
}

// ---------------------------------------------------------------------------
// Layout

export const NODE_W = 240;
export const HEAD_H = 30;
export const ROW_H = 19;
export const GAP_X = 130;
export const GAP_Y = 36;
/** Fields listed in a box; the rest are counted. */
export const ROWS_MAX = 14;

export interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The fields shown in a collection's box: _id and reference fields first; only those when `keysOnly`. */
export function shownFields(c: RelCollection, relations: Relation[], keysOnly: boolean): { rows: RelField[]; more: number } {
  const keys = new Set<string>(['_id', ...c.unique]);
  for (const r of relations) {
    if (r.from === c.name) keys.add(r.field);
    if (r.to === c.name) keys.add(r.toField);
  }
  const isKey = (f: RelField) => keys.has(f.path);
  // In document order; sub-documents show through their fields. Over the limit, keys stay first.
  const visible = c.fields.filter((f) => isKey(f) || (!keysOnly && f.types[0] !== 'object'));
  let room = Math.max(0, ROWS_MAX - visible.filter(isKey).length);
  const rows = visible.filter((f) => isKey(f) || room-- > 0);
  return { rows, more: visible.length - rows.length };
}

/** A row's text: the last part of the path under its parent's row, or the whole path when that isn't shown. */
export function rowLabel(f: RelField, rows: RelField[]): { text: string; indent: number } {
  if (!f.depth) return { text: f.label, indent: 0 };
  const parent = f.path.split('.').slice(0, -1).join('.');
  return rows.some((r) => r.path === parent) ? { text: f.label.split('.').slice(f.depth).join('.'), indent: f.depth } : { text: f.label, indent: 0 };
}

export function boxHeight(c: RelCollection, relations: Relation[], keysOnly: boolean): number {
  const { rows, more } = shownFields(c, relations, keysOnly);
  return HEAD_H + (rows.length + (more ? 1 : 0)) * ROW_H + 8;
}

/**
 * Columns by references: collections nothing references from (pure targets) on the left, each other one
 * right of what it references; the order in a column follows its neighbours. Unrelated collections last.
 */
export function layout(graph: RelGraph, keysOnly: boolean): { boxes: Box[]; width: number; height: number } {
  const names = graph.collections.map((c) => c.name);
  const out = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  const linked = new Set<string>();
  for (const r of graph.relations) {
    if (r.from === r.to || !out.has(r.from) || !out.has(r.to)) continue;
    out.get(r.from)!.add(r.to);
    linked.add(r.from);
    linked.add(r.to);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (n: string): number => {
    if (layer.has(n)) return layer.get(n)!;
    if (visiting.has(n)) return 0;
    visiting.add(n);
    let d = 0;
    for (const t of out.get(n)!) d = Math.max(d, depth(t) + 1);
    visiting.delete(n);
    layer.set(n, d);
    return d;
  };
  const connected = names.filter((n) => linked.has(n)).sort((a, b) => a.localeCompare(b));
  connected.forEach(depth);
  const columns: string[][] = [];
  for (const n of connected) (columns[layer.get(n)!] ??= []).push(n);
  for (let i = 0; i < columns.length; i++) columns[i] ??= [];
  // Barycenter sweeps: each collection near the ones it is linked to in the neighbouring columns.
  const neighbours = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const r of graph.relations) {
    if (r.from === r.to || !neighbours.has(r.from) || !neighbours.has(r.to)) continue;
    neighbours.get(r.from)!.push(r.to);
    neighbours.get(r.to)!.push(r.from);
  }
  const position = () => new Map(columns.flatMap((col) => col.map((n, i) => [n, i / Math.max(1, col.length - 1)] as [string, number])));
  for (let sweep = 0; sweep < 6; sweep++) {
    const pos = position();
    for (const col of columns) {
      const bary = new Map(col.map((n) => {
        const ns = neighbours.get(n)!.filter((m) => pos.has(m) && !col.includes(m));
        return [n, ns.length ? ns.reduce((s, m) => s + pos.get(m)!, 0) / ns.length : pos.get(n)!];
      }));
      col.sort((a, b) => bary.get(a)! - bary.get(b)! || a.localeCompare(b));
    }
  }
  const byName = new Map(graph.collections.map((c) => [c.name, c]));
  const heightOf = (n: string) => boxHeight(byName.get(n)!, graph.relations, keysOnly);
  const boxes: Box[] = [];
  const colHeights = columns.map((col) => col.reduce((h, n) => h + heightOf(n), 0) + GAP_Y * Math.max(0, col.length - 1));
  const tallest = Math.max(0, ...colHeights);
  columns.forEach((col, i) => {
    let y = (tallest - colHeights[i]) / 2;
    for (const n of col) {
      const h = heightOf(n);
      boxes.push({ name: n, x: i * (NODE_W + GAP_X), y, w: NODE_W, h });
      y += h + GAP_Y;
    }
  });
  // Unrelated collections: a grid below (or alone).
  const lonely = names.filter((n) => !linked.has(n)).sort((a, b) => a.localeCompare(b));
  const perRow = Math.max(3, columns.length);
  let top = connected.length ? tallest + GAP_Y * 2 : 0;
  for (let i = 0; i < lonely.length; i += perRow) {
    const row = lonely.slice(i, i + perRow);
    const h = Math.max(...row.map(heightOf));
    row.forEach((n, j) => boxes.push({ name: n, x: j * (NODE_W + GAP_X / 2), y: top, w: NODE_W, h: heightOf(n) }));
    top += h + GAP_Y;
  }
  const width = Math.max(0, ...boxes.map((b) => b.x + b.w));
  const height = Math.max(0, ...boxes.map((b) => b.y + b.h));
  return { boxes, width, height };
}

/** The y of a field's row in its box (its middle), or of the header when the field isn't shown. */
export function rowY(box: Box, c: RelCollection, relations: Relation[], keysOnly: boolean, path: string): number {
  const { rows } = shownFields(c, relations, keysOnly);
  const i = rows.findIndex((f) => f.path === path);
  return i < 0 ? box.y + HEAD_H / 2 : box.y + HEAD_H + i * ROW_H + ROW_H / 2 + 2;
}

/** A curve from a field of one box to a field of another (or of the same box: a loop on its right). */
export function edgePath(from: Box, fy: number, to: Box, ty: number): { d: string; sx: number; ex: number } {
  if (from === to || from.name === to.name) {
    const x = from.x + from.w;
    return { d: `M ${x} ${fy} C ${x + 60} ${fy}, ${x + 60} ${ty}, ${x} ${ty}`, sx: x, ex: x };
  }
  const leftToRight = from.x + from.w / 2 < to.x + to.w / 2;
  const sx = leftToRight ? from.x + from.w : from.x;
  const ex = leftToRight ? to.x : to.x + to.w;
  const dx = Math.max(40, Math.abs(ex - sx) / 2);
  const c1 = leftToRight ? sx + dx : sx - dx;
  const c2 = leftToRight ? ex - dx : ex + dx;
  return { d: `M ${sx} ${fy} C ${c1} ${fy}, ${c2} ${ty}, ${ex} ${ty}`, sx, ex };
}

// ---------------------------------------------------------------------------
// Exports

const mermaidName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
const mermaidType = (types: string[]) => mermaidName(types.find((t) => t !== 'null') ?? types[0] ?? 'any');

/** The diagram as a Mermaid erDiagram (keys and reference fields, or every top-level field). */
export function toMermaid(graph: RelGraph, keysOnly: boolean): string {
  const lines = ['erDiagram'];
  for (const c of graph.collections) {
    const { rows } = shownFields(c, graph.relations, keysOnly);
    lines.push(`  ${mermaidName(c.name)} {`);
    for (const f of rows) {
      const fk = graph.relations.some((r) => r.from === c.name && r.field === f.path && r.kind !== 'view');
      const pk = f.path === '_id';
      const uk = c.unique.includes(f.path);
      lines.push(`    ${mermaidType(f.types)} ${mermaidName(f.label.replace(/\[\]/g, ''))}${pk ? ' PK' : fk ? ' FK' : uk ? ' UK' : ''}`);
    }
    lines.push('  }');
  }
  for (const r of graph.relations) {
    const label = r.kind === 'view' ? 'view of' : r.fieldLabel;
    const card = r.kind === 'view' ? '||--||' : r.many ? '}o--o{' : '}o--||';
    lines.push(`  ${mermaidName(r.from)} ${card} ${mermaidName(r.to)} : "${label.replace(/"/g, "'")}"`);
  }
  return `${lines.join('\n')}\n`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A standalone SVG of the diagram (light colours), with the boxes where they are on screen. */
export function toSvg(graph: RelGraph, boxes: Box[], keysOnly: boolean): string {
  const pad = 20;
  const minX = Math.min(0, ...boxes.map((b) => b.x)) - pad;
  const minY = Math.min(0, ...boxes.map((b) => b.y)) - pad;
  const width = Math.max(...boxes.map((b) => b.x + b.w), 0) - minX + pad + 60;
  const height = Math.max(...boxes.map((b) => b.y + b.h), 0) - minY + pad;
  const byName = new Map(boxes.map((b) => [b.name, b]));
  const colls = new Map(graph.collections.map((c) => [c.name, c]));
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="${minX} ${minY} ${Math.ceil(width)} ${Math.ceil(height)}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12">`);
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#5a6b7d"/></marker></defs>');
  parts.push(`<rect x="${minX}" y="${minY}" width="${Math.ceil(width)}" height="${Math.ceil(height)}" fill="#ffffff"/>`);
  for (const r of graph.relations) {
    const a = byName.get(r.from);
    const b = byName.get(r.to);
    const ca = colls.get(r.from);
    const cb = colls.get(r.to);
    if (!a || !b || !ca || !cb) continue;
    const { d } = edgePath(a, rowY(a, ca, graph.relations, keysOnly, r.field), b, rowY(b, cb, graph.relations, keysOnly, r.toField));
    parts.push(`<path d="${d}" fill="none" stroke="#5a6b7d" stroke-width="1.4"${r.kind === 'view' ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#arrow)"><title>${esc(describe(r))}</title></path>`);
  }
  for (const box of boxes) {
    const c = colls.get(box.name);
    if (!c) continue;
    const { rows, more } = shownFields(c, graph.relations, keysOnly);
    parts.push(`<g><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="4" fill="#ffffff" stroke="#9aa7b4"/>`);
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${HEAD_H}" rx="4" fill="${c.view ? '#efe7f7' : '#e6eef7'}"/>`);
    parts.push(`<text x="${box.x + 10}" y="${box.y + 19}" font-weight="600" fill="#1f2d3d">${esc(c.name)}${c.view ? ' (view)' : ''}</text>`);
    if (c.documents !== undefined) parts.push(`<text x="${box.x + box.w - 10}" y="${box.y + 19}" text-anchor="end" fill="#6b7785" font-size="11">${c.documents.toLocaleString('en-US')} docs</text>`);
    rows.forEach((f, i) => {
      const y = box.y + HEAD_H + i * ROW_H + ROW_H / 2 + 6;
      const fk = graph.relations.some((r) => r.from === c.name && r.field === f.path && r.kind !== 'view');
      const key = f.path === '_id' ? 'PK' : fk ? 'FK' : c.unique.includes(f.path) ? 'UK' : '';
      const label = rowLabel(f, rows);
      parts.push(`<text x="${box.x + 10 + label.indent * 10}" y="${y}" fill="${key ? '#0b5cad' : '#1f2d3d'}" font-family="Consolas, Menlo, monospace" font-size="11.5">${esc(label.text)}</text>`);
      parts.push(`<text x="${box.x + box.w - 10}" y="${y}" text-anchor="end" fill="#6b7785" font-size="11">${esc([key, f.types.filter((t) => t !== 'null')[0] ?? f.types[0] ?? ''].filter(Boolean).join(' · '))}</text>`);
    });
    if (more) parts.push(`<text x="${box.x + 10}" y="${box.y + HEAD_H + rows.length * ROW_H + ROW_H / 2 + 6}" fill="#6b7785" font-size="11">+${more} more fields</text>`);
    parts.push('</g>');
  }
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

/** "orders.customerId → customers._id · many-to-one · 20 of 20 sampled values found" */
export function describe(r: Relation): string {
  if (r.kind === 'view') return `${r.from} is a view of ${r.to}`;
  const card = r.many ? 'many-to-many (an array of references)' : 'many-to-one';
  const found = r.kind === 'dbref' ? 'DBRef' : `${r.matched} of ${r.tested} sampled values found`;
  return `${r.from}.${r.fieldLabel} → ${r.to}.${r.toField} · ${card} · ${found}`;
}
