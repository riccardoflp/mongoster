// Whether a document matches a filter, decided as MongoDB decides it, for the query operators a page of documents
// can be matched with in the webview: comparison, sets, $exists, $type, $regex, $mod, arrays and logic. The values are
// relaxed Extended JSON plain objects ({ $oid }, { $date }, { $numberLong } …), as the table has them. It is for
// display only (conditional formatting): nothing that writes may rely on it. No vscode, Node or mongodb dependency.
import { isEjsonWrapper, isPlainObject } from './query';

/** A filter the matcher can't run: the message says why, for the user. */
export class MatchError extends Error {}

export type Predicate = (doc: unknown) => boolean;

/** A field that is not there; equal to null, as in MongoDB. */
const MISSING = Symbol('missing');

/** Operators of a query that need the server: refused rather than approximated. */
const UNSUPPORTED = new Set([
  '$expr',
  '$where',
  '$text',
  '$jsonSchema',
  '$sampleRate',
  '$geoWithin',
  '$geoIntersects',
  '$near',
  '$nearSphere',
  '$bitsAllSet',
  '$bitsAllClear',
  '$bitsAnySet',
  '$bitsAnyClear',
  '$search',
  '$vectorSearch',
]);

const unsupported = (op: string) => new MatchError(`${op} is not supported in a formatting rule.`);
const unknown = (op: string) => new MatchError(`Unknown operator ${op}.`);

/**
 * Feature: query.match
 * Compiles a parsed filter (a relaxed Extended JSON object, as parseQuery returns it) into a predicate on documents.
 * Throws a MatchError for what it does not support or what MongoDB would refuse.
 */
export function compileFilter(filter: unknown): Predicate {
  if (!isPlainObject(filter) || isEjsonWrapper(filter)) throw new MatchError('The condition must be a document: { field: value }.');
  return compileDocument(filter);
}

function compileDocument(filter: Record<string, unknown>): Predicate {
  const parts: Predicate[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) {
      const p = compileTopOperator(key, value);
      if (p) parts.push(p);
    } else {
      parts.push(compileField(key.split('.'), value));
    }
  }
  return (doc) => parts.every((p) => p(doc));
}

function compileTopOperator(op: string, value: unknown): Predicate | undefined {
  switch (op) {
    case '$and':
    case '$or':
    case '$nor': {
      if (!Array.isArray(value) || !value.length) throw new MatchError(`${op} needs a non-empty array of conditions.`);
      const parts = value.map((v) => {
        if (!isPlainObject(v) || isEjsonWrapper(v)) throw new MatchError(`The conditions of ${op} must be documents.`);
        return compileDocument(v);
      });
      if (op === '$and') return (doc) => parts.every((p) => p(doc));
      if (op === '$or') return (doc) => parts.some((p) => p(doc));
      return (doc) => !parts.some((p) => p(doc));
    }
    case '$comment':
      return undefined;
    default:
      throw UNSUPPORTED.has(op) ? unsupported(op) : unknown(op);
  }
}

// ---------------------------------------------------------------------------
// Paths

/**
 * The values at `path`, as MongoDB finds them: through sub-documents, into the elements of arrays (a numeric segment
 * is also an index), MISSING where the path ends.
 */
function valuesAt(value: unknown, path: string[], i = 0, out: unknown[] = []): unknown[] {
  if (i === path.length) {
    out.push(value);
    return out;
  }
  const segment = path[i];
  if (Array.isArray(value)) {
    if (/^\d+$/.test(segment) && Number(segment) < value.length) valuesAt(value[Number(segment)], path, i + 1, out);
    for (const element of value) if (isDocument(element)) valuesAt(element, path, i, out);
    return out;
  }
  if (isDocument(value) && segment in value) return valuesAt(value[segment], path, i + 1, out);
  out.push(MISSING);
  return out;
}

const isDocument = (v: unknown): v is Record<string, unknown> => isPlainObject(v) && !isEjsonWrapper(v);

/** A value test, applied to each value at the path and, for an array, to each of its elements. */
type ValueTest = (v: unknown) => boolean;

