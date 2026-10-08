// Index advisor: from the indexes of the collections (with their use since the server started) and the
// slow operations, the indexes worth creating, the ones another index already serves, and the unused ones.
import { SlowOp, groupOps, splitNs } from './profile';
import { toShell } from './query';

/** An index of a collection, as the advisor needs it. */
export interface AdvisorIndex {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  hidden?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
  collation?: string;
  size?: number;
  /** Uses since `since`, from $indexStats (undefined when the server doesn't report them). */
  ops?: number;
  since?: string;
  building?: boolean;
}

export interface AdvisorCollection {
  database: string;
  collection: string;
  indexes: AdvisorIndex[];
  /** estimatedDocumentCount. */
  documents?: number;
}

/** A query shape behind a suggested index. */
export interface AdvisorQuery {
  kind: string;
  shape: string;
  /** Operations (a cursor's next batches are part of its operation). */
  count: number;
  /** Time of the operations and of their next batches. */
  totalMs: number;
  avgMs: number;
  maxMs: number;
  docsExamined: number;
  nreturned: number;
  collscan: boolean;
  sortStage: boolean;
  /** The slowest operation, to open in the collection's tab. */
  example: SlowOp;
}

export type Advice =
  | {
      kind: 'create';
      id: string;
      database: string;
      collection: string;
      keys: Record<string, 1 | -1>;
      /** Operations and their time, of every query below. */
      count: number;
      totalMs: number;
      queries: AdvisorQuery[];
    }
  | {
      kind: 'redundant';
      id: string;
      database: string;
      collection: string;
      index: AdvisorIndex;
      /** The index that serves the same queries. */
      by: AdvisorIndex;
    }
  | {
      kind: 'unused' | 'hidden';
      id: string;
      database: string;
      collection: string;
      index: AdvisorIndex;
    };

type Dir = 1 | -1;

/** An index is called unused only when its statistics cover at least this long. */
export const UNUSED_AFTER_MS = 24 * 3600 * 1000;

const numeric = (key: Record<string, unknown>) => Object.values(key).every((v) => typeof v === 'number');
const direction = (v: unknown) => (typeof v === 'number' ? (v < 0 ? -1 : 1) : v);

/**
 * Whether the index `key` starts with `prefix`: same fields in the same order, with the same directions,
 * or all reversed (an index is read both ways). Text, geo and hashed parts must be the same.
 */
