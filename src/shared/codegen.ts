// Query → code: a find (filter, projection, sort, collation, hint) or an aggregation pipeline, written for
// mongosh and for the official drivers of Node.js, Python, Java, C# and Go, either as a snippet or as a whole
// program.
import { escapeSlashes, formatKey, isEjsonWrapper, isPlainObject, parseQuery, prettyShell } from './query';

export type CodeLanguage = 'shell' | 'javascript' | 'python' | 'java' | 'csharp' | 'go';

export const CODE_LANGUAGES: { id: CodeLanguage; label: string; editorLanguage: string }[] = [
  { id: 'shell', label: 'mongosh', editorLanguage: 'javascript' },
  { id: 'javascript', label: 'Node.js', editorLanguage: 'javascript' },
  { id: 'python', label: 'Python', editorLanguage: 'python' },
  { id: 'java', label: 'Java', editorLanguage: 'java' },
  { id: 'csharp', label: 'C#', editorLanguage: 'csharp' },
  { id: 'go', label: 'Go', editorLanguage: 'go' },
];

/** Values are relaxed EJSON, as parseQuery returns them. */
export type CodeQuery =
  | {
      kind: 'find';
      filter: unknown;
      projection?: unknown;
      sort?: unknown;
      /** A collation document, `{ locale: "it", strength: 1 }`. */
      collation?: unknown;
      /** The name of an index, or its keys (`{ status: 1 }`). */
      hint?: unknown;
    }
  | { kind: 'aggregate'; pipeline: unknown[] };

export interface CodeTarget {
  database: string;
  collection: string;
  /** A complete program (imports, connection, printing the results) rather than a snippet. */
  program: boolean;
}

const WIDTH = 80;
const DEFAULT_URI = 'mongodb://localhost:27017';
const q = JSON.stringify;

/**
 * The text of a $numberLong when it is a whole number, the only text that can be written in the code as it
 * is. A query can come from a file someone else wrote (a saved query of the project): anything else would be
 * code of theirs in what the user copies and runs, so it is written as a string for the language to parse.
 */
const wholeNumber = (val: unknown): string | undefined => (/^-?\d+$/.test(String(val)) ? String(val) : undefined);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** True for a projection or sort worth passing (not missing, not {}). */
const present = (v: unknown) => isPlainObject(v) && Object.keys(v).length > 0;

/**
 * The hint of a find as the user types it: the keys of an index (`{ status: 1 }`) or its name, quoted or not
 * (`status_1`). The same reading as `toHint` of the host (src/queries.ts), which the webviews can't import.
 * Throws on a text that is neither.
 */