/** A test on the values found at a path. */
type ValuesTest = (values: unknown[]) => boolean;

/** True when a value at the path, or an element of an array there, passes. */
const anyValue =
  (test: ValueTest): ValuesTest =>
  (values) =>
    values.some((v) => test(v) || (Array.isArray(v) && v.some(test)));

function compileField(path: string[], condition: unknown): Predicate {
  const test = isOperatorDocument(condition) ? compileOperators(condition) : implicitEquality(condition);
  return (doc) => {
    const values = valuesAt(doc, path);
    return test(values.length ? values : [MISSING]);
  };
}

/** `{ $gt: 1 }` as opposed to a sub-document to be equal to: its first key is an operator. */
function isOperatorDocument(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v) || isEjsonWrapper(v)) return false;
  const [first] = Object.keys(v);
  return first !== undefined && first.startsWith('$');
}

/** `{ field: value }`: equal, or a string matching it when it's a regex. */
function implicitEquality(value: unknown): ValuesTest {
  if (isRegex(value)) {
    const re = toRegExp(value);
    return anyValue((v) => regexTest(re, v) || equals(v, value));
  }
  return anyValue((v) => equals(v, value));
}

// ---------------------------------------------------------------------------
// Operators on a field

function compileOperators(ops: Record<string, unknown>): ValuesTest {
  const tests: ValuesTest[] = [];
  for (const [op, operand] of Object.entries(ops)) {
    if (op === '$options') {
      if (!('$regex' in ops)) throw new MatchError('$options needs $regex.');
      continue;
    }
    if (!op.startsWith('$')) throw unknown(op);
    tests.push(compileOperator(op, operand, ops));
  }
  return (values) => tests.every((t) => t(values));
}

function compileOperator(op: string, operand: unknown, ops: Record<string, unknown>): ValuesTest {
  switch (op) {
    case '$eq':
      return anyValue((v) => equals(v, operand));
    case '$ne': {
      const eq = anyValue((v) => equals(v, operand));
      return (values) => !eq(values);
    }
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte': {
      const accept = { $gt: (c: number) => c > 0, $gte: (c: number) => c >= 0, $lt: (c: number) => c < 0, $lte: (c: number) => c <= 0 }[op];
      if (isRegex(operand)) throw new MatchError(`${op} can't compare with a regular expression.`);
      return anyValue((v) => {
        const c = compare(v, operand);
        return c !== undefined && accept(c);
      });
    }
    case '$in':
      return anyValue(inTest(op, operand));
    case '$nin': {
      const test = anyValue(inTest(op, operand));
      return (values) => !test(values);
    }
    case '$exists':
      return operand === false || operand === 0 ? (values) => values.every((v) => v === MISSING) : (values) => values.some((v) => v !== MISSING);
    case '$type':
      return anyValue(typeTest(operand));
    case '$regex': {
      const re = regexOperand(operand, ops.$options);
      return anyValue((v) => regexTest(re, v));
    }
    case '$mod':
      return anyValue(modTest(operand));
    case '$size': {
      const n = numberOf(operand);
      if (n === undefined || !Number.isInteger(n) || n < 0) throw new MatchError('$size needs a whole number.');
      return (values) => values.some((v) => Array.isArray(v) && v.length === n);
    }
    case '$all': {
      if (!Array.isArray(operand)) throw new MatchError('$all needs an array.');
      if (!operand.length) return () => false;
      const parts = operand.map((item) =>
        isPlainObject(item) && Object.keys(item)[0] === '$elemMatch' ? compileOperator('$elemMatch', item.$elemMatch, {}) : implicitEquality(item),
      );
      return (values) => parts.every((p) => p(values));
    }
    case '$elemMatch':
      return elemMatch(operand);
    case '$not': {
      let inner: ValuesTest;
      if (isRegex(operand)) inner = implicitEquality(operand);
      else if (isOperatorDocument(operand)) inner = compileOperators(operand);
      else throw new MatchError('$not needs an operator such as { $gt: 1 } or a regular expression.');
      return (values) => !inner(values);
    }
    case '$and':
    case '$or':
    case '$nor':
      throw new MatchError(`${op} goes at the top of the condition or inside $elemMatch, not on a field.`);
    default:
      throw UNSUPPORTED.has(op) ? unsupported(op) : unknown(op);
  }
}

