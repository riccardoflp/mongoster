// Comparing documents of two collections: what makes two documents equal (field order, int vs double,
// ignored fields) and their differences field by field. Values are canonical EJSON
// ({ $numberInt: "1" }, { $date: { $numberLong: "…" } }), so every BSON type is told apart.
import { isEjsonWrapper, isPlainObject } from './query';

export interface CompareOptions {
  /** Filter of both sides, mongosh syntax ('' for all documents). */
  filter: string;
  /** Fields left out of the comparison (dotted paths; inside arrays the elements' fields). */
  ignore: string[];
  /** { a, b } equals { b, a }. */
  ignoreOrder: boolean;
  /** 1 (int) equals 1.0 (double) and NumberLong(1). */
  numbersByValue: boolean;
}

export type DiffKind = 'different' | 'onlyLeft' | 'onlyRight';

export interface FieldDiff {
  path: string;
  /** Relaxed EJSON; absent when the field is missing on that side. */
  left?: unknown;
  right?: unknown;
  /** BSON types, when the values look the same and differ by type only (int and double…). */
  types?: [string, string];
}

export interface CompareCounts {
  identical: number;
  different: number;
  onlyLeft: number;
  onlyRight: number;
}

const NUMBERS = new Set(['$numberInt', '$numberLong', '$numberDouble']);

/** A number wrapper's value as text that is the same for equal values of int, long and double. */
function numberText(key: string, value: string): string {
  if (key === '$numberLong') return BigInt(value).toString();
  const n = Number(value);
  if (Number.isInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER) return BigInt(n).toString();
  return Object.is(n, -0) ? '0' : String(n);
}

/** Splits the ignored paths once: path → whether to drop the field here. */
function ignoredAt(ignore: string[], path: string): boolean {
  return ignore.includes(path);
}

/** The value as compared: ignored fields removed, numbers by value, keys sorted (as asked). */
export function normalize(v: unknown, opts: Pick<CompareOptions, 'ignore' | 'ignoreOrder' | 'numbersByValue'>, path = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x, opts, path));
  if (!isPlainObject(v)) return v;
  if (isEjsonWrapper(v)) {
    const [key] = Object.keys(v);
    if (opts.numbersByValue && NUMBERS.has(key) && typeof v[key] === 'string') {
      const text = v[key] as string;
      return /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(text) || key === '$numberLong' ? { $number: numberText(key, text) } : { $number: text };
    }
    return v;
  }
  let entries = Object.entries(v)
    .filter(([k]) => !ignoredAt(opts.ignore, path ? `${path}.${k}` : k))
    .map(([k, x]) => [k, normalize(x, opts, path ? `${path}.${k}` : k)] as const);
  if (opts.ignoreOrder) entries = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

/** Text that is the same for documents that compare equal (to hash). */
export function comparable(doc: unknown, opts: Pick<CompareOptions, 'ignore' | 'ignoreOrder' | 'numbersByValue'>): string {
  return JSON.stringify(normalize(doc, opts));
}

const MAX_FIELDS = 200;

const TYPE_NAMES: Record<string, string> = { $numberInt: 'int', $numberLong: 'long', $numberDouble: 'double', $numberDecimal: 'decimal', $date: 'date', $timestamp: 'timestamp', $oid: 'objectId', $binary: 'binData', $regularExpression: 'regex', $symbol: 'symbol' };

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isPlainObject(v)) return (isEjsonWrapper(v) && TYPE_NAMES[Object.keys(v)[0]]) || 'object';
  return typeof v;
}

/**
 * Differences between two canonical-EJSON documents, by field: sub-documents and arrays of the same
 * length are compared inside, anything else as a whole. `relax` turns values into what to show.
 */
export function fieldDiff(
  left: unknown,
  right: unknown,
  opts: Pick<CompareOptions, 'ignore' | 'ignoreOrder' | 'numbersByValue'>,
  relax: (v: unknown) => unknown = (v) => v,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  const same = (a: unknown, b: unknown, path: string) =>
    JSON.stringify(normalize(a, { ...opts, ignoreOrder: true }, path)) === JSON.stringify(normalize(b, { ...opts, ignoreOrder: true }, path));
  const walk = (a: unknown, b: unknown, path: string, arrayPath: string) => {
    if (out.length >= MAX_FIELDS) return;
    if (same(a, b, arrayPath)) return;
    const objects = isPlainObject(a) && !isEjsonWrapper(a) && isPlainObject(b) && !isEjsonWrapper(b);
    if (objects) {
      const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !(k in a))];
      for (const k of keys) {
        const sub = arrayPath ? `${arrayPath}.${k}` : k;
        if (ignoredAt(opts.ignore, sub)) continue;
        const p = path ? `${path}.${k}` : k;
        if (!(k in b)) out.push({ path: p, left: relax(a[k]) });
        else if (!(k in a)) out.push({ path: p, right: relax(b[k]) });
        else walk(a[k], b[k], p, sub);
        if (out.length >= MAX_FIELDS) return;
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((x, i) => walk(x, b[i], path ? `${path}.${i}` : String(i), arrayPath));
      return;
    }
    const [l, r] = [relax(a), relax(b)];
    const looksSame = JSON.stringify(l) === JSON.stringify(r);
    out.push({ path: path || '(document)', left: l, right: r, ...(looksSame && { types: [typeName(a), typeName(b)] as [string, string] }) });
  };
  walk(left, right, '', '');
  return out;
}

/** "a, b, c (+4)" */
export function fieldsSummary(fields: FieldDiff[], max = 4): string {
  const names = fields.map((f) => f.path);
  return names.length > max ? `${names.slice(0, max).join(', ')} (+${names.length - max})` : names.join(', ');
}

/** Comma or space separated field paths. */
export function parseIgnore(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}
