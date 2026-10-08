// Query → code: a find (filter, projection, sort) or an aggregation pipeline, written for mongosh and
// for the official drivers of Node.js, Python, Java, C# and Go, either as a snippet or as a whole program.
import { formatKey, isEjsonWrapper, isPlainObject, prettyShell } from './query';

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
  | { kind: 'find'; filter: unknown; projection?: unknown; sort?: unknown }
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
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** True for a projection or sort worth passing (not missing, not {}). */
const present = (v: unknown) => isPlainObject(v) && Object.keys(v).length > 0;

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
        if (/^[imsu]*$/.test(options) && pattern) return `/${pattern.replace(/(^|[^\\])\//g, '$1\\/')}/${options}`;
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
        return this.use('from bson.int64 import Int64', `Int64(${String(val)})`);
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
        return `${String(val)}L`;
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
        return `${String(val)}L`;
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
        return `int64(${String(val)})`;
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
    call = 'collection.Find(filter)';
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