function inTest(op: string, operand: unknown): ValueTest {
  if (!Array.isArray(operand)) throw new MatchError(`${op} needs an array.`);
  const tests = operand.map((item): ValueTest => {
    if (isOperatorDocument(item)) throw new MatchError(`${op} can't contain an operator.`);
    if (isRegex(item)) {
      const re = toRegExp(item);
      return (v) => regexTest(re, v) || equals(v, item);
    }
    return (v) => equals(v, item);
  });
  return (v) => tests.some((t) => t(v));
}

function elemMatch(operand: unknown): ValuesTest {
  if (!isPlainObject(operand) || isEjsonWrapper(operand)) throw new MatchError('$elemMatch needs a document.');
  const keys = Object.keys(operand);
  const logic = keys.some((k) => k === '$and' || k === '$or' || k === '$nor');
  // { $gte: 80, $lt: 85 } tests the elements' values; { product: "x", score: { $gt: 8 } } the elements as documents.
  if (keys.length && keys.every((k) => k.startsWith('$')) && !logic) {
    const test = compileOperators(operand);
    return (values) => values.some((v) => Array.isArray(v) && v.some((e) => test([e])));
  }
  const test = compileDocument(operand);
  return (values) => values.some((v) => Array.isArray(v) && v.some((e) => isDocument(e) && test(e)));
}

// ---------------------------------------------------------------------------
// $type

/** BSON type numbers of the type names accepted by $type. */
const TYPE_NUMBERS: Record<string, number> = {
  double: 1,
  string: 2,
  object: 3,
  array: 4,
  binData: 5,
  undefined: 6,
  objectId: 7,
  bool: 8,
  date: 9,
  null: 10,
  regex: 11,
  dbPointer: 12,
  javascript: 13,
  symbol: 14,
  int: 16,
  timestamp: 17,
  long: 18,
  decimal: 19,
  minKey: -1,
  maxKey: 127,
};

const NUMBER_TYPES = [1, 16, 18, 19];

/**
 * The BSON types a value may have. A whole number is int, long and double at once: the table's values do not tell
 * them apart (relaxed Extended JSON writes all three as plain numbers when they fit).
 */
function typesOf(v: unknown): number[] {
  if (v === MISSING) return [];
  if (v === null) return [10];
  if (Array.isArray(v)) return [4];
  switch (typeof v) {
    case 'string':
      return [2];
    case 'boolean':
      return [8];
    case 'number':
      return Number.isInteger(v) ? [1, 16, 18] : [1];
  }
  if (isEjsonWrapper(v)) {
    const key = Object.keys(v)[0];
    const types: Record<string, number> = {
      $oid: 7,
      $date: 9,
      $numberInt: 16,
      $numberLong: 18,
      $numberDouble: 1,
      $numberDecimal: 19,
      $binary: 5,
      $uuid: 5,
      $regularExpression: 11,
      $timestamp: 17,
      $minKey: -1,
      $maxKey: 127,
      $symbol: 14,
      $code: 13,
      $undefined: 6,
      $dbPointer: 12,
    };
    return types[key] !== undefined ? [types[key]] : [];
  }
  return isPlainObject(v) ? [3] : [];
}

function typeTest(operand: unknown): ValueTest {
  const wanted = (Array.isArray(operand) ? operand : [operand]).flatMap((t) => {
    if (t === 'number') return NUMBER_TYPES;
    if (typeof t === 'string' && TYPE_NUMBERS[t] !== undefined) return [TYPE_NUMBERS[t]];
    const n = numberOf(t);
    if (n !== undefined && Object.values(TYPE_NUMBERS).includes(n)) return [n];
    throw new MatchError(`$type: unknown type ${JSON.stringify(t)}.`);
  });
  if (!wanted.length) throw new MatchError('$type needs at least one type.');
  return (v) => typesOf(v).some((t) => wanted.includes(t));
}

