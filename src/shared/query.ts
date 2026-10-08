// Shared between the extension host and the webview.
// Values are handled in their "relaxed EJSON" plain-object shape ({ $oid: ... }, { $date: ... }),
// which is what EJSON.serialize produces and what EJSON.deserialize accepts.
import JSON5 from 'json5';

const WRAPPER_KEYS = new Set([
  '$oid',
  '$date',
  '$numberLong',
  '$numberDecimal',
  '$numberInt',
  '$numberDouble',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$timestamp',
  '$minKey',
  '$maxKey',
  '$symbol',
  '$code',
  '$undefined',
  '$dbPointer',
]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An EJSON type wrapper such as { $oid: "..." } (as opposed to a query operator object). */
export function isEjsonWrapper(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && WRAPPER_KEYS.has(keys[0]) && (keys.length === 1 || keys[0] === '$code');
}

/** A query operator object such as { $gte: 1, $lt: 5 }. */
export function isOperatorObject(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v) || isEjsonWrapper(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

/**
 * Canonical EJSON -> relaxed EJSON, except that int64 values outside the safe JS integer range
 * stay as { $numberLong } (EJSON's own relaxed mode rounds them to the nearest double).
 */
export function relaxEjson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(relaxEjson);
  if (!isPlainObject(v)) return v;
  if (isEjsonWrapper(v)) {
    const [key] = Object.keys(v);
    const val = v[key];
    if (key === '$numberInt') return Number(val);
    if (key === '$numberDouble') return Number.isFinite(Number(val)) ? Number(val) : v;
    if (key === '$numberLong') return Number.isSafeInteger(Number(val)) ? Number(val) : v;
    if (key === '$date' && isPlainObject(val) && typeof val.$numberLong === 'string') {
      const d = new Date(Number(val.$numberLong));
      const year = d.getUTCFullYear();
      return year >= 1970 && year <= 9999 ? { $date: d.toISOString() } : v;
    }
    return v;
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relaxEjson(x)]));
}

// ---------------------------------------------------------------------------
// Parsing: mongosh-like syntax -> JSON5 with EJSON wrappers -> plain object

type Rule = [RegExp, (m: RegExpExecArray) => string];

const q = JSON.stringify;

