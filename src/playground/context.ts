// Where the caret is in a playground script, for completion: inside the arguments of which call
// (db.users.find(…), ….sort(…)), or after `db.` / `db.users.` / `….find().`. Sessions too:
// `db.getMongo().`, `….startSession().`, `session.getDatabase("x").…`, and variables assigned one of them
// (`const session = db.getMongo().startSession()`).
import type { CompletionKind } from '../shared/complete';

export interface CallAt {
  /** Collection the call is on; undefined for methods of `db`. */
  collection?: string;
  method: string;
  /** For cursor methods (sort, project, …): the call that created the cursor (find, aggregate). */
  cursorOf?: string;
  argIndex: number;
  /** Offset where the argument at the caret starts. */
  argStart: number;
  /** The database named by the receiver (session.getDatabase("x"), db.getSiblingDB("x")), if any. */
  database?: string;
}

export type MemberAt =
  | { kind: 'db'; prefix: string; start: number; database?: string }
  | { kind: 'collection'; collection: string; prefix: string; start: number; database?: string }
  | { kind: 'cursor'; prefix: string; start: number }
  | { kind: 'mongo'; prefix: string; start: number }
  | { kind: 'session'; prefix: string; start: number };

interface Frame {
  char: string;
  pos: number;
  commas: number;
  lastComma: number;
}

interface Scanned {
  frames: Frame[];
  /** Position of each closing bracket → position of its opening bracket. */
  openOf: Map<number, number>;
  /** The caret is inside a string (", ', `), a comment (//, /*) or a regex (/). */
  literal?: string;
}

const OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function scan(text: string, offset: number): Scanned {
  const frames: Frame[] = [];
  const openOf = new Map<number, number>();
  let prev = '';
  let i = 0;
  while (i < offset) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0 || end >= offset) return { frames, openOf, literal: '//' };
      i = end + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0 || end + 2 > offset) return { frames, openOf, literal: '/*' };
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || (c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)))) {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      if (j >= offset) return { frames, openOf, literal: c };
      i = j + 1;
      if (c === '/') while (i < text.length && /[a-z]/.test(text[i])) i++;
      prev = 'x';
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      frames.push({ char: c, pos: i, commas: 0, lastComma: -1 });
    } else if (c === ')' || c === ']' || c === '}') {
      const idx = frames.map((f) => f.char).lastIndexOf(OPEN[c]);
      if (idx >= 0) {
        openOf.set(i, frames[idx].pos);
        frames.length = idx;
      }
    } else if (c === ',' && frames.length) {
      const f = frames[frames.length - 1];
      f.commas++;
      f.lastComma = i;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { frames, openOf };
}

interface Receiver {
  collection?: string;
  cursorOf?: string;
  /** On `db` (or a database of a session) or a collection. */
  onDb: boolean;
  /** The database, when named in the expression (session.getDatabase("x")). */
  database?: string;
  /** `db.getMongo()` or a session, which aren't databases. */
  object?: 'mongo' | 'session';
}

interface Callee extends Receiver {
  method: string;
}

/** Methods returning a database: db.getSiblingDB("x"), session.getDatabase("x"), db.getMongo().getDB("x"). */
const DATABASE_METHODS = ['getSiblingDB', 'getDatabase', 'getDB'];

/** The string of a call's only argument: ("x") → x. */
const stringArg = (args: string) => /^\(\s*(["'`])((?:(?!\1).)+)\1\s*\)$/.exec(args)?.[2];

/** Where the expression starting at `from` ends: `;`, a newline or a comma outside brackets and strings. */
function expressionEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth < 0) return i;
    } else if (depth === 0 && (c === ';' || c === '\n' || c === ',')) return i;
  }
  return text.length;
}

/** The whole script, and where the text being read starts in it: variables are looked up in the script. */
interface Source {
  script: string;
  at: number;
}

/**
 * What a variable holds, from its last `const` / `let` / `var` declaration before `before`: a database,
 * a collection, `db.getMongo()` or a session (not cursors nor documents).
 */