// ---------------------------------------------------------------------------
// $mod and $regex

function modTest(operand: unknown): ValueTest {
  const [d, r] = Array.isArray(operand) ? operand.map(numberOf) : [];
  if (!Array.isArray(operand) || operand.length !== 2 || d === undefined || r === undefined) {
    throw new MatchError('$mod needs an array of two numbers: [ divisor, remainder ].');
  }
  const divisor = Math.trunc(d);
  if (divisor === 0) throw new MatchError('$mod: the divisor can not be 0.');
  const remainder = Math.trunc(r);
  return (v) => {
    const n = typeof v === 'number' || isNumberWrapper(v) ? numberOf(v) : undefined;
    return n !== undefined && Number.isFinite(n) && Math.trunc(n) % divisor === remainder;
  };
}

function isRegex(v: unknown): v is { $regularExpression: { pattern: string; options?: string } } {
  return isPlainObject(v) && isPlainObject(v.$regularExpression);
}

/** A regex of MongoDB as a JavaScript one: the options JavaScript has; x drops the pattern's spaces and comments. */
function makeRegExp(pattern: string, options: string): RegExp {
  let source = pattern;
  if (options.includes('x')) source = source.replace(/\\[\s\S]|\[(?:\\.|[^\]\\])*\]|#[^\n]*|\s+/g, (m) => (m.startsWith('\\') || m.startsWith('[') ? m : ''));
  const flags = [...new Set(options.replace(/[^ims]/g, ''))].join('');
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (err) {
      throw new MatchError(`Invalid regular expression /${pattern}/: ${(err as Error).message}`);
    }
  }
}

function toRegExp(v: { $regularExpression: { pattern: string; options?: string } }): RegExp {
  return makeRegExp(String(v.$regularExpression.pattern ?? ''), String(v.$regularExpression.options ?? ''));
}

function regexOperand(operand: unknown, options: unknown): RegExp {
  if (options !== undefined && typeof options !== 'string') throw new MatchError('$options must be a string.');
  if (isRegex(operand)) {
    const own = String(operand.$regularExpression.options ?? '');
    return makeRegExp(String(operand.$regularExpression.pattern ?? ''), options === undefined ? own : options);
  }
  if (typeof operand !== 'string') throw new MatchError('$regex needs a string or a regular expression.');
  return makeRegExp(operand, (options as string | undefined) ?? '');
}

function regexTest(re: RegExp, v: unknown): boolean {
  const text = typeof v === 'string' ? v : isPlainObject(v) && typeof v.$symbol === 'string' ? v.$symbol : undefined;
  if (text === undefined) return false;
  re.lastIndex = 0;
  return re.test(text);
}

// ---------------------------------------------------------------------------
// Comparison: MongoDB's order of types, then the values within a type

const NUMBER_KEYS = new Set(['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']);

function isNumberWrapper(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.keys(v).length === 1 && NUMBER_KEYS.has(Object.keys(v)[0]);
}

/** A number, plain or wrapped; undefined for anything else. Int64 and decimals beyond 15 digits are rounded. */
function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (isNumberWrapper(v)) {
    const text = String(Object.values(v)[0]);
    return text === 'NaN' ? NaN : Number(text);
  }
  return undefined;
}

/** Where a value sorts among types, as in MongoDB's comparison order. */
function bracket(v: unknown): number {
  if (v === MISSING || v === null || v === undefined) return 2;
  if (Array.isArray(v)) return 6;
  switch (typeof v) {
    case 'number':
      return 3;
    case 'string':
      return 4;
    case 'boolean':
      return 9;
  }
  if (isEjsonWrapper(v)) {
    const key = Object.keys(v)[0];
    if (NUMBER_KEYS.has(key)) return 3;
    const brackets: Record<string, number> = {
      $minKey: 1,
      $undefined: 2,
      $symbol: 4,
      $binary: 7,
      $uuid: 7,
      $oid: 8,
      $date: 10,
      $timestamp: 11,
      $regularExpression: 12,
      $dbPointer: 13,
      $code: 14,
      $maxKey: 15,
    };
    return brackets[key] ?? 16;
  }
  return 5;
}

