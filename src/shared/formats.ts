// Documents as text to copy (mongosh, Extended JSON, plain JSON, YAML, an insert command),
// and the text of the insert dialog back into documents. Shared by the host and the webview.
import { formatWrapper, isEjsonWrapper, isPlainObject, parseQuery, prettyShell, toShell } from './query';

export type CopyFormat = 'shell' | 'ejson' | 'json' | 'yaml' | 'insert';

export const COPY_FORMATS: { id: CopyFormat; label: string; title: string }[] = [
  { id: 'shell', label: 'mongosh', title: 'ObjectId(…), ISODate(…): pastes into a query, the playground or Insert' },
  { id: 'ejson', label: 'Extended JSON', title: 'Keeps every type ({ "$oid": … }), like mongoexport: pastes into Insert' },
  { id: 'json', label: 'JSON', title: 'Plain JSON: ids and dates as strings, for other tools' },
  { id: 'yaml', label: 'YAML', title: 'Ids as strings, dates as YAML timestamps' },
  { id: 'insert', label: 'insertOne command', title: 'db.getCollection(…).insertOne(…) for mongosh' },
];

/** One document (relaxed EJSON) as text in `format`. */
export function formatDocument(doc: unknown, format: CopyFormat, collection: string): string {
  switch (format) {
    case 'shell':
      return toShell(doc, 2);
    case 'ejson':
      return JSON.stringify(doc, null, 2);
    case 'json':
      return JSON.stringify(plainValue(doc), null, 2);
    case 'yaml':
      return toYaml(plainValue(doc, true));
    case 'insert':
      return `db.getCollection(${JSON.stringify(collection)}).insertOne(${toShell(doc, 2)});`;
  }
}

const DATE = Symbol('date');
type PlainDate = { [DATE]: string };

/**
 * The value without EJSON wrappers, as plain JSON: ObjectIds, UUIDs and decimals become strings, dates
 * ISO strings (or, with `keepDates`, markers the YAML writer leaves unquoted), Longs numbers when exact.
 */
function plainValue(v: unknown, keepDates = false): unknown {
  if (Array.isArray(v)) return v.map((x) => plainValue(x, keepDates));
  if (!isPlainObject(v)) return v;
  if (isEjsonWrapper(v)) {
    const [key] = Object.keys(v);
    const val = v[key] as any;
    switch (key) {
      case '$oid':
      case '$symbol':
      case '$code':
      case '$uuid':
        return String(val);
      case '$date': {
        const d = new Date(typeof val === 'string' ? val : Number(val?.$numberLong ?? val));
        const iso = isNaN(d.getTime()) ? String(val?.$numberLong ?? val) : d.toISOString();
        return keepDates ? ({ [DATE]: iso } as PlainDate) : iso;
      }
      case '$numberLong':
      case '$numberInt':
      case '$numberDouble':
      case '$numberDecimal': {
        const n = Number(val);
        return Number.isFinite(n) && String(n) === String(val) ? n : String(val);
      }
      case '$binary':
      case '$regularExpression':
        // UUID("…") → the UUID, /a/i → "/a/i", BinData(0, "…") → the base64.
        return (formatWrapper(v) ?? '').replace(/^UUID\("(.*)"\)$/, '$1').replace(/^BinData\(\d+, "(.*)"\)$/, '$1');
      case '$timestamp':
        return { t: val?.t, i: val?.i };
      case '$minKey':
        return 'MinKey';
      case '$maxKey':
        return 'MaxKey';
      case '$undefined':
        return null;
    }
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainValue(x, keepDates)]));
}

// ---------------------------------------------------------------------------
// YAML

const isDate = (v: unknown): v is PlainDate => typeof v === 'object' && v !== null && DATE in v;

/** Block-style YAML of a plain value. */
export function toYaml(v: unknown): string {
  return yamlBlock(v, 0).replace(/^\n/, '') + '\n';
}

/** The value after a key or a dash: a scalar on the same line, or a nested block starting on a new line. */
function yamlBlock(v: unknown, level: number): string {
  const pad = '  '.repeat(level);
  if (Array.isArray(v) && v.length) {
    return v
      .map((x) => {
        const inner = yamlBlock(x, level + 1);
        // A mapping inside a list starts on the dash line: "- a: 1\n  b: 2".
        return `\n${pad}-${inner.startsWith('\n') ? ' ' + inner.slice(pad.length + 3) : inner}`;
      })
      .join('');
  }
  if (isPlainObject(v) && !isDate(v) && Object.keys(v).length) {
    return Object.entries(v)
      .map(([k, x]) => `\n${pad}${yamlKey(k)}:${yamlBlock(x, level + 1)}`)
      .join('');
  }
  return ' ' + yamlScalar(v, level);
}

