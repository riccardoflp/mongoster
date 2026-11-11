// A document's history from the oplog: the writes to one document (also inside transactions), and its
// versions rebuilt from them. The oplog keeps the new values of an update, never the old ones, so a
// version is exact when it is rebuilt forwards from an insert or a replacement (or when it is the current
// document); walking backwards from the current document, what an update changed becomes unknown and the
// versions before it are partial. Values are canonical EJSON ({ $numberInt: "1" }…), as in compare.ts,
// so every BSON type survives.
import { FieldDiff, fieldDiff, normalize } from './compare';
import { isEjsonWrapper, isPlainObject, relaxEjson, toShell } from './query';

type Obj = Record<string, unknown>;

/** Key of a value whose content isn't known (it may also be missing). NUL can't be in a BSON field name. */
export const UNKNOWN_KEY = '\u0000unknown';
/** An unknown value in the values to show: a string the views draw as "?". */
export const UNKNOWN_TEXT = '\u0000?';

const unknownValue = (): Obj => ({ [UNKNOWN_KEY]: true });
export const isUnknown = (v: unknown): boolean => isPlainObject(v) && v[UNKNOWN_KEY] === true;

const obj = (v: unknown): Obj => (isPlainObject(v) ? v : {});
/** A sub-document (not a type wrapper such as { $date }, nor an unknown value). */
const isDoc = (v: unknown): v is Obj => isPlainObject(v) && !isEjsonWrapper(v) && !isUnknown(v);
const isContainer = (v: unknown): v is Obj | unknown[] => Array.isArray(v) || isDoc(v);
/** Canonical EJSON is plain JSON. */
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