export function hintValue(text: string | undefined): string | Record<string, unknown> | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  if (!/^[{"'`]/.test(trimmed)) return trimmed;
  const value = parseQuery(trimmed);
  if (trimmed.startsWith('{') ? !isPlainObject(value) : typeof value !== 'string' || !value) {
    throw new Error('Hint must be the name of an index or its keys, e.g. { status: 1 }');
  }
  return value as string | Record<string, unknown>;
}

/** The hint worth passing: a name, or keys that aren't {}. */
function hintOf(query: Extract<CodeQuery, { kind: 'find' }>): string | Record<string, unknown> | undefined {
  if (typeof query.hint === 'string') return query.hint.trim() ? query.hint : undefined;
  return present(query.hint) ? (query.hint as Record<string, unknown>) : undefined;
}

/**
 * The options of a collation that the typed drivers (Java, C#, Go) have a name for, each only with a value of
 * its type: those languages take a collation as an object of their own, not as a document, so an option they
 * don't know, or a value that isn't one of the option's, is left out rather than written as code that doesn't
 * compile. Undefined without a locale, which every collation needs.
 */
interface CollationFields {
  locale: string;
  caseLevel?: boolean;
  caseFirst?: 'upper' | 'lower' | 'off';
  strength?: 1 | 2 | 3 | 4 | 5;
  numericOrdering?: boolean;
  alternate?: 'non-ignorable' | 'shifted';
  maxVariable?: 'punct' | 'space';
  normalization?: boolean;
  backwards?: boolean;
}

function collationFields(collation: unknown): CollationFields | undefined {
  if (!isPlainObject(collation) || typeof collation.locale !== 'string' || !collation.locale) return undefined;
  const out: CollationFields = { locale: collation.locale };
  const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined => values.find((x) => x === v);
  const number = (v: unknown) => (isEjsonWrapper(v) ? Number(Object.values(v)[0]) : v);
  for (const key of ['caseLevel', 'numericOrdering', 'normalization', 'backwards'] as const) {
    if (typeof collation[key] === 'boolean') out[key] = collation[key];
  }
  out.caseFirst = oneOf(collation.caseFirst, ['upper', 'lower', 'off'] as const);
  out.strength = ([1, 2, 3, 4, 5] as const).find((x) => x === number(collation.strength));
  out.alternate = oneOf(collation.alternate, ['non-ignorable', 'shifted'] as const);
  out.maxVariable = oneOf(collation.maxVariable, ['punct', 'space'] as const);
  return out;
}

const STRENGTHS = ['Primary', 'Secondary', 'Tertiary', 'Quaternary', 'Identical'];

/** `Collation.builder()…build()` of the Java driver. */
function javaCollation(c: CollationFields, imports: Set<string>): string {
  const model = (name: string) => imports.add(`com.mongodb.client.model.${name}`);
  model('Collation');
  const calls = [`.locale(${q(c.locale)})`];
  if (c.caseLevel !== undefined) calls.push(`.caseLevel(${c.caseLevel})`);
  if (c.caseFirst) {
    model('CollationCaseFirst');
    calls.push(`.collationCaseFirst(CollationCaseFirst.${c.caseFirst.toUpperCase()})`);
  }
  if (c.strength) {
    model('CollationStrength');
    calls.push(`.collationStrength(CollationStrength.${STRENGTHS[c.strength - 1].toUpperCase()})`);
  }
  if (c.numericOrdering !== undefined) calls.push(`.numericOrdering(${c.numericOrdering})`);
  if (c.alternate) {
    model('CollationAlternate');
    calls.push(`.collationAlternate(CollationAlternate.${c.alternate === 'shifted' ? 'SHIFTED' : 'NON_IGNORABLE'})`);
  }
  if (c.maxVariable) {
    model('CollationMaxVariable');
    calls.push(`.collationMaxVariable(CollationMaxVariable.${c.maxVariable.toUpperCase()})`);
  }
  if (c.normalization !== undefined) calls.push(`.normalization(${c.normalization})`);
  if (c.backwards !== undefined) calls.push(`.backwards(${c.backwards})`);
  return `Collation.builder()${calls.join('')}.build()`;
}

/** `new Collation("it", strength: …)` of the C# driver. */
function csharpCollation(c: CollationFields): string {
  const args = [q(c.locale)];
  if (c.caseLevel !== undefined) args.push(`caseLevel: ${c.caseLevel}`);
  if (c.caseFirst) args.push(`caseFirst: CollationCaseFirst.${c.caseFirst[0].toUpperCase()}${c.caseFirst.slice(1)}`);
  if (c.strength) args.push(`strength: CollationStrength.${STRENGTHS[c.strength - 1]}`);
  if (c.numericOrdering !== undefined) args.push(`numericOrdering: ${c.numericOrdering}`);
  if (c.alternate) args.push(`alternate: CollationAlternate.${c.alternate === 'shifted' ? 'Shifted' : 'NonIgnorable'}`);
  if (c.maxVariable) args.push(`maxVariable: CollationMaxVariable.${c.maxVariable === 'punct' ? 'Punctuation' : 'Space'}`);
  if (c.normalization !== undefined) args.push(`normalization: ${c.normalization}`);
  if (c.backwards !== undefined) args.push(`backwards: ${c.backwards}`);
  return `new Collation(${args.join(', ')})`;
}

/** `&options.Collation{Locale: "it", …}` of the Go driver. */
function goCollation(c: CollationFields): string {
  const fields = [`Locale: ${q(c.locale)}`];
  if (c.caseLevel !== undefined) fields.push(`CaseLevel: ${c.caseLevel}`);
  if (c.caseFirst) fields.push(`CaseFirst: ${q(c.caseFirst)}`);
  if (c.strength) fields.push(`Strength: ${c.strength}`);
  if (c.numericOrdering !== undefined) fields.push(`NumericOrdering: ${c.numericOrdering}`);
  if (c.alternate) fields.push(`Alternate: ${q(c.alternate)}`);
  if (c.maxVariable) fields.push(`MaxVariable: ${q(c.maxVariable)}`);
  if (c.normalization !== undefined) fields.push(`Normalization: ${c.normalization}`);
  if (c.backwards !== undefined) fields.push(`Backwards: ${c.backwards}`);
  return `&options.Collation{${fields.join(', ')}}`;
}

function layout(items: string[], level: number, indent: string, open: string, close: string, opts: { space?: boolean; trailing?: boolean } = {}): string {
  const inner = opts.space && items.length ? ` ${items.join(', ')} ` : items.join(', ');
  const single = `${open}${inner}${close}`;
  if (!items.length || (!single.includes('\n') && indent.repeat(level).length + single.length <= WIDTH)) return single;
  const pad = indent.repeat(level + 1);
  return `${open}\n${items.map((i) => pad + i).join(',\n')}${opts.trailing ? ',' : ''}\n${indent.repeat(level)}${close}`;
}

function toDate(val: unknown): Date {
  if (typeof val === 'string') return new Date(val);
  if (isPlainObject(val) && val.$numberLong !== undefined) return new Date(Number(val.$numberLong));
  return new Date(Number(val));
}

function base64Bytes(b64: string): number[] {
  const bin = atob(b64);
  return Array.from(bin, (c) => c.charCodeAt(0));
}

function uuidBytes(uuid: string): number[] {
  const hex = uuid.replace(/-/g, '');
  return Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

const hexByte = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

/** Renders relaxed-EJSON values in the syntax of one language, collecting the imports they need. */
abstract class Printer {
  readonly imports = new Set<string>();
  abstract readonly indent: string;

  render(v: unknown, level = 0): string {
    if (v === null || v === undefined) return this.null();
    if (typeof v === 'string') return q(v);
    if (typeof v === 'boolean') return this.bool(v);
    if (typeof v === 'number') return this.number(v);
    if (Array.isArray(v)) return this.array(v, level);
    if (isEjsonWrapper(v)) {
      const [key] = Object.keys(v);
      const out = this.wrapper(key, v[key]);
      if (out !== undefined) return out;
    }
    if (isPlainObject(v)) return this.object(Object.entries(v), level);
    return q(String(v));
  }

  protected null(): string {
    return 'null';
  }

  protected bool(b: boolean): string {
    return String(b);
  }

  protected number(n: number): string {
    if (Number.isNaN(n)) return this.special('nan');
    if (!Number.isFinite(n)) return this.special(n > 0 ? 'inf' : '-inf');
    return String(n);
  }

  protected abstract special(kind: 'nan' | 'inf' | '-inf'): string;
  protected abstract array(items: unknown[], level: number): string;
  protected abstract object(entries: [string, unknown][], level: number): string;
  /** EJSON type wrappers; undefined renders the value as a plain document. */
  protected abstract wrapper(key: string, val: any): string | undefined;
}

// ---------------------------------------------------------------------------
// Node.js

class JsPrinter extends Printer {
  readonly indent = '  ';

  protected special(kind: 'nan' | 'inf' | '-inf'): string {
    return { nan: 'NaN', inf: 'Infinity', '-inf': '-Infinity' }[kind];
  }

  protected array(items: unknown[], level: number): string {
    return layout(items.map((x) => this.render(x, level + 1)), level, this.indent, '[', ']');
  }

  protected object(entries: [string, unknown][], level: number): string {
    return layout(entries.map(([k, x]) => `${formatKey(k)}: ${this.render(x, level + 1)}`), level, this.indent, '{', '}', { space: true });
  }

  private use(name: string, text: string): string {
    this.imports.add(name);
    return text;
  }

  protected wrapper(key: string, val: any): string | undefined {
    switch (key) {
      case '$oid':
        return this.use('ObjectId', `new ObjectId(${q(val)})`);
      case '$date':
        return `new Date(${q(toDate(val).toISOString())})`;
      case '$numberLong':
        return this.use('Long', `Long.fromString(${q(String(val))})`);
      case '$numberDecimal':
        return this.use('Decimal128', `Decimal128.fromString(${q(String(val))})`);
      case '$numberInt':
      case '$numberDouble':
        return this.number(Number(val));
      case '$regularExpression': {
        const pattern = String(val?.pattern ?? '');
        const options = String(val?.options ?? '');
        if (/^[imsu]*$/.test(options) && pattern) return `/${escapeSlashes(pattern)}/${options}`;
        return this.use('BSONRegExp', `new BSONRegExp(${q(pattern)}, ${q(options)})`);
      }
      case '$uuid':
        return this.use('UUID', `new UUID(${q(val)})`);
      case '$binary':
        return this.use('Binary', `new Binary(Buffer.from(${q(val?.base64 ?? '')}, "base64"), ${hexByte(parseInt(val?.subType ?? '0', 16))})`);
      case '$timestamp':
        return this.use('Timestamp', `new Timestamp({ t: ${Number(val?.t)}, i: ${Number(val?.i)} })`);
      case '$minKey':
        return this.use('MinKey', 'new MinKey()');
      case '$maxKey':
        return this.use('MaxKey', 'new MaxKey()');
      case '$code':
        return this.use('Code', `new Code(${q(val)})`);
      case '$symbol':
        return q(String(val));
      case '$undefined':
        return 'undefined';
      default:
        return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Python (PyMongo)

class PyPrinter extends Printer {
  readonly indent = '    ';

  protected null(): string {
    return 'None';
  }

  protected bool(b: boolean): string {
    return b ? 'True' : 'False';
  }

  protected special(kind: 'nan' | 'inf' | '-inf'): string {
    return { nan: 'float("nan")', inf: 'float("inf")', '-inf': 'float("-inf")' }[kind];
  }

  protected array(items: unknown[], level: number): string {
    return layout(items.map((x) => this.render(x, level + 1)), level, this.indent, '[', ']');
  }

  protected object(entries: [string, unknown][], level: number): string {
    return layout(entries.map(([k, x]) => `${q(k)}: ${this.render(x, level + 1)}`), level, this.indent, '{', '}');
  }

  /** A sort document as PyMongo's list of (key, direction) pairs. */
  sortList(sort: Record<string, unknown>, level: number): string {
    return layout(Object.entries(sort).map(([k, x]) => `(${q(k)}, ${this.render(x, level + 1)})`), level, this.indent, '[', ']');
  }

  private use(line: string, text: string): string {
    this.imports.add(line);
    return text;
  }

  protected wrapper(key: string, val: any): string | undefined {
    switch (key) {
      case '$oid':
        return this.use('from bson import ObjectId', `ObjectId(${q(val)})`);
      case '$date': {
        this.imports.add('from datetime import datetime, timezone');
        const d = toDate(val);
        const parts = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
        const ms = d.getUTCMilliseconds();
        if (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() || ms) parts.push(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
        if (ms) parts.push(ms * 1000);
        return `datetime(${parts.join(', ')}, tzinfo=timezone.utc)`;
      }
      case '$numberLong':
        return this.use('from bson.int64 import Int64', `Int64(${wholeNumber(val) ?? q(String(val))})`);
      case '$numberDecimal':
        return this.use('from bson.decimal128 import Decimal128', `Decimal128(${q(String(val))})`);
      case '$numberInt':
      case '$numberDouble':
        return this.number(Number(val));
      case '$regularExpression':
        return this.use('from bson.regex import Regex', `Regex(${q(String(val?.pattern ?? ''))}, ${q(String(val?.options ?? ''))})`);
      case '$uuid':
        this.imports.add('from uuid import UUID');
        return this.use('from bson.binary import Binary', `Binary.from_uuid(UUID(${q(val)}))`);
      case '$binary':
        this.imports.add('import base64');
        return this.use('from bson.binary import Binary', `Binary(base64.b64decode(${q(val?.base64 ?? '')}), ${parseInt(val?.subType ?? '0', 16)})`);
      case '$timestamp':
        return this.use('from bson.timestamp import Timestamp', `Timestamp(${Number(val?.t)}, ${Number(val?.i)})`);
      case '$minKey':
        return this.use('from bson.min_key import MinKey', 'MinKey()');
      case '$maxKey':
        return this.use('from bson.max_key import MaxKey', 'MaxKey()');
      case '$code':
        return this.use('from bson.code import Code', `Code(${q(val)})`);
      case '$symbol':
        return q(String(val));
      case '$undefined':
        return 'None';
      default:
        return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Java (org.bson.Document)

class JavaPrinter extends Printer {
  readonly indent = '    ';

  protected number(n: number): string {
    const s = super.number(n);
    return Number.isInteger(n) && Math.abs(n) > 2147483647 && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? `${s}L` : s;
  }

  protected special(kind: 'nan' | 'inf' | '-inf'): string {
    return { nan: 'Double.NaN', inf: 'Double.POSITIVE_INFINITY', '-inf': 'Double.NEGATIVE_INFINITY' }[kind];
  }

  protected array(items: unknown[], level: number): string {
    this.imports.add('java.util.Arrays');
    return layout(items.map((x) => this.render(x, level + 1)), level, this.indent, 'Arrays.asList(', ')');
  }

  protected object(entries: [string, unknown][], level: number): string {
    if (!entries.length) return 'new Document()';
    const parts = entries.map(([k, x]) => `(${q(k)}, ${this.render(x, level + 1)})`);
    const single = `new Document${parts[0]}${parts.slice(1).map((p) => `.append${p}`).join('')}`;
    if (!single.includes('\n') && this.indent.repeat(level).length + single.length <= WIDTH) return single;
    const pad = this.indent.repeat(level + 1);
    return `new Document${parts[0]}${parts.slice(1).map((p) => `\n${pad}.append${p}`).join('')}`;
  }

  private use(name: string, text: string): string {
    this.imports.add(name);
    return text;
  }

  protected wrapper(key: string, val: any): string | undefined {
    switch (key) {
      case '$oid':
        return this.use('org.bson.types.ObjectId', `new ObjectId(${q(val)})`);
      case '$date':
        this.imports.add('java.time.Instant');
        return this.use('java.util.Date', `Date.from(Instant.parse(${q(toDate(val).toISOString())}))`);
      case '$numberLong':
        return wholeNumber(val) ? `${String(val)}L` : `Long.parseLong(${q(String(val))})`;
      case '$numberDecimal':
        return this.use('org.bson.types.Decimal128', `Decimal128.parse(${q(String(val))})`);
      case '$numberInt':
      case '$numberDouble':
        return this.number(Number(val));
      case '$regularExpression':
        return this.use('org.bson.BsonRegularExpression', `new BsonRegularExpression(${q(String(val?.pattern ?? ''))}, ${q(String(val?.options ?? ''))})`);
      case '$uuid':
        this.imports.add('java.util.UUID');
        return this.use('org.bson.BsonBinary', `new BsonBinary(UUID.fromString(${q(val)}))`);
      case '$binary':
        this.imports.add('java.util.Base64');
        return this.use('org.bson.types.Binary', `new Binary((byte) ${hexByte(parseInt(val?.subType ?? '0', 16))}, Base64.getDecoder().decode(${q(val?.base64 ?? '')}))`);
      case '$timestamp':
        return this.use('org.bson.BsonTimestamp', `new BsonTimestamp(${Number(val?.t)}, ${Number(val?.i)})`);
      case '$minKey':
        return this.use('org.bson.types.MinKey', 'new MinKey()');
      case '$maxKey':
        return this.use('org.bson.types.MaxKey', 'new MaxKey()');
      case '$code':
        return this.use('org.bson.types.Code', `new Code(${q(val)})`);
      case '$symbol':
        return q(String(val));
      case '$undefined':
        return this.use('org.bson.BsonUndefined', 'new BsonUndefined()');
      default:
        return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// C# (MongoDB.Bson)

class CsPrinter extends Printer {
  readonly indent = '    ';

  protected null(): string {
    return 'BsonNull.Value';
  }

  protected number(n: number): string {
    const s = super.number(n);
    return Number.isInteger(n) && Math.abs(n) > 2147483647 && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? `${s}L` : s;
  }

  protected special(kind: 'nan' | 'inf' | '-inf'): string {
    return { nan: 'double.NaN', inf: 'double.PositiveInfinity', '-inf': 'double.NegativeInfinity' }[kind];
  }

  protected array(items: unknown[], level: number): string {
    if (!items.length) return 'new BsonArray()';
    return this.initializer('new BsonArray', items.map((x) => this.render(x, level + 1)), level);
  }

  protected object(entries: [string, unknown][], level: number): string {
    if (!entries.length) return 'new BsonDocument()';
    if (entries.length === 1) {
      const [[k, x]] = entries;
      return `new BsonDocument(${q(k)}, ${this.render(x, level)})`;
    }
    return this.initializer('new BsonDocument', entries.map(([k, x]) => `{ ${q(k)}, ${this.render(x, level + 1)} }`), level);
  }

  private initializer(head: string, items: string[], level: number): string {
    const single = `${head} { ${items.join(', ')} }`;
    if (!single.includes('\n') && this.indent.repeat(level).length + single.length <= WIDTH) return single;
    const pad = this.indent.repeat(level + 1);
    const end = this.indent.repeat(level);
    return `${head}\n${end}{\n${items.map((i) => pad + i).join(',\n')}\n${end}}`;
  }

  protected wrapper(key: string, val: any): string | undefined {
    switch (key) {
      case '$oid':
        return `new ObjectId(${q(val)})`;
      case '$date': {
        const d = toDate(val);
        const base = `new DateTime(${d.getUTCFullYear()}, ${d.getUTCMonth() + 1}, ${d.getUTCDate()}, ${d.getUTCHours()}, ${d.getUTCMinutes()}, ${d.getUTCSeconds()}, DateTimeKind.Utc)`;
        return d.getUTCMilliseconds() ? `${base}.AddMilliseconds(${d.getUTCMilliseconds()})` : base;
      }
      case '$numberLong':
        return wholeNumber(val) ? `${String(val)}L` : `long.Parse(${q(String(val))})`;
      case '$numberDecimal':
        return `Decimal128.Parse(${q(String(val))})`;
      case '$numberInt':
      case '$numberDouble':
        return this.number(Number(val));
      case '$regularExpression':
        return `new BsonRegularExpression(${q(String(val?.pattern ?? ''))}, ${q(String(val?.options ?? ''))})`;
      case '$uuid':
        return `new BsonBinaryData(Guid.Parse(${q(val)}), GuidRepresentation.Standard)`;
      case '$binary':
        return `new BsonBinaryData(Convert.FromBase64String(${q(val?.base64 ?? '')}), (BsonBinarySubType)${hexByte(parseInt(val?.subType ?? '0', 16))})`;
      case '$timestamp':
        return `new BsonTimestamp(${Number(val?.t)}, ${Number(val?.i)})`;
      case '$minKey':
        return 'BsonMinKey.Value';
      case '$maxKey':
        return 'BsonMaxKey.Value';
      case '$code':
        return `new BsonJavaScript(${q(val)})`;
      case '$symbol':
        return q(String(val));
      case '$undefined':
        return 'BsonUndefined.Value';
      default:
        return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Go (driver v2)

const GO_HELPERS: Record<string, string> = {
  objectID: `func objectID(hex string) bson.ObjectID {
\tid, err := bson.ObjectIDFromHex(hex)
\tif err != nil {
\t\tpanic(err)
\t}
\treturn id
}`,
  decimal128: `func decimal128(s string) bson.Decimal128 {
\td, err := bson.ParseDecimal128(s)
\tif err != nil {
\t\tpanic(err)
\t}
\treturn d
}`,
};

class GoPrinter extends Printer {
  readonly indent = '\t';
  readonly helpers = new Set<string>();

  protected null(): string {
    return 'nil';
  }

  protected special(kind: 'nan' | 'inf' | '-inf'): string {
    this.imports.add('math');
    return { nan: 'math.NaN()', inf: 'math.Inf(1)', '-inf': 'math.Inf(-1)' }[kind];
  }

  protected array(items: unknown[], level: number): string {
    return layout(items.map((x) => this.render(x, level + 1)), level, this.indent, 'bson.A{', '}', { trailing: true });
  }

  protected object(entries: [string, unknown][], level: number): string {
    return this.document(entries, level);
  }

  document(entries: [string, unknown][], level: number, type = 'bson.D'): string {
    return layout(entries.map(([k, x]) => `{Key: ${q(k)}, Value: ${this.render(x, level + 1)}}`), level, this.indent, `${type}{`, '}', { trailing: true });
  }

  private bytes(list: number[]): string {
    return `[]byte{${list.map(hexByte).join(', ')}}`;
  }

  protected wrapper(key: string, val: any): string | undefined {
    switch (key) {
      case '$oid':
        this.helpers.add('objectID');
        return `objectID(${q(val)})`;
      case '$date': {
        this.imports.add('time');
        const d = toDate(val);
        return `bson.NewDateTimeFromTime(time.Date(${d.getUTCFullYear()}, time.${MONTHS[d.getUTCMonth()]}, ${d.getUTCDate()}, ${d.getUTCHours()}, ${d.getUTCMinutes()}, ${d.getUTCSeconds()}, ${d.getUTCMilliseconds() * 1_000_000}, time.UTC))`;
      }
      case '$numberLong':
        return `int64(${wholeNumber(val) ?? '0'})`;
      case '$numberDecimal':
        this.helpers.add('decimal128');
        return `decimal128(${q(String(val))})`;
      case '$numberInt':
      case '$numberDouble':
        return this.number(Number(val));
      case '$regularExpression':
        return `bson.Regex{Pattern: ${q(String(val?.pattern ?? ''))}, Options: ${q(String(val?.options ?? ''))}}`;
      case '$uuid':
        return `bson.Binary{Subtype: 0x04, Data: ${this.bytes(uuidBytes(String(val)))}}`;
      case '$binary':
        return `bson.Binary{Subtype: ${hexByte(parseInt(val?.subType ?? '0', 16))}, Data: ${this.bytes(base64Bytes(val?.base64 ?? ''))}}`;
      case '$timestamp':
        return `bson.Timestamp{T: ${Number(val?.t)}, I: ${Number(val?.i)}}`;
      case '$minKey':
        return 'bson.MinKey{}';
      case '$maxKey':
        return 'bson.MaxKey{}';
      case '$code':
        return `bson.JavaScript(${q(val)})`;
      case '$symbol':
        return q(String(val));
      case '$undefined':
        return 'bson.Undefined{}';
      default:
        return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Generators

function shell(query: CodeQuery, t: CodeTarget): string {
  const coll = `db.getCollection(${q(t.collection)})`;
  let call: string;
  if (query.kind === 'aggregate') {
    call = `${coll}.aggregate(${prettyShell(query.pipeline, 0, WIDTH)})`;
  } else {
    const args = [prettyShell(query.filter ?? {}, 0, WIDTH)];
    if (present(query.projection)) args.push(prettyShell(query.projection, 0, WIDTH));
    call = `${coll}.find(${args.join(', ')})`;
    if (present(query.sort)) call += `.sort(${prettyShell(query.sort, 0, WIDTH)})`;
    if (present(query.collation)) call += `.collation(${prettyShell(query.collation, 0, WIDTH)})`;
    const hint = hintOf(query);
    if (hint !== undefined) call += `.hint(${typeof hint === 'string' ? q(hint) : prettyShell(hint, 0, WIDTH)})`;
  }
  return t.program ? `use(${q(t.database)});\n\n${call};\n` : `${call};\n`;
}

function javascript(query: CodeQuery, t: CodeTarget): string {
  const p = new JsPrinter();
  const decls: string[] = [];
  let call: string;
  const coll = `client.db(${q(t.database)}).collection(${q(t.collection)})`;
  if (query.kind === 'aggregate') {
    decls.push(`const pipeline = ${p.render(query.pipeline)};`);
    call = `${coll}.aggregate(pipeline)`;
  } else {
    decls.push(`const filter = ${p.render(query.filter ?? {})};`);
    const opts: string[] = [];
    if (present(query.projection)) {
      decls.push(`const projection = ${p.render(query.projection)};`);
      opts.push('projection');
    }
    if (present(query.sort)) {
      decls.push(`const sort = ${p.render(query.sort)};`);
      opts.push('sort');
    }
    if (present(query.collation)) {
      decls.push(`const collation = ${p.render(query.collation)};`);
      opts.push('collation');
    }
    const hint = hintOf(query);
    if (hint !== undefined) {
      decls.push(`const hint = ${p.render(hint)};`);
      opts.push('hint');
    }
    call = `${coll}.find(filter${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
  }
  if (!t.program) return `${decls.join('\n')}\n\nconst cursor = ${call};\n`;
  const imports = ['MongoClient', ...[...p.imports].sort()].join(', ');
  return `import { ${imports} } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI ?? ${q(DEFAULT_URI)});

${decls.join('\n')}

try {
  const cursor = ${call};
  for await (const doc of cursor) {
    console.log(doc);
  }
} finally {
  await client.close();
}
`;
}

function python(query: CodeQuery, t: CodeTarget): string {
  const p = new PyPrinter();
  const decls: string[] = [];
  let call: string;
  const coll = t.program ? 'collection' : `client[${q(t.database)}][${q(t.collection)}]`;
  if (query.kind === 'aggregate') {
    decls.push(`pipeline = ${p.render(query.pipeline)}`);
    call = `${coll}.aggregate(pipeline)`;
  } else {
    decls.push(`query = ${p.render(query.filter ?? {})}`);
    const args = ['query'];
    if (present(query.projection)) {
      decls.push(`projection = ${p.render(query.projection)}`);
      args.push('projection');
    }
    if (present(query.sort)) {
      decls.push(`sort = ${p.sortList(query.sort as Record<string, unknown>, 0)}`);
      args.push('sort=sort');
    }
    if (present(query.collation)) {
      decls.push(`collation = ${p.render(query.collation)}`);
      args.push('collation=collation');
    }
    const hint = hintOf(query);
    if (hint !== undefined) {
      // PyMongo takes the keys of an index as it takes a sort: a list of (key, direction) pairs.
      decls.push(`hint = ${typeof hint === 'string' ? q(hint) : p.sortList(hint, 0)}`);
      args.push('hint=hint');
    }
    call = `${coll}.find(${args.join(', ')})`;
  }
  if (!t.program) return `${decls.join('\n')}\n\ncursor = ${call}\n`;
  const imports = [...p.imports];
  const byStyle = (a: string, b: string) => Number(a.startsWith('from')) - Number(b.startsWith('from')) || a.localeCompare(b);
  const std = imports.filter((i) => /^(import base64|from (datetime|uuid) )/.test(i)).sort(byStyle);
  const bson = imports.filter((i) => !std.includes(i)).sort(byStyle);
  return `${['import os', ...std].join('\n')}

${['from pymongo import MongoClient', ...bson].join('\n')}

client = MongoClient(os.environ.get("MONGODB_URI", ${q(DEFAULT_URI)}))
collection = client[${q(t.database)}][${q(t.collection)}]

${decls.join('\n')}

for doc in ${call}:
    print(doc)
`;
}

function java(query: CodeQuery, t: CodeTarget): string {
  const p = new JavaPrinter();
  const level = t.program ? 3 : 0;
  const decls: string[] = [];
  let call: string;
  if (query.kind === 'aggregate') {
    p.imports.add('java.util.List');
    p.imports.add('java.util.Arrays');
    const stages = query.pipeline.map((s) => p.render(s, level + 1));
    const single = `Arrays.asList(${stages.join(', ')})`;
    const pad = p.indent.repeat(level + 1);
    const list =
      !single.includes('\n') && single.length + p.indent.repeat(level).length + 30 <= WIDTH
        ? single
        : `Arrays.asList(\n${stages.map((s) => pad + s).join(',\n')}\n${p.indent.repeat(level)})`;
    decls.push(`List<Document> pipeline = ${list};`);
    call = 'collection.aggregate(pipeline)';
  } else {
    decls.push(`Document filter = ${p.render(query.filter ?? {}, level)};`);
    call = 'collection.find(filter)';
    if (present(query.projection)) {
      decls.push(`Document projection = ${p.render(query.projection, level)};`);
      call += '.projection(projection)';
    }
    if (present(query.sort)) {
      decls.push(`Document sort = ${p.render(query.sort, level)};`);
      call += '.sort(sort)';
    }
    const collation = collationFields(query.collation);
    if (collation) {
      decls.push(`Collation collation = ${javaCollation(collation, p.imports)};`);
      call += '.collation(collation)';
    }
    const hint = hintOf(query);
    if (typeof hint === 'string') call += `.hintString(${q(hint)})`;
    else if (hint) {
      decls.push(`Document hint = ${p.render(hint, level)};`);
      call += '.hint(hint)';
    }
  }
  if (!t.program) {
    const type = query.kind === 'aggregate' ? 'AggregateIterable<Document>' : 'FindIterable<Document>';
    return `${decls.join('\n')}\n\n${type} results = ${call};\n`;
  }
  const imports = ['com.mongodb.client.MongoClient', 'com.mongodb.client.MongoClients', 'com.mongodb.client.MongoCollection', 'org.bson.Document', ...p.imports];
  const pad = p.indent.repeat(level);
  return `${[...new Set(imports)].sort().map((i) => `import ${i};`).join('\n')}

public class Main {
    public static void main(String[] args) {
        String uri = System.getenv().getOrDefault("MONGODB_URI", ${q(DEFAULT_URI)});
        try (MongoClient client = MongoClients.create(uri)) {
            MongoCollection<Document> collection = client.getDatabase(${q(t.database)}).getCollection(${q(t.collection)});

${decls.map((d) => pad + d).join('\n')}

            for (Document doc : ${call}) {
                System.out.println(doc.toJson());
            }
        }
    }
}
`;
}

function csharp(query: CodeQuery, t: CodeTarget): string {
  const p = new CsPrinter();
  const decls: string[] = [];
  let call: string;
  if (query.kind === 'aggregate') {
    const stages = query.pipeline.map((s) => p.render(s, 1));
    const single = `new[] { ${stages.join(', ')} }`;
    const list = !single.includes('\n') && single.length + 15 <= WIDTH ? single : `new[]\n{\n${stages.map((s) => p.indent + s).join(',\n')}\n}`;
    decls.push(`var pipeline = ${list};`);
    call = 'collection.Aggregate<BsonDocument>(pipeline).ToList()';
  } else {
    decls.push(`var filter = ${p.render(query.filter ?? {})};`);
    // The fluent find has no collation or hint of its own: they go in the options of Find.
    const options: string[] = [];
    const collation = collationFields(query.collation);
    if (collation) options.push(`Collation = ${csharpCollation(collation)}`);
    const hint = hintOf(query);
    if (hint !== undefined) options.push(`Hint = ${p.render(hint)}`);
    if (options.length) decls.push(`var options = new FindOptions { ${options.join(', ')} };`);
    call = options.length ? 'collection.Find(filter, options)' : 'collection.Find(filter)';
    if (present(query.sort)) {
      decls.push(`var sort = ${p.render(query.sort)};`);
      call += '.Sort(sort)';
    }
    if (present(query.projection)) {
      decls.push(`var projection = ${p.render(query.projection)};`);
      call += '.Project(projection)';
    }
    call += '.ToList()';
  }
  if (!t.program) return `${decls.join('\n')}\n\nvar results = ${call};\n`;
  return `using MongoDB.Bson;
using MongoDB.Driver;

var uri = Environment.GetEnvironmentVariable("MONGODB_URI") ?? ${q(DEFAULT_URI)};
var client = new MongoClient(uri);
var collection = client.GetDatabase(${q(t.database)}).GetCollection<BsonDocument>(${q(t.collection)});

${decls.join('\n')}

foreach (var doc in ${call})
{
    Console.WriteLine(doc);
}
`;
}

function go(query: CodeQuery, t: CodeTarget): string {
  const p = new GoPrinter();
  const level = t.program ? 1 : 0;
  const decls: string[] = [];
  let call: string;
  if (query.kind === 'aggregate') {
    const stages = query.pipeline.map((s) => (isPlainObject(s) ? p.document(Object.entries(s), level + 1) : p.render(s, level + 1)));
    decls.push(`pipeline := ${layout(stages, level, p.indent, 'mongo.Pipeline{', '}', { trailing: true })}`);
    call = 'collection.Aggregate(ctx, pipeline)';
  } else {
    decls.push(`filter := ${p.document(Object.entries((query.filter as Record<string, unknown>) ?? {}), level)}`);
    const setters: string[] = [];
    if (present(query.projection)) {
      decls.push(`projection := ${p.render(query.projection, level)}`);
      setters.push('.SetProjection(projection)');
    }
    if (present(query.sort)) {
      decls.push(`sort := ${p.render(query.sort, level)}`);
      setters.push('.SetSort(sort)');
    }
    const collation = collationFields(query.collation);
    if (collation) {
      decls.push(`collation := ${goCollation(collation)}`);
      setters.push('.SetCollation(collation)');
    }
    const hint = hintOf(query);
    if (hint !== undefined) {
      decls.push(`hint := ${p.render(hint, level)}`);
      setters.push('.SetHint(hint)');
    }
    if (setters.length) {
      decls.push(`opts := options.Find()${setters.join('')}`);
      call = 'collection.Find(ctx, filter, opts)';
    } else call = 'collection.Find(ctx, filter)';
  }
  const helpers = [...p.helpers].sort().map((h) => GO_HELPERS[h]);
  if (!t.program) {
    return `${decls.join('\n')}\n\ncursor, err := ${call}\n${helpers.length ? `\n${helpers.join('\n\n')}\n` : ''}`;
  }
  const std = ['context', 'fmt', 'os', ...p.imports].sort();
  const mongo = ['go.mongodb.org/mongo-driver/v2/bson', 'go.mongodb.org/mongo-driver/v2/mongo', 'go.mongodb.org/mongo-driver/v2/mongo/options'];
  const pad = p.indent.repeat(level);
  return `package main

import (
${std.map((i) => `\t${q(i)}`).join('\n')}

${mongo.map((i) => `\t${q(i)}`).join('\n')}
)

func main() {
\turi := os.Getenv("MONGODB_URI")
\tif uri == "" {
\t\turi = ${q(DEFAULT_URI)}
\t}
\tclient, err := mongo.Connect(options.Client().ApplyURI(uri))
\tif err != nil {
\t\tpanic(err)
\t}
\tctx := context.Background()
\tdefer client.Disconnect(ctx)
\tcollection := client.Database(${q(t.database)}).Collection(${q(t.collection)})

${decls.map((d) => pad + d).join('\n')}

\tcursor, err := ${call}
\tif err != nil {
\t\tpanic(err)
\t}
\tvar results []bson.M
\tif err := cursor.All(ctx, &results); err != nil {
\t\tpanic(err)
\t}
\tfor _, doc := range results {
\t\tfmt.Println(doc)
\t}
}
${helpers.length ? `\n${helpers.join('\n\n')}\n` : ''}`;
}

const GENERATORS: Record<CodeLanguage, (query: CodeQuery, target: CodeTarget) => string> = { shell, javascript, python, java, csharp, go };

export function generateCode(language: CodeLanguage, query: CodeQuery, target: CodeTarget): string {
  return GENERATORS[language](query, target);
}