function variableBefore(src: Source, name: string, before: number, depth: number): Receiver | null {
  if (depth > 3) return null;
  let init = -1;
  const declared = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*(?:await\\s+)?`, 'g');
  for (const m of src.script.slice(0, before).matchAll(declared)) init = m.index + m[0].length;
  if (init < 0) return null;
  const expr = src.script.slice(init, expressionEnd(src.script, init));
  const held = receiverBefore(expr, expr.length, scan(expr, expr.length).openOf, depth + 1, { script: src.script, at: init });
  return held?.cursorOf ? null : held;
}

const skipSpaceBack = (text: string, i: number) => {
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i;
};

/**
 * What a receiver expression ending at `end` is: a collection (db.users, db.system.views,
 * db.getCollection("x"), db["x"]), `db`, a cursor, `db.getMongo()`, a session, or a variable holding one.
 */
function receiverBefore(text: string, end: number, openOf: Map<number, number>, depth = 0, src: Source = { script: text, at: 0 }): Receiver | null {
  end = skipSpaceBack(text, end);
  if (text[end - 1] === ')') {
    const open = openOf.get(end - 1);
    if (open === undefined) return null;
    const inner = calleeBefore(text, open, openOf, depth, src);
    if (!inner) return null;
    const isDb = inner.onDb && inner.collection === undefined && !inner.cursorOf;
    if (DATABASE_METHODS.includes(inner.method) && (isDb || inner.object)) return { onDb: true, database: stringArg(text.slice(open, end)) };
    if (inner.method === 'getMongo' && (isDb || inner.object)) return { onDb: false, object: 'mongo' };
    if (inner.method === 'startSession' && inner.object === 'mongo') return { onDb: false, object: 'session' };
    if (!inner.onDb) return null;
    if (inner.method === 'getCollection' && isDb) {
      const name = stringArg(text.slice(open, end));
      return name ? { collection: name, onDb: true, database: inner.database } : null;
    }
    // A cursor: find(...).sort(...) → remember where it came from.
    return { collection: inner.collection, cursorOf: inner.cursorOf ?? inner.method, onDb: true, database: inner.database };
  }
  const m = /\b([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(["'])[^"'\n]+\3\s*\])*)$/.exec(text.slice(Math.max(0, end - 300), end));
  if (!m) return null;
  const parts = [...m[2].matchAll(/\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"'\n]+)["']\s*\]/g)].map((p) => p[1] ?? p[2]);
  const root = end - m[0].length;
  const dot = skipSpaceBack(text, root);
  const call = text[dot - 1] === '.' ? skipSpaceBack(text, dot - 1) : -1;
  let base: Receiver | null;
  let names = parts;
  if (call > 0 && text[call - 1] === ')') {
    // Names after a call: session.getDatabase("x").users, db.getSiblingDB("x").logs.archive.
    base = receiverBefore(text, call, openOf, depth, src);
    names = [m[1], ...parts];
  } else if (m[1] === 'db') base = { onDb: true };
  // A variable (not a property: ….name).
  else base = call < 0 ? variableBefore(src, m[1], src.at + root, depth) : null;
  if (!base) return null;
  if (!names.length) return base;
  if (base.object || base.cursorOf) return null;
  // db.users, or a collection followed by more names: db.logs.archive.
  return { ...base, collection: [...(base.collection !== undefined ? [base.collection] : []), ...names].join('.') };
}

/** The function called by the parenthesis at `paren`. */
function calleeBefore(text: string, paren: number, openOf: Map<number, number>, depth = 0, src: Source = { script: text, at: 0 }): Callee | null {
  const end = skipSpaceBack(text, paren);
  const m = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, end - 100), end));
  if (!m) return null;
  const method = m[1];
  const dot = skipSpaceBack(text, end - method.length);
  if (text[dot - 1] !== '.') return { method, onDb: false };
  const receiver = receiverBefore(text, dot - 1, openOf, depth, src);
  if (!receiver) return { method, onDb: false };
  return { method, ...receiver };
}

/** The call whose arguments contain `offset`, if any. */
export function callAt(text: string, offset: number): CallAt | null {
  const s = scan(text, offset);
  if (s.literal && !/^["'`]$/.test(s.literal)) return null;
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i];
    if (f.char !== '(') continue;
    const callee = calleeBefore(text, f.pos, s.openOf);
    if (!callee?.onDb) return null;
    return {
      collection: callee.collection,
      method: callee.method,
      cursorOf: callee.cursorOf,
      argIndex: f.commas,
      argStart: (f.lastComma >= 0 ? f.lastComma : f.pos) + 1,
      ...(callee.database !== undefined && { database: callee.database }),
    };
  }
  return null;
}

/** A member being typed after `db.`, `db.<collection>.` or a cursor (`find(...).`). */
export function memberAt(text: string, offset: number): MemberAt | null {
  const before = text.slice(0, offset);
  const m = /\.\s*([A-Za-z_$][\w$]*)?$/.exec(before);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const start = offset - prefix.length;
  const s = scan(text, m.index);
  if (s.literal) return null;
  const receiver = receiverBefore(text, m.index, s.openOf);
  if (!receiver) return null;
  if (receiver.object) return { kind: receiver.object, prefix, start };
  if (receiver.cursorOf) return { kind: 'cursor', prefix, start };
  const database = receiver.database !== undefined ? { database: receiver.database } : {};
  if (receiver.collection === undefined) return { kind: 'db', prefix, start, ...database };
  return { kind: 'collection', collection: receiver.collection, prefix, start, ...database };
}

/** Database selected by the last `use("…")` before `offset`. */
export function databaseAt(text: string, offset: number): string | undefined {
  let db: string | undefined;
  for (const m of text.slice(0, offset).matchAll(/(?:^|[;\s])use\(\s*(["'`])([^"'`\n]+)\1\s*\)/g)) db = m[2];
  return db;
}

const COLLECTION_ARGS: Record<string, (CompletionKind | null)[]> = {
  find: ['filter', 'project'],
  findOne: ['filter', 'project'],
  countDocuments: ['filter'],
  count: ['filter'],
  deleteOne: ['filter'],
  deleteMany: ['filter'],
  findOneAndDelete: ['filter'],
  updateOne: ['filter', 'update'],
  updateMany: ['filter', 'update'],
  findOneAndUpdate: ['filter', 'update'],
  replaceOne: ['filter'],
  findOneAndReplace: ['filter'],
  distinct: ['field', 'filter'],
  aggregate: ['pipeline'],
  createIndex: ['index'],
  watch: ['pipeline'],
};

const CURSOR_ARGS: Record<string, CompletionKind> = { sort: 'sort', project: 'project', projection: 'project', hint: 'index' };

/** What the argument at the caret is, for the query completion engine. */
export function argumentKind(call: CallAt, argText: string): CompletionKind | null {
  if (call.cursorOf) return call.argIndex === 0 ? CURSOR_ARGS[call.method] ?? null : null;
  if (call.method === 'aggregate') {
    // aggregate([...]) or aggregate({ $match }, { $group }, …)
    return argText.trimStart().startsWith('[') || (call.argIndex === 0 && !argText.trim()) ? 'pipeline' : 'stageObject';
  }
  if (call.collection === undefined) return null;
  return COLLECTION_ARGS[call.method]?.[call.argIndex] ?? null;
}