/** A number, or a canonical number wrapper. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  const o = obj(v);
  const n = Number(o.$numberInt ?? o.$numberLong ?? o.$numberDouble ?? NaN);
  return Number.isFinite(n) ? n : undefined;
}

/** A canonical { $date } as ISO text. */
function dateText(v: unknown): string | undefined {
  const d = obj(v).$date;
  const ms = typeof d === 'string' ? Date.parse(d) : num(d);
  return ms === undefined || Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Text that is the same for _id values MongoDB considers equal (1, 1.0 and NumberLong(1) are one _id). */
export function idKey(id: unknown): string {
  return JSON.stringify(normalize(id, { ignore: [], ignoreOrder: false, numbersByValue: true }));
}

// ---------------------------------------------------------------------------
// The operations on one document

export type DocOpKind = 'insert' | 'update' | 'replace' | 'delete' | 'drop' | 'renamed';

/** One write to the document, from an oplog entry or from the applyOps of a transaction. */
export interface DocOp {
  /** Timestamp of the oplog entry (of the applyOps, for an operation inside one). */
  t: number;
  i: number;
  /** Position in the applyOps; -1 for an entry of its own. */
  index: number;
  /** Wall clock time of the entry, ISO (servers older than 3.6 don't record it). */
  wall?: string;
  op: 'i' | 'u' | 'd' | 'c';
  /** o and o2 of the operation, canonical EJSON. */
  o: Obj;
  o2?: Obj;
  /** The operation is in an applyOps: a transaction, or one command writing several documents. */
  group?: 'transaction' | 'batch';
  /** The transaction takes several oplog entries (a large one). */
  partial?: boolean;
  /** A prepared transaction (sharded clusters): applied when its commit comes. */
  prepared?: boolean;
  /** Session id and transaction number (transactions and retryable writes), mongosh syntax. */
  lsid?: string;
  txnNumber?: string;
  /** Written by a chunk migration of a sharded cluster, not by a client. */
  migrate?: boolean;
  /** Drops and renames: what happened to the collection. */
  command?: string;
}

/** A stable key of an operation: its entry's timestamp and its place in the applyOps. */
export const opKey = (op: Pick<DocOp, 't' | 'i' | 'index'>) => `${op.t}:${op.i}:${op.index}`;

/** Whether `o` of an update entry has update operators ($set / $unset, or the $v 2 diff) rather than a replacement. */
const isUpdate = (o: Obj) => Object.keys(o).some((k) => k.startsWith('$'));

/** What the operation did to the document. */
export function opKind(op: DocOp): DocOpKind {
  switch (op.op) {
    case 'i':
      return 'insert';
    case 'd':
      return 'delete';
    case 'u':
      return isUpdate(op.o) ? 'update' : 'replace';
    default:
      return op.command?.startsWith('renamed into') ? 'renamed' : 'drop';
  }
}

/** The command on the collection `ns` of an entry on `<db>.$cmd`: undefined when it doesn't concern it. */
function collectionCommand(x: Obj, ns: string): string | undefined {
  const dot = ns.indexOf('.');
  const db = ns.slice(0, dot);
  const coll = ns.slice(dot + 1);
  if (x.ns !== `${db}.$cmd`) return undefined;
  const o = obj(x.o);
  if (o.drop === coll) return 'collection dropped';
  if (o.dropDatabase !== undefined) return 'database dropped';
  if (o.renameCollection === ns) return `collection renamed to ${String(o.to)}`;
  if (o.to === ns) return `renamed into this collection from ${String(o.renameCollection)}`;
  return undefined;
}

function matches(x: Obj, ns: string, key: string): boolean {
  if (x.op === 'c') return false;
  if (x.ns !== ns) return false;
  const id = x.op === 'u' ? obj(x.o2)._id : obj(x.o)._id;
  return id !== undefined && idKey(id) === key && (x.op === 'i' || x.op === 'u' || x.op === 'd');
}

/**
 * Whether an applyOps entry is a transaction: it has a session, and isn't one of the batched writes of a
 * single command (insertMany, deleteMany…), whose operations carry stmtId or which are marked with multiOpType.
 */
export function isTransactionEntry(e: Obj, inner: Obj[]): boolean {
  if (e.lsid === undefined || e.multiOpType !== undefined) return false;
  return !inner.some((x) => x.stmtId !== undefined);
}

const nonZeroTime = (v: unknown) => {
  const ts = obj(obj(obj(v).ts).$timestamp);
  return !!(num(ts.t) || num(ts.i));
};

/** Session and transaction number of an entry, in mongosh syntax. */
function session(e: Obj): Pick<DocOp, 'lsid' | 'txnNumber'> {
  const id = obj(e.lsid).id;
  return {
    ...(id !== undefined && { lsid: toShell(relaxEjson(id)) }),
    ...(e.txnNumber !== undefined && { txnNumber: toShell(relaxEjson(e.txnNumber)) }),
  };
}

/**
 * The operations of an oplog entry (canonical EJSON) on the document of `ns` whose _id has the key
 * `key` (idKey): the entry itself, those of its applyOps, or a drop or rename of the collection.
 */
export function documentOps(entry: Obj, ns: string, key: string): DocOp[] {
  const ts = obj(obj(entry.ts).$timestamp);
  const base = { t: num(ts.t) ?? 0, i: num(ts.i) ?? 0, ...(dateText(entry.wall) && { wall: dateText(entry.wall) }) };
  const o = obj(entry.o);
  const migrate = entry.fromMigrate === true ? { migrate: true } : {};
  const operation = (x: Obj) => ({ op: x.op as DocOp['op'], o: obj(x.o), ...(x.o2 !== undefined && { o2: obj(x.o2) }) });
  if (entry.op === 'c' && Array.isArray(o.applyOps)) {
    const inner = o.applyOps.map(obj);
    const transaction = isTransactionEntry(entry, inner);
    const who = {
      group: transaction ? ('transaction' as const) : ('batch' as const),
      ...((entry.partialTxn === true || nonZeroTime(entry.prevOpTime)) && { partial: true }),
      ...(o.prepare === true && { prepared: true }),
      ...session(entry),
      ...migrate,
    };
    const out: DocOp[] = [];
    inner.forEach((x, index) => {
      if (matches(x, ns, key)) out.push({ ...base, index, ...operation(x), ...who, ...(x.fromMigrate === true && { migrate: true }) });
    });
    return out;
  }
  if (entry.op === 'c') {
    const command = collectionCommand(entry, ns);
    return command ? [{ ...base, index: -1, op: 'c', o, command }] : [];
  }
  return matches(entry, ns, key) ? [{ ...base, index: -1, ...operation(entry), ...session(entry), ...migrate }] : [];
}

export interface OpChanges {
  /** Paths the update sets (an array element as items.3). */
  set: string[];
  unset: string[];
  /** Arrays resized, as "items to 2". */
  truncated: string[];
}

/** The fields an update sets and unsets, from its oplog entry ($v 2 diff, or $set / $unset); undefined for a replacement. */
export function updateChanges(o: Obj): OpChanges | undefined {
  const set: string[] = [];
  const unset: string[] = [];
  const truncated: string[] = [];
  const walk = (diff: Obj, prefix: string) => {
    for (const [k, v] of Object.entries(diff)) {
      if (k === 'u' || k === 'i') set.push(...Object.keys(obj(v)).map((f) => prefix + f));
      else if (k === 'd') unset.push(...Object.keys(obj(v)).map((f) => prefix + f));
      else if (k === 'a') continue;
      else if (k === 'l') truncated.push(`${prefix.slice(0, -1)} to ${num(v)}`);
      else if (/^u\d+$/.test(k)) set.push(prefix + k.slice(1));
      else if (k.startsWith('s')) walk(obj(v), `${prefix}${k.slice(1)}.`);
    }
  };
  if (isPlainObject(o.diff)) walk(o.diff, '');
  else if (isUpdate(o)) {
    set.push(...Object.keys(obj(o.$set)));
    unset.push(...Object.keys(obj(o.$unset)));
  } else return undefined;
  return { set, unset, truncated };
}

// ---------------------------------------------------------------------------
// Applying an update forwards, and undoing it backwards

/** The update can't be applied to the document as it is known: the reconstruction stops being exact. */
class Mismatch extends Error {}

const OPERATOR_KEYS = new Set(['$v', '$set', '$unset']);

/** The document after an update entry's `o` ($set / $unset with dotted paths, or the $v 2 diff). */
export function applyUpdate(doc: Obj, o: Obj): Obj {
  if (isPlainObject(o.diff)) return applyObjectDiff(doc, o.diff);
  if (Object.keys(o).some((k) => !OPERATOR_KEYS.has(k))) throw new Mismatch(`Unknown update format: ${Object.keys(o).join(', ')}`);
  const out = clone(doc);
  for (const [path, v] of Object.entries(obj(o.$set))) setPath(out, path.split('.'), clone(v));
  for (const path of Object.keys(obj(o.$unset))) unsetPath(out, path.split('.'));
  return out;
}

/** $set of a dotted path: missing sub-documents are created, arrays padded with null up to the index. */
function setPath(root: Obj, parts: string[], value: unknown): void {
  let node: Obj | unknown[] = root;
  for (let n = 0; n < parts.length; n++) {
    const key = parts[n];
    const last = n === parts.length - 1;
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(key)) throw new Mismatch(`${key} is not an index of an array`);
      const idx = Number(key);
      while (node.length < idx) node.push(null);
      if (last) {
        node[idx] = value;
        return;
      }
      if (idx === node.length) node.push({});
      const child: unknown = node[idx];
      if (!isContainer(child)) throw new Mismatch(`${parts.slice(0, n + 1).join('.')} can't hold fields`);
      node = child;
    } else {
      if (last) {
        node[key] = value;
        return;
      }
      if (node[key] === undefined) node[key] = {};
      const child: unknown = node[key];
      if (!isContainer(child)) throw new Mismatch(`${parts.slice(0, n + 1).join('.')} can't hold fields`);
      node = child;
    }
  }
}