function dateMs(v: Record<string, unknown>): number {
  const d = v.$date;
  if (typeof d === 'string') return new Date(d).getTime();
  if (isPlainObject(d) && d.$numberLong !== undefined) return Number(d.$numberLong);
  return Number(d);
}

/** Bytes of a binary as hex, with its subtype first: a UUID(…) and its { $binary } with subtype 04 are the same. */
function binaryKey(v: Record<string, unknown>): string {
  if (typeof v.$uuid === 'string') return `04:${v.$uuid.replace(/-/g, '').toLowerCase()}`;
  const b = (isPlainObject(v.$binary) ? v.$binary : {}) as Record<string, unknown>;
  let hex = '';
  try {
    const bin = atob(String(b.base64 ?? ''));
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  } catch {
    hex = String(b.base64 ?? '');
  }
  return `${String(b.subType ?? '00').padStart(2, '0')}:${hex}`;
}

/** Strings in code point order, as MongoDB compares them without a collation. */
function compareStrings(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d < 0 ? -1 : 1;
  }
  return Math.sign(x.length - y.length);
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

function compareNumbers(a: number, b: number): number {
  // NaN equals NaN and sorts before every other number.
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b) ? 0 : Number.isNaN(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1, 0 or 1 when `a` and `b` are of the same type bracket, undefined otherwise (they never compare). */
function compare(a: unknown, b: unknown): number | undefined {
  const ba = bracket(a);
  if (ba !== bracket(b)) return undefined;
  return compareWithin(ba, a, b);
}

/** The full order, types first: for the fields of sub-documents and the elements of arrays. */
function compareAny(a: unknown, b: unknown): number {
  const ba = bracket(a);
  const bb = bracket(b);
  return ba !== bb ? sign(ba - bb) : compareWithin(ba, a, b);
}

function compareWithin(br: number, a: unknown, b: unknown): number {
  const wa = a as Record<string, unknown>;
  const wb = b as Record<string, unknown>;
  switch (br) {
    case 1:
    case 2:
    case 15:
      return 0;
    case 3:
      return compareNumbers(numberOf(a)!, numberOf(b)!);
    case 4:
      return compareStrings(typeof a === 'string' ? a : String(wa.$symbol), typeof b === 'string' ? b : String(wb.$symbol));
    case 5: {
      const ea = Object.entries(wa);
      const eb = Object.entries(wb);
      for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
        const c = sign(bracket(ea[i][1]) - bracket(eb[i][1])) || compareStrings(ea[i][0], eb[i][0]) || compareAny(ea[i][1], eb[i][1]);
        if (c) return c;
      }
      return sign(ea.length - eb.length);
    }
    case 6: {
      const xa = a as unknown[];
      const xb = b as unknown[];
      for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
        const c = compareAny(xa[i], xb[i]);
        if (c) return c;
      }
      return sign(xa.length - xb.length);
    }
    case 7:
      return compareStrings(binaryKey(wa), binaryKey(wb));
    case 8:
      return compareStrings(String(wa.$oid).toLowerCase(), String(wb.$oid).toLowerCase());
    case 9:
      return sign(Number(a) - Number(b));
    case 10:
      return compareNumbers(dateMs(wa), dateMs(wb));
    case 11: {
      const ta = (wa.$timestamp ?? {}) as Record<string, number>;
      const tb = (wb.$timestamp ?? {}) as Record<string, number>;
      return sign(Number(ta.t) - Number(tb.t)) || sign(Number(ta.i) - Number(tb.i));
    }
    default:
      return compareStrings(JSON.stringify(a), JSON.stringify(b));
  }
}

/** Equal as MongoDB's $eq: same type bracket and value; numbers across their types; null and a missing field. */
function equals(a: unknown, b: unknown): boolean {
  return compare(a, b) === 0;
}
