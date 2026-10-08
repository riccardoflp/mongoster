// Schema analysis of a sample of documents in canonical Extended JSON: which fields exist, how often,
// with which types and values. Runs in the extension host; the webview only renders the summary.
import { isEjsonWrapper, isPlainObject, relaxEjson } from './query';

export type BsonType =
  | 'string'
  | 'int'
  | 'double'
  | 'long'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'objectId'
  | 'null'
  | 'object'
  | 'array'
  | 'binData'
  | 'regex'
  | 'timestamp'
  | 'javascript'
  | 'symbol'
  | 'minKey'
  | 'maxKey'
  | 'undefined'
  | 'dbPointer';

export interface ValueCount {
  /** Relaxed EJSON. */
  value: unknown;
  count: number;
}

/** A histogram bin: values `from` (inclusive) to `to` (exclusive), as relaxed EJSON. */
export interface Bin {
  from: unknown;
  to: unknown;
  count: number;
}

export interface TypeSchema {
  type: BsonType;
  count: number;
  /** Most frequent values, for types where a value can be filtered on. */
  top?: ValueCount[];
  /** Distinct values seen; at most `DISTINCT_CAP` are tracked (`distinctCapped`). */
  distinct?: number;
  distinctCapped?: boolean;
  /** Numbers and dates. */
  min?: unknown;
  max?: unknown;
  /** Numbers and dates with more than a few distinct values. */
  bins?: Bin[];
  /** Arrays: their lengths, and their elements described as a field. */
  lengths?: { min: number; max: number; avg: number };
  elements?: FieldSchema;
}

export interface FieldSchema {
  name: string;
  /** Dotted path usable in a filter (array elements don't add a segment). */
  path: string;
  /** Path for display, with `[]` for array elements: `items[].sku`. */
  label: string;
  /** Values present, null included. */
  count: number;
  /** Objects in which the field could appear: the documents for top-level fields. */
  of: number;
  types: TypeSchema[];
  /** Fields of the object values, merged. */
  fields?: FieldSchema[];
  /** More than `FIELD_CAP` different keys: the rest were not analyzed. */
  moreFields?: boolean;
}

export interface SchemaSummary {
  sampled: number;
  fields: FieldSchema[];
  moreFields?: boolean;
}

export const DISTINCT_CAP = 1000;
const FIELD_CAP = 500;
const TOP = 10;
/** With at most this many distinct values a number or date shows them instead of a histogram. */
const FEW = 10;
const BINS = 12;

const WRAPPER_TYPES: Record<string, BsonType> = {
  $oid: 'objectId',
  $date: 'date',
  $numberInt: 'int',
  $numberDouble: 'double',
  $numberLong: 'long',
  $numberDecimal: 'decimal',
  $binary: 'binData',
  $uuid: 'binData',
  $regularExpression: 'regex',
  $timestamp: 'timestamp',
  $code: 'javascript',
  $symbol: 'symbol',
  $minKey: 'minKey',
  $maxKey: 'maxKey',
  $undefined: 'undefined',
  $dbPointer: 'dbPointer',
};

const VALUE_TYPES = new Set<BsonType>(['string', 'int', 'double', 'long', 'decimal', 'bool', 'date', 'objectId']);
const NUMERIC_TYPES = new Set<BsonType>(['int', 'double', 'long', 'decimal']);

export function bsonType(v: unknown): BsonType {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (isEjsonWrapper(v)) return WRAPPER_TYPES[Object.keys(v)[0]] ?? 'object';
  return 'object';
}

/** Numbers and dates as a JS number (dates in ms), for ranges and histograms. */
function numeric(v: unknown, type: BsonType): number | undefined {
  if (typeof v === 'number') return v;
  if (!isPlainObject(v)) return undefined;
  if (NUMERIC_TYPES.has(type)) return Number(Object.values(v)[0]);
  if (type === 'date') {
    const d = v.$date;
    return isPlainObject(d) ? Number(d.$numberLong) : typeof d === 'string' ? Date.parse(d) : Number(d);
  }
  return undefined;
}

class TypeAcc {
  count = 0;
  readonly values = new Map<string, ValueCount>();
  capped = false;
  readonly numbers: number[] = [];
  min?: { n: number; value: unknown };
  max?: { n: number; value: unknown };
  readonly lengths: number[] = [];
  elements?: FieldAcc;

  constructor(readonly type: BsonType) {}
}

class FieldAcc {
  count = 0;
  readonly types = new Map<BsonType, TypeAcc>();
  /** Object values seen: the denominator of the children's presence. */
  objects = 0;
  readonly fields = new Map<string, FieldAcc>();
  moreFields = false;

  add(v: unknown): void {
    this.count++;
    const type = bsonType(v);
    let t = this.types.get(type);
    if (!t) this.types.set(type, (t = new TypeAcc(type)));
    t.count++;
    if (type === 'object') {
      this.addObject(v as Record<string, unknown>);
    } else if (type === 'array') {
      const items = v as unknown[];
      t.lengths.push(items.length);
      t.elements ??= new FieldAcc();
      for (const item of items) t.elements.add(item);
    } else if (VALUE_TYPES.has(type)) {
      const key = JSON.stringify(v);
      const seen = t.values.get(key);
      if (seen) seen.count++;
      else if (t.values.size < DISTINCT_CAP) t.values.set(key, { value: v, count: 1 });
      else t.capped = true;
      const n = numeric(v, type);
      if (n !== undefined && !Number.isNaN(n)) {
        t.numbers.push(n);
        if (!t.min || n < t.min.n) t.min = { n, value: v };
        if (!t.max || n > t.max.n) t.max = { n, value: v };
      }
    }
  }

