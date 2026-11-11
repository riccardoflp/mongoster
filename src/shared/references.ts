// Following references from the table: the references found by the relationship analysis that leave or
// reach a collection, the collection and filter a cell's value leads to, and the filters that find the
// documents referencing a row. Values are relaxed EJSON, as the table has them; filters are mongosh text.
import { isEjsonWrapper, isPlainObject, toShell } from './query';
import type { Relation } from './relations';

/** A verified reference between two collections of a database. */
export interface Reference {
  from: string;
  /** Dotted path, as in a filter: "items.productId". */
  field: string;
  /** For display, with [] for array elements: "items[].productId". */
  fieldLabel: string;
  to: string;
  /** "_id", or a field with a unique index. */
  toField: string;
  /** The field holds several references (an array). */
  many: boolean;
  /** The values are DBRefs ({ $ref, $id }). */
  dbref: boolean;
}

/** The references leaving a collection (its fields) and those reaching it (fields of other collections). */
export interface CollectionReferences {
  outgoing: Reference[];
  incoming: Reference[];
}

/** Where a click leads: a collection and the filter on it. */
export interface ReferenceTarget {
  collection: string;
  /** mongosh syntax. */
  filter: string;
  /** "users._id", "orders.items[].productId" */
  label: string;
  /** Values looked up (several for an array of references). */
  count: number;
}

/** The references between collections of a relationship analysis; views link to their source and are left out. */
export function collectionReferences(relations: Relation[], collection: string): CollectionReferences {
  const refs: Reference[] = relations
    .filter((r) => r.kind !== 'view')
    .map((r) => ({ from: r.from, field: r.field, fieldLabel: r.fieldLabel, to: r.to, toField: r.toField, many: r.many, dbref: r.kind === 'dbref' }));
  return { outgoing: refs.filter((r) => r.from === collection), incoming: refs.filter((r) => r.to === collection) };
}

type DbRef = { $ref: string; $id: unknown; $db?: unknown };
const isDbRef = (v: unknown): v is DbRef => isPlainObject(v) && typeof v.$ref === 'string' && '$id' in v;

/** A value that can be a reference: an ObjectId, a UUID, a string or a number. */
export function isReferenceValue(v: unknown): boolean {
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (!isEjsonWrapper(v)) return false;
  const key = Object.keys(v)[0];
  if (key === '$oid' || key === '$uuid' || key.startsWith('$number')) return true;
  if (key === '$binary') {
    const sub = (v.$binary as { subType?: string } | undefined)?.subType;
    return sub === '04' || sub === '4';
  }
  return false;
}

/** Distinct values, in their order (equal when their EJSON is). */
function distinct(values: unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const v of values) {
    const key = JSON.stringify(v);
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()];
}

/** `{ field: value }`, or `{ field: { $in: [...] } }` for several. */
function filterOn(field: string, ids: unknown[]): string {
  return toShell({ [field]: ids.length === 1 ? ids[0] : { $in: ids } });
}

/**
 * Where the value of a cell leads. `key` is the column's dotted path without array positions (a cell of an
 * expanded array holds one element); an array of references leads to all of them with $in. Several targets
 * when the field references several collections (the user picks one), none when it isn't a reference or
 * the value can't be one. DBRefs lead to the collection they name, in this database only.
 */
export function referenceTargets(outgoing: Reference[], key: string, value: unknown, database: string): ReferenceTarget[] {
  // The $id column of an expanded DBRef.
  const dbrefId = key.endsWith('.$id') ? key.slice(0, -4) : undefined;
  const refs = outgoing.filter((r) => r.field === key || (r.dbref && r.field === dbrefId));
  if (!refs.length || value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  const out: ReferenceTarget[] = [];
  const add = (collection: string, toField: string, ids: unknown[]) => {
    const label = `${collection}.${toField}`;
    if (!ids.length || out.some((t) => t.label === label)) return;
    out.push({ collection, filter: filterOn(toField, ids), label, count: ids.length });
  };
  for (const r of refs) {
    if (r.dbref && dbrefId === undefined) {
      // DBRefs name their collection: each of those the analysis verified gets the ids pointing to it.
      const ids = values.filter((v): v is DbRef => isDbRef(v) && v.$ref === r.to && (v.$db === undefined || v.$db === database)).map((v) => v.$id);
      add(r.to, '_id', distinct(ids.filter(isReferenceValue)));
    } else {
      add(r.to, r.toField, distinct(values.filter(isReferenceValue)));
    }
  }
  return out;
}

/** The value at a dotted path of a document, without stepping into arrays. */
function fieldValue(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const part of path.split('.')) {
    if (!isPlainObject(cur) || isEjsonWrapper(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * The documents referencing a row: for each reference reaching its collection, the referencing collection
 * filtered on its field with the row's `_id` (or the unique field referenced). Arrays of references and
 * fields of array elements match an element, as MongoDB does.
 */
export function referencingTargets(incoming: Reference[], doc: Record<string, unknown>): ReferenceTarget[] {
  const out: ReferenceTarget[] = [];
  for (const r of incoming) {
    const value = fieldValue(doc, r.toField);
    if (!isReferenceValue(value)) continue;
    const field = r.dbref ? `${r.field}.$id` : r.field;
    const filter = filterOn(field, [value]);
    if (out.some((t) => t.collection === r.from && t.filter === filter)) continue;
    out.push({ collection: r.from, filter, label: `${r.from}.${r.fieldLabel}`, count: 1 });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Column keys whose cells can be references (quick test before looking at the values). */
export function referenceKeys(outgoing: Reference[]): Set<string> {
  const keys = new Set<string>();
  for (const r of outgoing) {
    keys.add(r.field);
    if (r.dbref) keys.add(`${r.field}.$id`);
  }
  return keys;
}