function yamlKey(k: string): string {
  return isPlainScalar(k) ? k : JSON.stringify(k);
}

function yamlScalar(v: unknown, level: number): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[]';
  if (isDate(v)) return v[DATE];
  if (typeof v === 'object') return '{}';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : Number.isNaN(v) ? '.nan' : v > 0 ? '.inf' : '-.inf';
  if (typeof v === 'boolean') return String(v);
  const s = String(v);
  if (isPlainScalar(s)) return s;
  // Multi-line text as a literal block, when YAML gives it back unchanged.
  if (s.includes('\n') && !/^\s/.test(s) && !/[\r\t\u0000-\u0008\u000b-\u001f]/.test(s) && !/\n\n$/.test(s) && !/ \n|[ ]$/.test(s)) {
    const pad = '  '.repeat(level);
    const body = s.replace(/\n$/, '');
    return `${s.endsWith('\n') ? '|' : '|-'}\n${body
      .split('\n')
      .map((line) => (line ? pad + line : ''))
      .join('\n')}`;
  }
  return JSON.stringify(s);
}

/** Text YAML reads back as the same string without quotes. */
function isPlainScalar(s: string): boolean {
  if (!/^[A-Za-z_][\w .@/+-]*$/.test(s) || /\s$/.test(s)) return false;
  // Words YAML 1.1 parsers read as booleans or null.
  return !/^(true|false|yes|no|on|off|y|n|null|nan|inf)$/i.test(s);
}

// ---------------------------------------------------------------------------
// Insert

/**
 * The documents in the text of the insert dialog (relaxed EJSON): one document, an array of documents,
 * one document per line (mongoexport), or a mongosh insertOne / insertMany call. Throws on invalid text.
 */
export function parseDocuments(text: string): Record<string, unknown>[] {
  const source = unwrapInsertCall(text.trim());
  if (!source) throw new Error('Enter a document, e.g. { name: "Ada" }');
  let value: unknown;
  try {
    value = parseQuery(source);
  } catch (err) {
    const lines = source.split('\n').filter((l) => l.trim());
    // mongoexport writes one document per line.
    if (lines.length < 2 || !lines.every((l) => /^\s*\{.*\}\s*,?\s*$/.test(l))) throw err;
    value = lines.map((l) => parseQuery(l.replace(/,\s*$/, '')));
  }
  const docs = Array.isArray(value) ? value : [value];
  if (!docs.length) throw new Error('The array is empty: add the documents to insert');
  docs.forEach((d, i) => {
    if (!isPlainObject(d) || isEjsonWrapper(d)) {
      throw new Error(docs.length > 1 ? `Item ${i + 1} is not a document: each must be an object { … }` : 'A document must be an object { … }');
    }
  });
  return docs as Record<string, unknown>[];
}

/** The argument of a pasted `db.coll.insertOne(…)` / `insertMany(…)`, or the text itself. */
function unwrapInsertCall(text: string): string {
  const m = /^(?:db\s*(?:\.\s*[\w$]+|\.\s*getCollection\(\s*(["']).*?\1\s*\)|\[\s*(["']).*?\2\s*\])\s*)?\.?\s*insert(?:One|Many)?\s*\(([\s\S]*)\)\s*;?$/.exec(text);
  if (!m) return text;
  // insertMany([...], { ordered: false }): only the documents.
  const args = m[3].trim();
  const end = matchingClose(args);
  return end > 0 ? args.slice(0, end) : args;
}

/** Index after the bracket closing the one `text` starts with (0 when it doesn't start with one). */
function matchingClose(text: string): number {
  if (text[0] !== '{' && text[0] !== '[') return 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      if (--depth === 0) return i + 1;
    }
  }
  return 0;
}

/** Text that starts the insert dialog with a document like the collection's (`_id` is left to the server). */
export function insertTemplate(fields: { path: string; types: string[]; ratio: number }[]): string {
  const top = fields.filter((f) => !f.path.includes('.') && f.path !== '_id' && f.ratio >= 0.5).slice(0, 30);
  if (!top.length) return '{\n  \n}';
  const sample: Record<string, unknown> = {};
  for (const f of top) sample[f.path] = TEMPLATE_VALUES[f.types[0]] ?? null;
  // ISODate() is today at insert time.
  return prettyShell(sample, 0, 0).replace(/"\$\$now"/g, 'ISODate()');
}

const TEMPLATE_VALUES: Record<string, unknown> = {
  string: '',
  int: 0,
  double: 0,
  long: 0,
  decimal: 0,
  bool: false,
  date: '$$now',
  object: {},
  array: [],
};