  addObject(obj: Record<string, unknown>): void {
    this.objects++;
    for (const [key, value] of Object.entries(obj)) {
      let f = this.fields.get(key);
      if (!f) {
        if (this.fields.size >= FIELD_CAP) {
          this.moreFields = true;
          continue;
        }
        this.fields.set(key, (f = new FieldAcc()));
      }
      f.add(value);
    }
  }
}

export function analyzeSchema(docs: unknown[]): SchemaSummary {
  const root = new FieldAcc();
  for (const doc of docs) if (isPlainObject(doc)) root.addObject(doc);
  return { sampled: root.objects, fields: children(root, '', ''), ...(root.moreFields && { moreFields: true }) };
}

function children(acc: FieldAcc, path: string, label: string): FieldSchema[] {
  return [...acc.fields].map(([name, f]) =>
    field(f, name, path ? `${path}.${name}` : name, label ? `${label}.${name}` : name, acc.objects),
  );
}

function field(acc: FieldAcc, name: string, path: string, label: string, of: number): FieldSchema {
  const result: FieldSchema = {
    name,
    path,
    label,
    count: acc.count,
    of,
    types: [...acc.types.values()].sort((a, b) => b.count - a.count).map((t) => typeSchema(t, path, label)),
  };
  if (acc.fields.size) result.fields = children(acc, path, label);
  if (acc.moreFields) result.moreFields = true;
  return result;
}

function typeSchema(t: TypeAcc, path: string, label: string): TypeSchema {
  const s: TypeSchema = { type: t.type, count: t.count };
  if (t.type === 'array') {
    const lengths = t.lengths;
    s.lengths = {
      min: Math.min(...lengths),
      max: Math.max(...lengths),
      avg: Math.round((lengths.reduce((a, b) => a + b, 0) / lengths.length) * 10) / 10,
    };
    if (t.elements?.count) s.elements = field(t.elements, '[]', path, `${label}[]`, t.count);
    return s;
  }
  if (!VALUE_TYPES.has(t.type)) return s;
  s.distinct = t.values.size;
  if (t.capped) s.distinctCapped = true;
  if (t.min && t.max) {
    s.min = relaxEjson(t.min.value);
    s.max = relaxEjson(t.max.value);
  }
  const few = !t.capped && t.values.size <= FEW;
  if (t.numbers.length && !few && t.min!.n < t.max!.n) {
    s.bins = histogram(t.numbers, t.type);
  } else {
    s.top = [...t.values.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP)
      .map((v) => ({ value: relaxEjson(v.value), count: v.count }));
  }
  return s;
}

// ---------------------------------------------------------------------------
// Histograms with round bin boundaries

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DATE_STEPS = [
  SECOND, 5 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY, 182 * DAY, 365 * DAY,
];

function niceStep(raw: number, type: BsonType): number {
  if (type === 'date') {
    const step = DATE_STEPS.find((s) => s >= raw);
    return step ?? Math.ceil(raw / (365 * DAY)) * 365 * DAY;
  }
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const integer = type === 'int' || type === 'long';
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 && !integer ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return integer ? Math.max(1, Math.ceil(step)) : step;
}

const round = (n: number) => Number(n.toPrecision(12));

function histogram(numbers: number[], type: BsonType): Bin[] {
  let min = Infinity;
  let max = -Infinity;
  for (const n of numbers) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  const step = niceStep((max - min) / BINS, type);
  const start = Math.floor(min / step) * step;
  const n = Math.floor((max - start) / step) + 1;
  const counts = new Array<number>(n).fill(0);
  for (const x of numbers) counts[Math.max(0, Math.min(n - 1, Math.floor((x - start) / step)))]++;
  const value = (x: number): unknown => (type === 'date' ? { $date: new Date(x).toISOString() } : round(x));
  return counts.map((count, i) => ({ from: value(start + i * step), to: value(start + (i + 1) * step), count }));
}

// ---------------------------------------------------------------------------
// $jsonSchema validator from an analysis

/**
 * A `$jsonSchema` describing the analyzed documents: the BSON types seen for each field, nested objects
 * and array elements, and as `required` the fields present in every document (or parent object).
 */
export function toJsonSchema(summary: SchemaSummary): Record<string, unknown> {
  return objectSchema(summary.fields);
}

function objectSchema(fields: FieldSchema[]): Record<string, unknown> {
  const required = fields.filter((f) => f.of > 0 && f.count === f.of).map((f) => f.name);
  return {
    bsonType: 'object',
    ...(required.length && { required }),
    properties: Object.fromEntries(fields.map((f) => [f.name, fieldSchema(f)])),
  };
}

function fieldSchema(f: FieldSchema): Record<string, unknown> {
  const types = f.types.map((t) => t.type);
  const schema: Record<string, unknown> = { bsonType: types.length === 1 ? types[0] : types };
  // `properties` and `items` only constrain values of the object / array type.
  if (f.fields?.length) {
    const { properties, required } = objectSchema(f.fields);
    if (required) schema.required = required;
    schema.properties = properties;
  }
  const elements = f.types.find((t) => t.elements)?.elements;
  if (elements) schema.items = fieldSchema(elements);
  return schema;
}