/** The value at a dotted path's next step. */
function child(node: unknown, key: string): unknown {
  if (Array.isArray(node)) return /^\d+$/.test(key) ? node[Number(key)] : undefined;
  return isDoc(node) ? node[key] : undefined;
}

/** $unset of a dotted path: an array element becomes null, as the server does. */
function unsetPath(root: Obj, parts: string[]): void {
  let node: unknown = root;
  for (const key of parts.slice(0, -1)) {
    node = child(node, key);
    if (!isContainer(node)) return;
  }
  const key = parts[parts.length - 1];
  if (Array.isArray(node)) {
    if (/^\d+$/.test(key) && Number(key) < node.length) node[Number(key)] = null;
  } else if (isDoc(node)) delete node[key];
}

/** The $v 2 diff of a sub-document: d deletes, u updates in place, i adds at the end, s<field> changes inside. */
function applyObjectDiff(doc: Obj, diff: Obj): Obj {
  const del = obj(diff.d);
  const upd = obj(diff.u);
  const ins = obj(diff.i);
  const subs = new Map<string, Obj>();
  for (const [k, v] of Object.entries(diff)) {
    if (k === 'd' || k === 'u' || k === 'i') continue;
    if (!k.startsWith('s')) throw new Mismatch(`Unknown diff section ${k}`);
    subs.set(k.slice(1), obj(v));
  }
  for (const k of [...Object.keys(del), ...Object.keys(upd), ...subs.keys()]) {
    if (!(k in doc)) throw new Mismatch(`The diff changes ${k}, which the document doesn't have`);
  }
  const out: Obj = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k in del || k in ins) continue;
    if (k in upd) out[k] = clone(upd[k]);
    else if (subs.has(k)) out[k] = applySubDiff(v, subs.get(k)!);
    else out[k] = v;
  }
  for (const [k, v] of Object.entries(ins)) out[k] = clone(v);
  return out;
}

