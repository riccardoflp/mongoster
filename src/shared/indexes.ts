// Index definitions as the Indexes tab shows and edits them: the keys and options one would pass to
// createIndex, derived from what listIndexes reports, and what it takes to change one into another.
// Values are relaxed-EJSON plain values, as everywhere between the webview and the extension host.
import { isPlainObject, prettyShell } from './query';

export interface IndexSpec {
  keys: Record<string, unknown>;
  /** createIndex options; `name` only when it isn't the one MongoDB would generate from the keys. */
  options: Record<string, unknown>;
}

/** What listIndexes reports but createIndex doesn't need back, or that says nothing. */
const REPORTED_ONLY = new Set(['v', 'key', 'name', 'ns', 'background', 'textIndexVersion', '2dsphereIndexVersion']);
const FLAGS = ['unique', 'sparse', 'hidden'];
/** Index types given as the value of a key, besides 1 and -1. */
export const KEY_TYPES = ['text', '2dsphere', '2d', 'hashed'];
/** Options collMod changes on an existing index, without building it again. */
const IN_PLACE = new Set(['hidden', 'expireAfterSeconds']);

/** The name MongoDB gives an index created without one. */
export function defaultIndexName(keys: Record<string, unknown>): string {
  return Object.entries(keys)
    .map(([field, value]) => `${field}_${String(value)}`)
    .join('_');
}

/**
 * Drops what means "default" (false flags, the generated name, text weights of 1), so that equal
 * definitions compare equal.
 */
export function normalizeSpec(spec: IndexSpec): IndexSpec {
  const options: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.options)) {
    if (v === undefined || v === null || k === 'background') continue;
    if (FLAGS.includes(k) && v === false) continue;
    if (k === 'name' && v === defaultIndexName(spec.keys)) continue;
    if (k === 'weights' && isPlainObject(v)) {
      const weights = Object.entries(v).filter(([field, w]) => w !== 1 || spec.keys[field] !== 'text');
      if (weights.length) options[k] = Object.fromEntries(weights);
      continue;
    }
    options[k] = v;
  }
  return { keys: spec.keys, options };
}

/**
 * The createIndex arguments that would build an index again as listIndexes reports it. A text
 * index is stored as `{ _fts: "text", _ftsx: 1 }` plus weights: its fields are put back in the keys.
 */
export function editableSpec(name: string, key: Record<string, unknown>, reported: Record<string, unknown>): IndexSpec {
  const options: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(reported)) if (!REPORTED_ONLY.has(k)) options[k] = v;

  let keys = key;
  if ('_fts' in key) {
    const weights = isPlainObject(options.weights) ? options.weights : {};
    keys = {};
    for (const [field, value] of Object.entries(key)) {
      if (field === '_fts') for (const f of Object.keys(weights)) keys[f] = 'text';
      else if (field !== '_ftsx') keys[field] = value;
    }
    if (options.default_language === 'english') delete options.default_language;
    if (options.language_override === 'language') delete options.language_override;
  }
  if (isPlainObject(options.collation)) {
    const { version: _version, ...collation } = options.collation;
    options.collation = collation;
  }
  return normalizeSpec({ keys, options: { ...options, name } });
}

export function indexName(spec: IndexSpec): string {
  return typeof spec.options.name === 'string' && spec.options.name ? spec.options.name : defaultIndexName(spec.keys);
}

export type IndexChange =
  | { kind: 'none' }
  /** collMod on the existing index: nothing is built again. */
  | { kind: 'modify'; hidden?: boolean; expireAfterSeconds?: number }
  /** MongoDB can't change the rest: the index is dropped and built again. `changed` lists what differs. */
  | { kind: 'recreate'; changed: string[] };

/** JSON with the keys of objects sorted: the order of options doesn't make two definitions differ. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** What turning the index `current` into `next` takes. */
export function planIndexChange(current: IndexSpec, next: IndexSpec): IndexChange {
  const a = normalizeSpec(current);
  const b = normalizeSpec(next);
  const changed: string[] = [];
  // The order of the keys is part of the index.
  if (JSON.stringify(a.keys) !== JSON.stringify(b.keys)) changed.push('keys');
  if (indexName(a) !== indexName(b)) changed.push('name');
  for (const k of new Set([...Object.keys(a.options), ...Object.keys(b.options)])) {
    if (k !== 'name' && stable(a.options[k]) !== stable(b.options[k])) changed.push(k);
  }
  if (!changed.length) return { kind: 'none' };
  // A TTL can be changed in place, but not added to or removed from an index.
  const ttl = typeof a.options.expireAfterSeconds === 'number' && typeof b.options.expireAfterSeconds === 'number';
  if (changed.every((k) => IN_PLACE.has(k)) && (ttl || !changed.includes('expireAfterSeconds'))) {
    return {
      kind: 'modify',
      ...(changed.includes('hidden') && { hidden: b.options.hidden === true }),
      ...(changed.includes('expireAfterSeconds') && { expireAfterSeconds: b.options.expireAfterSeconds as number }),
    };
  }
  return { kind: 'recreate', changed };
}

/** The mongosh command creating the index. */
export function indexCommand(collection: string, spec: IndexSpec): string {
  const { keys, options } = normalizeSpec(spec);
  const args = [prettyShell(keys), ...(Object.keys(options).length ? [prettyShell(options)] : [])];
  return `db.getCollection(${JSON.stringify(collection)}).createIndex(${args.join(', ')})`;
}

const TTL_UNITS: [string, number][] = [
  ['days', 86400],
  ['hours', 3600],
  ['minutes', 60],
  ['seconds', 1],
];

/** Seconds as a count of the largest unit that divides them: 86400 -> 1 days. */
export function ttlParts(seconds: number): { value: number; unit: string } {
  const [unit, size] = TTL_UNITS.find(([, s]) => seconds !== 0 && seconds % s === 0) ?? TTL_UNITS[3];
  return { value: seconds / size, unit };
}

export function ttlSeconds(value: number, unit: string): number {
  return value * (TTL_UNITS.find(([u]) => u === unit)?.[1] ?? 1);
}

export const TTL_UNIT_NAMES = TTL_UNITS.map(([u]) => u).reverse();
