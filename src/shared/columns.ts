// Column model for the grid: top-level fields, with sub-documents optionally expanded
// into dotted child columns (address -> address.city, address.zip, ...), and arrays of
// sub-documents expanded into element columns (items -> items[].sku, items[].qty), one
// sub-row per element.
import { isEjsonWrapper, isPlainObject } from './query';

export interface ColumnNode {
  path: string[];
  /** Dotted path, as used in filters and sorts. */
  key: string;
  /** Some document on the page has a non-empty sub-document (or array of them) here. */
  expandable: boolean;
  /** Some document on the page has an array of sub-documents here: expanding it lists the elements' fields. */
  array: boolean;
  /** Length of the path of the enclosing expanded array, when this column is inside one. */
  arrayDepth?: number;
  /** Present when the column is expanded. */
  children?: ColumnNode[];
}

export interface Leaf {
  node: ColumnNode;
  /** Dotted keys of the expanded groups this leaf opens / closes (outermost first). */
  starts: string[];
  ends: string[];
}

export const MISSING = Symbol('missing');

/** Max array elements shown as sub-rows per document. */
export const MAX_ELEMENTS = 20;

export function isSubdocument(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && !isEjsonWrapper(v);
}

const hasFields = (v: unknown) => isSubdocument(v) && Object.keys(v).length > 0;
const hasSubdocElements = (v: unknown) => Array.isArray(v) && v.some(hasFields);

/** Value at `path`, or MISSING when a segment is absent or a parent isn't a sub-document. */
export function getAt(doc: unknown, path: string[]): unknown {
  let current: unknown = doc;
  for (const segment of path) {
    if (!isSubdocument(current) || !(segment in current)) return MISSING;
    current = current[segment];
  }
  return current;
}

/** Sub-documents found at an expanded path, looking inside the elements of expanded arrays. */
function objectsAt(rows: unknown[], path: string[]): Record<string, unknown>[] {
  let current = rows;
  for (const segment of path) {
    const next: unknown[] = [];
    for (const v of current) {
      if (!isSubdocument(v) || !(segment in v)) continue;
      const x = v[segment];
      if (Array.isArray(x)) next.push(...x);
      else next.push(x);
    }
    current = next;
  }
  return current.filter(isSubdocument);
}

export function buildColumns(
  rows: Record<string, unknown>[],
  expanded: Set<string>,
  prefix: string[] = [],
  arrayDepth?: number,
): ColumnNode[] {
  const objects = objectsAt(rows, prefix);
  const keys = new Set<string>();
  for (const obj of objects) for (const key of Object.keys(obj)) keys.add(key);
  const ordered = [...keys];
  if (!prefix.length && ordered.includes('_id')) ordered.unshift(...ordered.splice(ordered.indexOf('_id'), 1));

  return ordered.map((name) => {
    const path = [...prefix, name];
    const key = path.join('.');
    // Arrays inside array elements aren't expanded: one level of sub-rows only.
    const array = arrayDepth === undefined && objects.some((o) => hasSubdocElements(o[name]));
    const expandable = array || objects.some((o) => hasFields(o[name]));
    const node: ColumnNode = { path, key, expandable, array, arrayDepth };
    if (expandable && expanded.has(key)) {
      node.children = buildColumns(rows, expanded, path, array ? path.length : arrayDepth);
    }
    return node;
  });
}

export function leaves(nodes: ColumnNode[]): Leaf[] {
  const out: Leaf[] = [];
  for (const node of nodes) {
    if (!node.children) {
      out.push({ node, starts: [], ends: [] });
      continue;
    }
    const inner = leaves(node.children);
    inner[0].starts.unshift(node.key);
    inner[inner.length - 1].ends.unshift(node.key);
    out.push(...inner);
  }
  return out;
}

export function leafCount(node: ColumnNode): number {
  return node.children ? node.children.reduce((n, c) => n + leafCount(c), 0) : 1;
}

/** Number of sub-rows a document needs: one per shown element of its expanded arrays (+1 for "more"). */
export function rowHeight(doc: Record<string, unknown>, nodes: ColumnNode[], cap = MAX_ELEMENTS): number {
  let height = 1;
  for (const node of nodes) {
    if (!node.children) continue;
    const value = getAt(doc, node.path);
    if (isSubdocument(value)) height = Math.max(height, rowHeight(doc, node.children, cap));
    else if (node.array && Array.isArray(value) && value.length) {
      height = Math.max(height, Math.min(value.length, cap) + (value.length > cap ? 1 : 0));
    }
  }
  return height;
}

/** `key` plus every expandable path below it, for "expand all" (Alt+click). */
export function expandableBelow(rows: Record<string, unknown>[], node: ColumnNode): string[] {
  const out = [node.key];
  const all = new Set<string>();
  const walk = (prefix: string[], depth: number | undefined) => {
    for (const node of buildColumns(rows, all, prefix, depth)) {
      if (!node.expandable) continue;
      out.push(node.key);
      walk(node.path, node.array ? node.path.length : depth);
    }
  };
  walk(node.path, node.array ? node.path.length : node.arrayDepth);
  return out;
}