export function startsWith(key: Record<string, unknown>, prefix: Record<string, unknown>): boolean {
  const a = Object.entries(key);
  const b = Object.entries(prefix);
  if (!b.length || b.length > a.length) return false;
  if (b.some(([k], i) => a[i][0] !== k)) return false;
  const same = b.every(([, v], i) => direction(a[i][1]) === direction(v));
  if (same) return true;
  // Reversed: only for plain ascending / descending keys.
  return numeric(prefix) && numeric(Object.fromEntries(a.slice(0, b.length))) && b.every(([, v], i) => direction(a[i][1]) === -(direction(v) as number));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether `by` serves every query `index` serves, so `index` only costs writes and memory. */
export function redundantWith(index: AdvisorIndex, by: AdvisorIndex): boolean {
  if (index.name === by.name || index.name === '_id_') return false;
  // A unique index enforces a constraint, a TTL index deletes documents: they have a job of their own.
  if (index.unique || index.expireAfterSeconds !== undefined) return false;
  if (index.hidden || by.hidden || index.building || by.building) return false;
  // The other index must hold the same documents in the same order.
  if (!sameJson(index.partialFilterExpression, by.partialFilterExpression)) return false;
  if (by.sparse && !index.sparse) return false;
  if ((index.collation ?? '') !== (by.collation ?? '')) return false;
  if (!startsWith(by.key, index.key)) return false;
  return true;
}

/** Whether an existing index serves the suggested keys. */
function served(indexes: AdvisorIndex[], keys: Record<string, Dir>): AdvisorIndex | undefined {
  return indexes.find((ix) => !ix.hidden && !ix.partialFilterExpression && !ix.sparse && !ix.collation && startsWith(ix.key, keys));
}

const nsOf = (database: string, collection: string) => `${database}.${collection}`;

/**
 * The advice for the collections: the indexes to create for the slow operations (merged when one index
 * serves several queries), the redundant indexes, and those not used (or hidden); `tooRecent`: the indexes
 * not used yet whose statistics started too recently (a new index, a server restart) to tell.
 */
export function analyze(collections: AdvisorCollection[], ops: SlowOp[], now = Date.now()): { advice: Advice[]; tooRecent: number } {
  const byNs = new Map(collections.map((c) => [nsOf(c.database, c.collection), c]));
  const create: Extract<Advice, { kind: 'create' }>[] = [];

  // ---- missing indexes
  const perNs = new Map<string, { keys: Record<string, Dir>; queries: AdvisorQuery[] }[]>();
  for (const g of groupOps(ops)) {
    if (!g.suggestion || !byNs.has(g.ns)) continue;
    const coll = byNs.get(g.ns)!;
    // Queries that an index serves now (created since, or the planner's choice): nothing to suggest.
    if (served(coll.indexes, g.suggestion)) continue;
    const query: AdvisorQuery = {
      kind: g.kind,
      shape: g.shape,
      count: g.count - g.getMores || g.count,
      totalMs: g.totalMs,
      avgMs: g.totalMs / (g.count - g.getMores || g.count),
      maxMs: g.maxMs,
      docsExamined: g.docsExamined,
      nreturned: g.nreturned,
      collscan: g.collscan,
      sortStage: g.sortStage,
      example: g.slowest,
    };
    const list = perNs.get(g.ns) ?? [];
    perNs.set(g.ns, list);
    const same = list.find((s) => sameJson(s.keys, g.suggestion));
    if (same) same.queries.push(query);
    else list.push({ keys: g.suggestion, queries: [query] });
  }
  for (const [ns, list] of perNs) {
    // An index that starts with another suggestion serves its queries too: one index for both.
    const longestFirst = [...list].sort((a, b) => Object.keys(b.keys).length - Object.keys(a.keys).length);
    const kept: typeof list = [];
    for (const s of longestFirst) {
      const by = kept.find((k) => startsWith(k.keys, s.keys));
      if (by) by.queries.push(...s.queries);
      else kept.push({ keys: s.keys, queries: [...s.queries] });
    }
    const { database, collection } = splitNs(ns);
    for (const s of kept) {
      s.queries.sort((a, b) => b.totalMs - a.totalMs);
      create.push({
        kind: 'create',
        id: `create:${ns}:${toShell(s.keys)}`,
        database,
        collection,
        keys: s.keys,
        count: s.queries.reduce((n, q) => n + q.count, 0),
        totalMs: s.queries.reduce((n, q) => n + q.totalMs, 0),
        queries: s.queries,
      });
    }
  }
  create.sort((a, b) => b.totalMs - a.totalMs);

  // ---- redundant, unused, hidden
  const redundant: Advice[] = [];
  const unused: Advice[] = [];
  let tooRecent = 0;
  for (const c of collections) {
    const flagged = new Set<string>();
    // Newest first: of two indexes on the same fields, the newer one is the redundant one.
    for (const ix of [...c.indexes].reverse()) {
      const by = c.indexes.find((other) => redundantWith(ix, other) && !flagged.has(other.name));
      if (by) {
        flagged.add(ix.name);
        redundant.push({ kind: 'redundant', id: `redundant:${nsOf(c.database, c.collection)}:${ix.name}`, database: c.database, collection: c.collection, index: ix, by });
      }
    }
    for (const ix of c.indexes) {
      if (ix.name === '_id_' || flagged.has(ix.name) || ix.building) continue;
      if (ix.hidden) {
        unused.push({ kind: 'hidden', id: `hidden:${nsOf(c.database, c.collection)}:${ix.name}`, database: c.database, collection: c.collection, index: ix });
        continue;
      }
      if (!unusedCandidate(ix)) continue;
      if (!observedLongEnough(ix, now)) {
        tooRecent++;
        continue;
      }
      unused.push({ kind: 'unused', id: `unused:${nsOf(c.database, c.collection)}:${ix.name}`, database: c.database, collection: c.collection, index: ix });
    }
  }
  const bySize = (a: Advice, b: Advice) => ((b as { index?: AdvisorIndex }).index?.size ?? 0) - ((a as { index?: AdvisorIndex }).index?.size ?? 0);
  return { advice: [...create, ...redundant.sort(bySize), ...unused.sort(bySize)], tooRecent };
}

/** Unique and TTL indexes work without being read by queries. */
const unusedCandidate = (ix: AdvisorIndex) => ix.ops === 0 && !ix.unique && ix.expireAfterSeconds === undefined;
const observedLongEnough = (ix: AdvisorIndex, now: number) => !!ix.since && now - new Date(ix.since).getTime() >= UNUSED_AFTER_MS;