function applySubDiff(value: unknown, diff: Obj): unknown {
  if (diff.a === true) {
    if (!Array.isArray(value)) throw new Mismatch('An array diff on a value that is not an array');
    return applyArrayDiff(value, diff);
  }
  if (!isDoc(value)) throw new Mismatch('A sub-document diff on a value that is not a sub-document');
  return applyObjectDiff(value, diff);
}

/** The $v 2 diff of an array: l the new length, u<index> a new element, s<index> changes inside one; new slots without a value are null. */
function applyArrayDiff(arr: unknown[], diff: Obj): unknown[] {
  const mods = new Map<number, { u: unknown } | { s: Obj }>();
  for (const [k, v] of Object.entries(diff)) {
    if (k === 'a' || k === 'l') continue;
    const m = /^([us])(\d+)$/.exec(k);
    if (!m) throw new Mismatch(`Unknown array diff section ${k}`);
    mods.set(Number(m[2]), m[1] === 'u' ? { u: v } : { s: obj(v) });
  }
  const length = num(diff.l) ?? Math.max(arr.length, ...[...mods.keys()].map((i) => i + 1));
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const mod = mods.get(i);
    if (mod && 's' in mod) {
      if (i >= arr.length) throw new Mismatch(`The diff changes the element ${i}, which the array doesn't have`);
      out.push(applySubDiff(arr[i], mod.s));
    } else if (mod) out.push(clone(mod.u));
    else out.push(i < arr.length ? arr[i] : null);
  }
  return out;
}

/** The document before an update, from the one after it: what the update changed becomes unknown. */
export function revertUpdate(after: Obj, o: Obj): Obj {
  const doc = clone(after);
  if (isPlainObject(o.diff)) {
    revertObjectDiff(doc, o.diff);
    return doc;
  }
  if (Object.keys(o).some((k) => !OPERATOR_KEYS.has(k))) throw new Mismatch(`Unknown update format: ${Object.keys(o).join(', ')}`);
  for (const path of [...Object.keys(obj(o.$set)), ...Object.keys(obj(o.$unset))]) markUnknown(doc, path.split('.'));
  return doc;
}

/** Marks the unknown value as unknown, also the nulls the update may have padded the array with before it. */
function markElement(arr: unknown[], idx: number): void {
  arr[idx] = unknownValue();
  if (idx === arr.length - 1) for (let j = idx - 1; j >= 0 && arr[j] === null; j--) arr[j] = unknownValue();
}

/**
 * Makes the value at a dotted path unknown ($set or $unset of a classic entry: it was anything, or
 * missing). Sub-documents left with unknown values only may have been created by the update: they
 * become unknown as a whole.
 */