const RULES: Rule[] = [
  [/ObjectId\(\s*(["'])([0-9a-fA-F]{24})\1\s*\)/y, (m) => `{"$oid":${q(m[2])}}`],
  [/(?:ISODate|new\s+Date)\(\s*(["'])([^"']*)\1\s*\)/y, (m) => `{"$date":${q(normalizeDate(m[2]))}}`],
  [/(?:ISODate|new\s+Date)\(\s*\)/y, () => `{"$date":${q(new Date().toISOString())}}`],
  [/NumberLong\(\s*(["']?)(-?\d+)\1\s*\)/y, (m) => `{"$numberLong":${q(m[2])}}`],
  [/NumberInt\(\s*(["']?)(-?\d+)\1\s*\)/y, (m) => m[2]],
  [/NumberDecimal\(\s*(["']?)([-+0-9.eE]+|NaN|-?Infinity)\1\s*\)/y, (m) => `{"$numberDecimal":${q(m[2])}}`],
  [/UUID\(\s*(["'])([0-9a-fA-F-]{32,36})\1\s*\)/y, (m) => `{"$uuid":${q(formatUuid(m[2]))}}`],
  [
    /BinData\(\s*(\d+)\s*,\s*(["'])([A-Za-z0-9+/=]*)\2\s*\)/y,
    (m) => `{"$binary":{"base64":${q(m[3])},"subType":${q(Number(m[1]).toString(16).padStart(2, '0'))}}}`,
  ],
  [/Timestamp\(\s*\{\s*t\s*:\s*(\d+)\s*,\s*i\s*:\s*(\d+)\s*\}\s*\)/y, (m) => `{"$timestamp":{"t":${m[1]},"i":${m[2]}}}`],
  [/Timestamp\(\s*(\d+)\s*,\s*(\d+)\s*\)/y, (m) => `{"$timestamp":{"t":${m[1]},"i":${m[2]}}}`],
  [/MinKey\(\s*\)/y, () => `{"$minKey":1}`],
  [/MaxKey\(\s*\)/y, () => `{"$maxKey":1}`],
];

const REGEX_LITERAL = /\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([a-z]*)/y;

function normalizeDate(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
}

function formatUuid(s: string): string {
  const hex = s.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function scanString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === quote) return i + 1;
    else i++;
  }
  return src.length;
}

/** Rewrites shell helpers (ObjectId(...), ISODate(...), /re/i, ...) into EJSON wrappers, leaving strings untouched. */
export function shellToJson5(src: string): string {
  let out = '';
  let prev = ''; // last non-whitespace char emitted
  let i = 0;
  outer: while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const end = scanString(src, i);
      out += src.slice(i, end);
      i = end;
      prev = c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && (prev === '' || ':[,('.includes(prev))) {
      REGEX_LITERAL.lastIndex = i;
      const m = REGEX_LITERAL.exec(src);
      if (m) {
        const options = [...new Set(m[2].replace(/[^imsxu]/g, ''))].sort().join('');
        out += `{"$regularExpression":{"pattern":${q(m[1])},"options":${q(options)}}}`;
        i += m[0].length;
        prev = '}';
        continue;
      }
    }
    if (/[A-Za-z]/.test(c) && !/[\w$]/.test(src[i - 1] ?? '')) {
      for (const [re, replace] of RULES) {
        re.lastIndex = i;
        const m = re.exec(src);
        if (m) {
          out += replace(m);
          i += m[0].length;
          prev = '}';
          continue outer;
        }
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Parses a mongosh-like query string into a relaxed-EJSON plain value. */
export function parseQuery(text: string): unknown {
  return JSON5.parse(shellToJson5(text));
}

// ---------------------------------------------------------------------------
// Formatting: relaxed-EJSON plain value -> mongosh-like string

function formatKey(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k);
}

function base64ToHex(b64: string): string {
  try {
    const bin = atob(b64);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return hex;
  } catch {
    return '';
  }
}

export function formatWrapper(v: Record<string, unknown>): string | undefined {
  const [key] = Object.keys(v);
  const val = v[key] as any;
  switch (key) {
    case '$oid':
      return `ObjectId(${q(val)})`;
    case '$date': {
      if (typeof val === 'string') return `ISODate(${q(val)})`;
      const ms = Number(val?.$numberLong ?? val);
      const d = new Date(ms);
      return isNaN(d.getTime()) ? `new Date(${ms})` : `ISODate(${q(d.toISOString())})`;
    }
    case '$numberLong':
      return `NumberLong(${q(val)})`;
    case '$numberDecimal':
      return `NumberDecimal(${q(val)})`;
    case '$numberInt':
    case '$numberDouble':
      return String(val);
    case '$uuid':
      return `UUID(${q(val)})`;
    case '$binary': {
      if (val?.subType === '04' || val?.subType === '03') {
        const hex = base64ToHex(val.base64);
        if (hex.length === 32) return `UUID(${q(formatUuid(hex))})`;
      }
      return `BinData(${parseInt(val?.subType ?? '0', 16)}, ${q(val?.base64 ?? '')})`;
    }
    case '$regularExpression':
      return `/${String(val?.pattern ?? '').replace(/(^|[^\\])\//g, '$1\\/')}/${val?.options ?? ''}`;
    case '$timestamp':
      return `Timestamp({ t: ${val?.t}, i: ${val?.i} })`;
    case '$minKey':
      return 'MinKey()';
    case '$maxKey':
      return 'MaxKey()';
    case '$undefined':
      return 'undefined';
    case '$symbol':
      return q(val);
    case '$code':
      return `Code(${q(val)})`;
    default:
      return undefined;
  }
}

function wrap(open: string, close: string, items: string[], indent: number | undefined, level: number): string {
  if (indent === undefined) return open === '{' ? `{ ${items.join(', ')} }` : `[${items.join(', ')}]`;
  const pad = ' '.repeat(indent * (level + 1));
  const end = ' '.repeat(indent * level);
  return `${open}\n${items.map((s) => pad + s).join(',\n')}\n${end}${close}`;
}

/** Formats a relaxed-EJSON value as mongosh-like text. Single line unless `indent` is given. */
export function toShell(v: unknown, indent?: number, level = 0): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return q(v);
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return String(v);
    return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
  }
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return wrap('[', ']', v.map((x) => toShell(x, indent, level + 1)), indent, level);
  }
  if (isPlainObject(v)) {
    if (isEjsonWrapper(v)) {
      const special = formatWrapper(v);
      if (special !== undefined) return special;
    }
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    return wrap(
      '{',
      '}',
      entries.map(([k, x]) => `${formatKey(k)}: ${toShell(x, indent, level + 1)}`),
      indent,
      level,
    );
  }
  return String(v);
}

/** Mongosh text where each value stays on one line when it fits in `width`, otherwise its entries go one per line. */
export function prettyShell(v: unknown, level = 0, width = 76): string {
  const single = toShell(v);
  const pad = '  '.repeat(level);
  if (pad.length + single.length <= width) return single;
  if (Array.isArray(v) && v.length) {
    const lines = v.map((x) => `${pad}  ${prettyShell(x, level + 1, width)}`);
    return `[\n${lines.join(',\n')}\n${pad}]`;
  }
  if (isPlainObject(v) && !isEjsonWrapper(v) && Object.keys(v).length) {
    const lines = Object.entries(v).map(([k, x]) => `${pad}  ${formatKey(k)}: ${prettyShell(x, level + 1, width)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  return single;
}

/** Formats a filter: single line when short, otherwise one top-level field per line. */
export function formatFilter(obj: Record<string, unknown>): string {
  const single = toShell(obj);
  if (single.length <= 70) return single;
  const lines = Object.entries(obj).map(([k, v]) => `  ${formatKey(k)}: ${toShell(v)}`);
  return `{\n${lines.join(',\n')}\n}`;
}

/**
 * Adds `key: condition` to a filter-like object text and returns the reformatted text.
 * Operator objects on the same key are merged ({ $gte } + { $lte } → a range). With `within` (an array
 * containing `key`), the condition goes into that array's $elemMatch, so conditions added on
 * different fields apply to the same element. Throws if the text isn't an object.
 */
export function mergeCondition(text: string, key: string, condition: unknown, within?: string): string {
  const filter = text.trim() ? parseQuery(text) : {};
  if (!isPlainObject(filter)) throw new Error('must be an object');
  if (within && key.startsWith(`${within}.`)) {
    const existing = filter[within];
    const target = isOperatorObject(existing) ? existing : {};
    const elemMatch = isPlainObject(target.$elemMatch) ? target.$elemMatch : {};
    mergeField(elemMatch, key.slice(within.length + 1), condition);
    filter[within] = { ...target, $elemMatch: elemMatch };
  } else {
    mergeField(filter, key, condition);
  }
  return formatFilter(filter);
}

function mergeField(obj: Record<string, unknown>, key: string, condition: unknown): void {
  const existing = obj[key];
  obj[key] = isOperatorObject(condition) && isOperatorObject(existing) ? { ...existing, ...condition } : condition;
}
