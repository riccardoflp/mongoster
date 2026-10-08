// Column model for the grid: top-level fields, with sub-documents optionally expanded
// into dotted child columns (address -> address.city, address.zip, ...).
import { isEjsonWrapper, isPlainObject } from '../shared/query';

export interface ColumnNode {
  path: string[];
  /** Dotted path, as used in filters and sorts. */
  key: string;
  /** Some document on the page has a non-empty sub-document here. */
  expandable: boolean;
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

export function isSubdocument(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && !isEjsonWrapper(v);
}

/** Value at `path`, or MISSING when a segment is absent or a parent isn't a sub-document. */
export function getAt(doc: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = doc;
  for (const segment of path) {
    if (!isSubdocument(current) || !(segment in current)) return MISSING;
    current = current[segment];
  }
  return current;
}

export function buildColumns(rows: Record<string, unknown>[], expanded: Set<string>, prefix: string[] = []): ColumnNode[] {
  const objects = prefix.length ? rows.map((r) => getAt(r, prefix)).filter(isSubdocument) : rows;
  const keys = new Set<string>();
  for (const obj of objects) for (const key of Object.keys(obj)) keys.add(key);
  const ordered = [...keys];
  if (!prefix.length && ordered.includes('_id')) ordered.unshift(...ordered.splice(ordered.indexOf('_id'), 1));

  return ordered.map((name) => {
    const path = [...prefix, name];
    const key = path.join('.');
    const expandable = objects.some((o) => isSubdocument(o[name]) && Object.keys(o[name] as object).length > 0);
    const node: ColumnNode = { path, key, expandable };
    if (expandable && expanded.has(key)) node.children = buildColumns(rows, expanded, path);
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

/** `key` plus every expandable path below it, for "expand all" (Alt+click). */
export function expandableBelow(rows: Record<string, unknown>[], path: string[]): string[] {
  const out = [path.join('.')];
  const all = new Set<string>();
  const walk = (prefix: string[]) => {
    for (const node of buildColumns(rows, all, prefix)) {
      if (!node.expandable) continue;
      out.push(node.key);
      walk(node.path);
    }
  };
  walk(path);
  return out;
}