function markUnknown(root: Obj, parts: string[]): void {
  const chain: [Obj | unknown[], string][] = [];
  let node: unknown = root;
  for (let n = 0; n < parts.length; n++) {
    const key = parts[n];
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(key)) return;
    } else if (!isDoc(node)) return;
    chain.push([node, key]);
    if (n < parts.length - 1) {
      node = child(node, key);
      // Missing in the document after: the update didn't create it, so the path didn't exist before either.
      if (node === undefined) return;
    }
  }
  const [container, key] = chain[chain.length - 1];
  if (Array.isArray(container)) {
    const idx = Number(key);
    if (idx >= container.length) return;
    markElement(container, idx);
  } else container[key] = unknownValue();
  for (let n = chain.length - 1; n > 0; n--) {
    const [c] = chain[n];
    if (Array.isArray(c) || !Object.values(c).every(isUnknown)) break;
    const [parent, pkey] = chain[n - 1];
    if (Array.isArray(parent)) parent[Number(pkey)] = unknownValue();
    else parent[pkey] = unknownValue();
  }
}

/**
 * Undoes a $v 2 diff in place: the fields it updated, deleted or added become unknown (an added field
 * may also have been there before, moved), the sub-documents and arrays it changed inside are walked.
 */
function revertObjectDiff(doc: Obj, diff: Obj): void {
  for (const section of ['u', 'd', 'i']) for (const k of Object.keys(obj(diff[section]))) doc[k] = unknownValue();
  for (const [k, v] of Object.entries(diff)) {
    if (k === 'd' || k === 'u' || k === 'i') continue;
    if (!k.startsWith('s')) throw new Mismatch(`Unknown diff section ${k}`);
    const field = k.slice(1);
    doc[field] = revertSubDiff(doc[field], obj(v));
  }
}

function revertSubDiff(value: unknown, diff: Obj): unknown {
  if (diff.a === true) return Array.isArray(value) ? revertArrayDiff(value, diff) : unknownValue();
  if (!isDoc(value)) return unknownValue();
  revertObjectDiff(value, diff);
  return value;
}

