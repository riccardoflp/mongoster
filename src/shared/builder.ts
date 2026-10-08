// The visual filter builder's model: a list of conditions (field, operator, value as mongosh text)
// matched all together or any of them, converted to and from the filter object. Filters the rows can't
// express (nested $or, $elemMatch, $expr, …) are left to the text box.
import { isEjsonWrapper, isOperatorObject, isPlainObject, parseQuery, toShell } from './query';

export type BuilderOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'regex' | 'exists' | 'missing' | 'type' | 'size';

export interface BuilderRow {
  field: string;
  op: BuilderOp;
  /** Mongosh text: "Mario", 42, ISODate("…"), /^a/i, [1, 2]; the type name for `type`; unused for exists / missing. */
  value: string;
}

export interface BuilderQuery {
  /** and: every condition ($and, or one object); or: any of them ($or). */
  combine: 'and' | 'or';
  rows: BuilderRow[];
}

export const BUILDER_OPS: { op: BuilderOp; label: string; title: string }[] = [
  { op: 'eq', label: '=', title: 'equals (an array field: contains the value)' },
  { op: 'ne', label: '≠', title: 'not equal ($ne)' },
  { op: 'gt', label: '>', title: 'greater than ($gt)' },
  { op: 'gte', label: '≥', title: 'greater than or equal ($gte)' },
  { op: 'lt', label: '<', title: 'less than ($lt)' },
  { op: 'lte', label: '≤', title: 'less than or equal ($lte)' },
  { op: 'in', label: 'in', title: 'one of the values ($in)' },
  { op: 'nin', label: 'not in', title: 'none of the values ($nin)' },
  { op: 'regex', label: 'matches', title: 'matches the regular expression ($regex)' },
  { op: 'exists', label: 'exists', title: 'the field is present ($exists: true)' },
  { op: 'missing', label: 'missing', title: 'the field is absent ($exists: false)' },
  { op: 'type', label: 'type', title: 'the value has this BSON type ($type)' },
  { op: 'size', label: 'size', title: 'an array with this many elements ($size)' },
];