/** Undoes an array diff in place; a resized array (l) is unknown as a whole: its old length isn't known. */
function revertArrayDiff(arr: unknown[], diff: Obj): unknown {
  if ('l' in diff) return unknownValue();
  for (const [k, v] of Object.entries(diff)) {
    if (k === 'a') continue;
    const m = /^([us])(\d+)$/.exec(k);
    if (!m) throw new Mismatch(`Unknown array diff section ${k}`);
    const idx = Number(m[2]);
    if (idx >= arr.length) continue;
    if (m[1] === 'u') markElement(arr, idx);
    else arr[idx] = revertSubDiff(arr[idx], obj(v));
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Versions

type State = { kind: 'absent' } | { kind: 'doc'; doc: Obj } | { kind: 'unknown' };

export type VersionState = 'exact' | 'partial' | 'absent' | 'unknown';

/** A field difference between two versions; an unknown value on a side is flagged instead of shown. */
export interface VersionDiff extends FieldDiff {
  leftUnknown?: boolean;
  rightUnknown?: boolean;
}

export interface VersionDoc {
  /** exact: every field known; partial: some unknown; absent: no document (not inserted yet, or deleted); unknown: nothing known. */
  state: VersionState;
  /** The document, canonical EJSON; in a partial one the unknown values are { [UNKNOWN_KEY]: true }. */
  doc?: Obj;
  /** Paths of the unknown values of a partial version. */
  unknown?: string[];
}

export interface DocVersion extends VersionDoc {
  op: DocOp;
  kind: DocOpKind;
  /** Fields set and unset by an update. */
  changes?: OpChanges;
  /** Differences from the version before. */
  diff: VersionDiff[];
  /** Why it couldn't be rebuilt from the version before (an update that doesn't fit it). */
  mismatch?: string;
}

export interface DocHistory {
  /** Oldest first: the document after each operation. */
  versions: DocVersion[];
  /** The document before the oldest operation, as far as it is known. */
  before: VersionDoc;
  /**
   * The operations rebuilt forwards don't lead to the document as it is now (writes missing from what
   * was read, or written while reading): those versions come from the current document instead.
   */
  conflict: boolean;
}

/** Paths of the unknown values in a document. */
export function unknownPaths(v: unknown, path = ''): string[] {
  if (isUnknown(v)) return [path || '(document)'];
  if (Array.isArray(v)) return v.flatMap((x, i) => unknownPaths(x, join(path, i)));
  if (isDoc(v)) return Object.entries(v).flatMap(([k, x]) => unknownPaths(x, join(path, k)));
  return [];
}

const hasUnknown = (v: unknown): boolean => (isUnknown(v) ? true : Array.isArray(v) ? v.some(hasUnknown) : isDoc(v) ? Object.values(v).some(hasUnknown) : false);

/** Whether an exact value fits a partial one: equal where known; an unknown value is anything, or missing. */
function agrees(exact: unknown, partial: unknown): boolean {
  if (isUnknown(partial)) return true;
  if (Array.isArray(partial)) {
    if (!Array.isArray(exact)) return false;
    let known = partial.length;
    while (known > 0 && isUnknown(partial[known - 1])) known--;
    return exact.length >= known && exact.length <= partial.length && exact.every((x, i) => agrees(x, partial[i]));
  }
  if (isDoc(partial)) {
    if (!isDoc(exact)) return false;
    for (const [k, v] of Object.entries(partial)) if (k in exact ? !agrees(exact[k], v) : !isUnknown(v)) return false;
    return Object.keys(exact).every((k) => k in partial);
  }
  return JSON.stringify(exact) === JSON.stringify(partial);
}

/** A replacement's document: o, with the _id of o2 when o lacks it. */
const replacement = (op: DocOp): Obj => clone('_id' in op.o || !op.o2 ? op.o : { _id: op.o2._id, ...op.o });

/**
 * The versions of a document from its operations (any order) and the document as it is now (null:
 * deleted). Each version is rebuilt forwards from the last insert or replacement when there is one, and
 * otherwise backwards from the current document, with the values the oplog doesn't tell left unknown.
 */
export function buildHistory(operations: DocOp[], current: Obj | null): DocHistory {
  const ops = [...operations].sort((a, b) => a.t - b.t || a.i - b.i || a.index - b.index);
  const n = ops.length;

  // Forwards: exact from an insert, replacement, delete or drop on; `chain` numbers those stretches.
  const forward: (State & { chain: number })[] = [{ kind: 'unknown', chain: 0 }];
  const mismatches: (string | undefined)[] = [];
  let chain = 0;
  for (const op of ops) {
    const prev = forward[forward.length - 1];
    let next: State & { chain: number };
    switch (opKind(op)) {
      case 'insert':
        next = { kind: 'doc', doc: clone(op.o), chain: ++chain };
        break;
      case 'replace':
        next = { kind: 'doc', doc: replacement(op), chain: ++chain };
        break;
      case 'delete':
      case 'drop':
        next = { kind: 'absent', chain: ++chain };
        break;
      case 'renamed':
        next = { kind: 'unknown', chain: ++chain };
        break;
      case 'update':
        next = { kind: 'unknown', chain: ++chain };
        if (prev.kind === 'doc') {
          try {
            next = { kind: 'doc', doc: applyUpdate(prev.doc, op.o), chain: prev.chain };
          } catch (err) {
            mismatches[forward.length] = err instanceof Error ? err.message : String(err);
          }
        } else if (prev.kind === 'absent') mismatches[forward.length] = 'An update of a document that was deleted';
        break;
    }
    forward.push(next);
  }

  // Backwards from the current document.
  const backward: State[] = new Array<State>(n + 1);
  backward[n] = current ? { kind: 'doc', doc: clone(current) } : { kind: 'absent' };
  for (let k = n; k > 0; k--) {
    const op = ops[k - 1];
    const after = backward[k];
    const kind = opKind(op);
    if (kind === 'insert') backward[k - 1] = { kind: 'absent' };
    else if (kind === 'update' && after.kind === 'doc') {
      try {
        backward[k - 1] = { kind: 'doc', doc: revertUpdate(after.doc, op.o) };
      } catch {
        backward[k - 1] = { kind: 'unknown' };
      }
    } else backward[k - 1] = { kind: 'unknown' };
  }

  // A forward stretch that disagrees with what is known backwards is wrong somewhere: not used.
  const wrong = new Set<number>();
  for (let k = 0; k <= n; k++) {
    const f = forward[k];
    const b = backward[k];
    if (f.kind === 'unknown' || b.kind === 'unknown') continue;
    if (f.kind !== b.kind || (f.kind === 'doc' && b.kind === 'doc' && !agrees(f.doc, b.doc))) wrong.add(f.chain);
  }
  const states: State[] = forward.map((f, k) => (f.kind !== 'unknown' && !wrong.has(f.chain) ? f : backward[k]));

  const view = (s: State): VersionDoc => {
    if (s.kind !== 'doc') return { state: s.kind };
    const unknown = unknownPaths(s.doc);
    return unknown.length ? { state: 'partial', doc: s.doc, unknown } : { state: 'exact', doc: s.doc };
  };
  const versions = ops.map((op, k): DocVersion => {
    const kind = opKind(op);
    const changes = kind === 'update' ? updateChanges(op.o) : undefined;
    return {
      op,
      kind,
      ...(changes && { changes }),
      ...view(states[k + 1]),
      diff: versionDiff(states[k], states[k + 1]),
      ...(mismatches[k + 1] && { mismatch: mismatches[k + 1] }),
    };
  });
  return { versions, before: view(states[0]), conflict: wrong.size > 0 };
}

// ---------------------------------------------------------------------------
// Differences between versions

const DIFF_OPTIONS = { ignore: [], ignoreOrder: true, numbersByValue: false };

/** A value to show (relaxed EJSON), the unknown values as UNKNOWN_TEXT. */
export function displayValue(v: unknown): unknown {
  if (isUnknown(v)) return UNKNOWN_TEXT;
  if (Array.isArray(v)) return v.map(displayValue);
  if (isDoc(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, displayValue(x)]));
  return relaxEjson(v);
}

function row(path: string, a: unknown, b: unknown): VersionDiff {
  const side = (v: unknown, name: 'left' | 'right') => (v === undefined ? {} : isUnknown(v) ? { [`${name}Unknown`]: true } : { [name]: displayValue(v) });
  return { path: path || '(document)', ...side(a, 'left'), ...side(b, 'right') };
}

/** Differences of two values (undefined: missing), field by field; unknown values are compared with nothing. */
function diffValues(a: unknown, b: unknown, path: string, out: VersionDiff[]): void {
  if (a === undefined && b === undefined) return;
  if (isUnknown(a) || isUnknown(b) || a === undefined || b === undefined) {
    if (!(isUnknown(a) && isUnknown(b))) out.push(row(path, a, b));
    return;
  }
  if (!hasUnknown(a) && !hasUnknown(b)) {
    for (const f of fieldDiff(a, b, DIFF_OPTIONS, relaxEjson)) {
      out.push({ ...f, path: f.path === '(document)' ? path || f.path : join(path, f.path) });
    }
    return;
  }
  if (isDoc(a) && isDoc(b)) {
    for (const k of [...Object.keys(a), ...Object.keys(b).filter((k) => !(k in a))]) diffValues(a[k], b[k], join(path, k), out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diffValues(x, b[i], join(path, i), out));
    return;
  }
  out.push(row(path, a, b));
}

/** What changed from one version to the next: fields added, removed, changed, or of unknown value before. */
function versionDiff(before: State, after: State): VersionDiff[] {
  if (after.kind === 'unknown') return [];
  const out: VersionDiff[] = [];
  const next = after.kind === 'doc' ? after.doc : {};
  if (before.kind === 'unknown') {
    for (const [k, v] of Object.entries(next)) if (!isUnknown(v)) out.push({ ...row(k, undefined, v), leftUnknown: true });
    return out;
  }
  diffValues(before.kind === 'doc' ? before.doc : {}, next, '', out);
  return out;
}