export const BUILDER_TYPES = ['string', 'number', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId', 'object', 'array', 'null', 'regex', 'binData', 'timestamp'];

/** Operators without a value. */
export const NO_VALUE: BuilderOp[] = ['exists', 'missing'];

const COMPARISON: Partial<Record<string, BuilderOp>> = { $eq: 'eq', $ne: 'ne', $gt: 'gt', $gte: 'gte', $lt: 'lt', $lte: 'lte' };
const OPERATOR: Partial<Record<BuilderOp, string>> = { eq: '$eq', ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', in: '$in', nin: '$nin', regex: '$regex', type: '$type', size: '$size' };

const isRegex = (v: unknown) => isEjsonWrapper(v) && '$regularExpression' in v;

/** The rows of one field's condition; undefined when it uses something the builder doesn't show. */
function rowsOf(field: string, v: unknown): BuilderRow[] | undefined {
  if (isRegex(v)) return [{ field, op: 'regex', value: toShell(v) }];
  if (!isOperatorObject(v)) {
    // Field names starting with $ inside a document are operators the builder doesn't know.
    if (isPlainObject(v) && !isEjsonWrapper(v) && Object.keys(v).some((k) => k.startsWith('$'))) return undefined;
    return [{ field, op: 'eq', value: toShell(v) }];
  }
  const rows: BuilderRow[] = [];
  for (const [key, x] of Object.entries(v)) {
    const comparison = COMPARISON[key];
    if (comparison) rows.push({ field, op: comparison, value: toShell(x) });
    else if (key === '$in' || key === '$nin') {
      if (!Array.isArray(x)) return undefined;
      rows.push({ field, op: key === '$in' ? 'in' : 'nin', value: toShell(x) });
    } else if (key === '$exists') {
      if (typeof x !== 'boolean' && typeof x !== 'number') return undefined;
      rows.push({ field, op: x ? 'exists' : 'missing', value: '' });
    } else if (key === '$regex') {
      const options = v.$options;
      if (options !== undefined && typeof options !== 'string') return undefined;
      if (typeof x === 'string') rows.push({ field, op: 'regex', value: toShell({ $regularExpression: { pattern: x, options: options ?? '' } }) });
      else if (isRegex(x) && !options) rows.push({ field, op: 'regex', value: toShell(x) });
      else return undefined;
    } else if (key === '$options') {
      if (!('$regex' in v)) return undefined;
    } else if (key === '$type') {
      if (typeof x !== 'string') return undefined;
      rows.push({ field, op: 'type', value: x });
    } else if (key === '$size') {
      if (typeof x !== 'number') return undefined;
      rows.push({ field, op: 'size', value: String(x) });
    } else return undefined;
  }
  return rows;
}

/** The builder rows of a filter; undefined when the filter can't be shown as rows. */
export function filterToRows(filter: unknown): BuilderQuery | undefined {
  if (!isPlainObject(filter)) return undefined;
  const keys = Object.keys(filter);
  if (keys.length === 1 && (keys[0] === '$or' || keys[0] === '$and')) {
    const combine = keys[0] === '$or' ? 'or' : 'and';
    const list = filter[keys[0]];
    if (!Array.isArray(list) || !list.length) return undefined;
    const rows: BuilderRow[] = [];
    for (const item of list) {
      if (!isPlainObject(item)) return undefined;
      const fields = Object.keys(item);
      if (fields.length !== 1 || fields[0].startsWith('$')) return undefined;
      const found = rowsOf(fields[0], item[fields[0]]);
      // Within $or, one condition per item: { a: { $gt: 1, $lt: 5 } } is two conditions together.
      if (!found || (combine === 'or' && found.length !== 1)) return undefined;
      rows.push(...found);
    }
    return { combine, rows };
  }
  const rows: BuilderRow[] = [];
  for (const key of keys) {
    if (key.startsWith('$')) return undefined;
    const found = rowsOf(key, filter[key]);
    if (!found) return undefined;
    rows.push(...found);
  }
  return { combine: 'and', rows };
}

/** A value typed in the builder: mongosh syntax, or else the text itself as a string. */
export function parseValue(text: string): unknown {
  const trimmed = text.trim();
  try {
    const parsed = parseQuery(`[${trimmed}\n]`);
    if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
  } catch {
    // Not mongosh syntax: plain text.
  }
  return trimmed;
}

/** The values of `in` / `not in`: an array literal, or values separated by commas. */
function parseList(text: string): unknown[] {
  const trimmed = text.trim();
  try {
    const parsed = parseQuery(`[${trimmed}\n]`);
    if (Array.isArray(parsed)) return parsed.length === 1 && Array.isArray(parsed[0]) && trimmed.startsWith('[') ? parsed[0] : parsed;
  } catch {
    // Plain words: one string each.
  }
  return trimmed.split(',').map((s) => parseValue(s)).filter((s) => s !== '');
}

/** Whether the row is filled in enough to be part of the filter. */
export function rowComplete(row: BuilderRow): boolean {
  return !!row.field.trim() && (NO_VALUE.includes(row.op) || !!row.value.trim());
}

/** The value of a row's operator. Throws when the value doesn't fit the operator. */
function operand(row: BuilderRow): unknown {
  switch (row.op) {
    case 'in':
    case 'nin':
      return parseList(row.value);
    case 'regex': {
      const v = parseValue(row.value);
      return isRegex(v) ? v : { $regularExpression: { pattern: typeof v === 'string' ? v : row.value.trim(), options: '' } };
    }
    case 'type':
      return row.value.trim();
    case 'size': {
      const n = parseValue(row.value);
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error(`${row.field}: size needs a whole number`);
      return n;
    }
    default:
      return parseValue(row.value);
  }
}

/** The condition of a row on its own: { field: value } for = and regular expressions. */
function plain(row: BuilderRow): unknown {
  if (row.op === 'exists' || row.op === 'missing') return { $exists: row.op === 'exists' };
  const value = operand(row);
  // An object value with = would be read as operators if its keys start with $: keep $eq then.
  if (row.op === 'eq') return isPlainObject(value) && !isEjsonWrapper(value) && Object.keys(value).some((k) => k.startsWith('$')) ? { $eq: value } : value;
  if (row.op === 'regex') return value;
  return { [OPERATOR[row.op]!]: value };
}

/** The condition of a row as an operator object, to merge with the others on the same field. */
function asOperator(row: BuilderRow): Record<string, unknown> {
  if (row.op === 'exists' || row.op === 'missing') return { $exists: row.op === 'exists' };
  return { [OPERATOR[row.op]!]: operand(row) };
}

/**
 * The filter of the builder's (complete) rows. With `and`, the conditions on the same field are merged
 * into one object ({ age: { $gte: 20, $lte: 30 } }), or written as $and when an operator repeats.
 */
export function rowsToFilter(q: BuilderQuery): Record<string, unknown> {
  const rows = q.rows.filter(rowComplete).map((r) => ({ ...r, field: r.field.trim() }));
  if (!rows.length) return {};
  if (q.combine === 'or') return rows.length === 1 ? { [rows[0].field]: plain(rows[0]) } : { $or: rows.map((r) => ({ [r.field]: plain(r) })) };
  const byField = new Map<string, BuilderRow[]>();
  for (const r of rows) byField.set(r.field, [...(byField.get(r.field) ?? []), r]);
  const filter: Record<string, unknown> = {};
  for (const [field, list] of byField) {
    if (list.length === 1) {
      filter[field] = plain(list[0]);
      continue;
    }
    const merged: Record<string, unknown> = {};
    for (const r of list) {
      const [key, value] = Object.entries(asOperator(r))[0];
      if (key in merged) return { $and: rows.map((x) => ({ [x.field]: plain(x) })) };
      merged[key] = value;
    }
    filter[field] = merged;
  }
  return filter;
}
