// The relations between the collections of a database, for the relationship diagram, the MCP server and
// the references followed from the collection tabs: a sample of every collection, the reference-looking
// fields checked against the other collections, DBRefs, and views on their source collection; a cache per
// database for the tabs. No vscode dependency.
import { BSON, Db, Document } from 'mongodb';
import type { ConnectionManager } from './connections';
import { Candidate, RefType, RelCollection, RelGraph, Relation, candidates, isReference, refKey, sampleFields } from './shared/relations';

const { EJSON } = BSON;

/** Collections sampled at the same time. */
const PARALLEL = 6;
/** Values looked up in one query. */
const LOOKUP_CHUNK = 1000;
const MAX_TIME_MS = 20_000;
/** Documents sampled per collection when a collection tab needs the references. */
export const BACKGROUND_SAMPLE = 100;

const canonical = (v: unknown) => EJSON.serialize({ v }, { relaxed: false }).v;

export interface RelationsFound extends RelGraph {
  /** Collections whose documents couldn't be read (permissions). */
  unreadable: string[];
}

/** Runs `run` on the items, PARALLEL at a time. */
async function parallel<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

function valueAt(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Samples up to `sample` documents of every collection of `db` and finds the relations between them.
 * Once `cancelled()` turns true the remaining collections aren't read: the result is to be dropped.
 */
export async function analyzeRelations(
  db: Db,
  sample: number,
  progress: (text: string) => void = () => undefined,
  cancelled: () => boolean = () => false,
): Promise<RelationsFound> {
  const database = db.databaseName;
  const infos = (await db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray()).filter((c) => !c.name.startsWith('system.'));
  const collections: RelCollection[] = infos
    .map((c) => ({
      name: c.name,
      view: c.type === 'view' || undefined,
      viewOn: c.type === 'view' ? String((c.options as Document | undefined)?.viewOn ?? '') || undefined : undefined,
      sampled: 0,
      fields: [],
      unique: [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sampled: Parameters<typeof candidates>[0] = [];
  const dbrefs = new Map<string, Map<string, Set<string>>>();
  const unreadable: string[] = [];
  let done = 0;
  const tables = collections.filter((c) => !c.view);
  progress(`Sampling ${tables.length} collection${tables.length === 1 ? '' : 's'}…`);
  await parallel(tables, async (c) => {
    if (cancelled()) return;
    const coll = db.collection(c.name);
    try {
      const [documents, indexes] = await Promise.all([
        coll.estimatedDocumentCount({ maxTimeMS: MAX_TIME_MS }).catch(() => undefined),
        coll.listIndexes().toArray().catch(() => [] as Document[]),
      ]);
      c.documents = documents;
      c.unique = indexes
        .filter((ix) => ix.unique && !ix.partialFilterExpression && Object.keys(ix.key).length === 1 && ix.name !== '_id_')
        .map((ix) => Object.keys(ix.key)[0]);
      const cursor =
        documents !== undefined && documents > sample
          ? coll.aggregate([{ $sample: { size: sample } }], { promoteValues: false, bsonRegExp: true, maxTimeMS: MAX_TIME_MS })
          : coll.find({}, { promoteValues: false, bsonRegExp: true, limit: sample, maxTimeMS: MAX_TIME_MS });
      const docs = (await cursor.toArray()).map((d) => EJSON.serialize(d, { relaxed: false }));
      const found = sampleFields(docs);
      c.sampled = docs.length;
      c.fields = found.fields;
      sampled.push({ name: c.name, fields: found.fields, values: found.values, unique: c.unique });
      if (found.dbrefs.size) dbrefs.set(c.name, found.dbrefs);
    } catch {
      // Not readable (permissions): shown without fields.
      unreadable.push(c.name);
    }
    progress(`Sampled ${++done} of ${tables.length} collections…`);
  });

  const relations = cancelled() ? [] : await references(db, candidates(sampled), progress);
  // DBRefs name their collection.
  for (const [from, paths] of dbrefs) {
    const c = collections.find((x) => x.name === from)!;
    for (const [path, targets] of paths) {
      for (const target of targets) {
        const to = target.startsWith(`${database}.`) ? target.slice(database.length + 1) : target;
        if (!collections.some((x) => x.name === to)) continue;
        const field = c.fields.find((f) => f.path === path)!;
        relations.push({ id: `${from}.${path}→${to}._id`, from, field: path, fieldLabel: field.label, to, toField: '_id', many: field.many, kind: 'dbref', matched: 0, tested: 0 });
      }
    }
  }
  for (const c of collections) {
    if (c.view && c.viewOn && collections.some((x) => x.name === c.viewOn)) {
      relations.push({ id: `${c.name}→${c.viewOn}`, from: c.name, field: '', fieldLabel: '', to: c.viewOn, toField: '', many: false, kind: 'view', matched: 0, tested: 0 });
    }
  }
  return { database, collections, relations, sample, unreadable: unreadable.sort() };
}

/** Looks the candidates' values up: one query per target field, for every candidate pointing to it. */
async function references(db: Db, list: Candidate[], progress: (text: string) => void): Promise<Relation[]> {
  const targets = new Map<string, { to: string; toField: string; values: Map<string, unknown> }>();
  for (const c of list) {
    for (const t of c.targets) {
      const key = `${t.to}\u0000${t.toField}`;
      const entry = targets.get(key) ?? { ...t, values: new Map<string, unknown>() };
      targets.set(key, entry);
      for (const v of c.values) entry.values.set(refKey(v), v);
    }
  }
  if (!targets.size) return [];
  progress(`Checking ${list.length} possible reference${list.length === 1 ? '' : 's'} in ${targets.size} collection${targets.size === 1 ? '' : 's'}…`);
  const found = new Map<string, Set<string>>();
  await parallel([...targets.entries()], async ([key, t]) => {
    const keys = new Set<string>();
    const values = [...t.values.values()].map((v) => EJSON.deserialize({ v } as Document, { relaxed: false }).v);
    try {
      for (let i = 0; i < values.length; i += LOOKUP_CHUNK) {
        const chunk = values.slice(i, i + LOOKUP_CHUNK);
        const docs = await db
          .collection(t.to)
          .find({ [t.toField]: { $in: chunk } }, { projection: { [t.toField]: 1 }, promoteValues: false, maxTimeMS: MAX_TIME_MS })
          .toArray();
        for (const d of docs) keys.add(refKey(canonical(valueAt(d, t.toField))));
      }
    } catch {
      // Not readable: no references found there.
    }
    found.set(key, keys);
  });
  const relations = new Map<string, Relation>();
  for (const c of list) {
    for (const t of c.targets) {
      const keys = found.get(`${t.to}\u0000${t.toField}`) ?? new Set<string>();
      const matched = c.values.filter((v) => keys.has(refKey(v))).length;
      if (!isReference(c.type as RefType, matched, c.values.length)) continue;
      const id = `${c.from}.${c.field.path}→${t.to}.${t.toField}`;
      const prev = relations.get(id);
      if (prev && prev.matched / prev.tested >= matched / c.values.length) continue;
      relations.set(id, { id, from: c.from, field: c.field.path, fieldLabel: c.field.label, to: t.to, toField: t.toField, many: c.field.many, kind: 'reference', matched, tested: c.values.length });
    }
  }
  return [...relations.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Cache per database, for the collection tabs

interface Entry {
  graph?: RelGraph;
  /** Refreshed since it was found: still used while it is found again. */
  stale?: boolean;
  pending?: Promise<RelGraph | undefined>;
}

type UpdateListener = (e: { connectionId: string; database: string; graph: RelGraph }) => void;

const cacheKey = (connectionId: string, database: string) => `${connectionId}\u0000${database}`;
const keyParts = (key: string) => key.split('\u0000') as [string, string];

/**
 * The references of each database, found once (when the first collection tab needs them, in the
 * background) and kept for the session. A refresh of the tree makes them stale: they are still used, and
 * found again when a tab next needs them. The diagram's analysis replaces them.
 */
export class RelationsCache {
  private static readonly entries = new Map<string, Entry>();
  private static readonly listeners = new Set<UpdateListener>();

  /** A database's references were found again: the open tabs of its collections update. */
  static onDidUpdate(listener: UpdateListener): { dispose(): void } {
    RelationsCache.listeners.add(listener);
    return { dispose: () => RelationsCache.listeners.delete(listener) };
  }

  /**
   * The references of the database, analyzing it if they aren't known (undefined when it can't be read).
   * Stale ones are returned at once and found again in the background (onDidUpdate tells).
   */
  static get(connections: Pick<ConnectionManager, 'getClient'>, connectionId: string, database: string): Promise<RelGraph | undefined> {
    const key = cacheKey(connectionId, database);
    const known = RelationsCache.entries.get(key);
    if (known?.graph && !known.stale) return Promise.resolve(known.graph);
    if (known?.pending) return known.graph ? Promise.resolve(known.graph) : known.pending;
    const entry: Entry = { graph: known?.graph, stale: known?.stale };
    const current = () => RelationsCache.entries.get(key) === entry;
    entry.pending = (async () => {
      try {
        const db = (await connections.getClient(connectionId)).db(database);
        const { collections, relations } = await analyzeRelations(db, BACKGROUND_SAMPLE, undefined, () => !current());
        if (!current()) return undefined;
        const graph: RelGraph = { database, collections, relations, sample: BACKGROUND_SAMPLE };
        RelationsCache.store(connectionId, database, graph);
        return graph;
      } catch {
        // Not readable: tried again by the next tab.
        if (current()) {
          if (entry.graph) RelationsCache.entries.set(key, { graph: entry.graph, stale: true });
          else RelationsCache.entries.delete(key);
        }
        return undefined;
      } finally {
        entry.pending = undefined;
      }
    })();
    RelationsCache.entries.set(key, entry);
    return entry.graph ? Promise.resolve(entry.graph) : entry.pending;
  }

  /** The references of the database if they are known, without analyzing it. */
  static peek(connectionId: string, database: string): RelGraph | undefined {
    return RelationsCache.entries.get(cacheKey(connectionId, database))?.graph;
  }

  /** Keeps a database's references (e.g. from the diagram, with a larger sample) and tells the open tabs. */
  static store(connectionId: string, database: string, graph: RelGraph): void {
    RelationsCache.entries.set(cacheKey(connectionId, database), { graph });
    for (const listener of RelationsCache.listeners) listener({ connectionId, database, graph });
  }

  /** Makes stale the references of a database, of a connection's databases, or of all of them. */
  static invalidate(connectionId?: string, database?: string): void {
    for (const [key, entry] of RelationsCache.entries) {
      const [c, d] = keyParts(key);
      // An analysis under way finishes: tabs are waiting for it.
      if ((connectionId === undefined || c === connectionId) && (database === undefined || d === database) && !entry.pending) entry.stale = true;
    }
  }

  /** Forgets the references of the connections `keep` rejects (disconnected or removed ones). */
  static retain(keep: (connectionId: string) => boolean): void {
    for (const key of [...RelationsCache.entries.keys()]) if (!keep(keyParts(key)[0])) RelationsCache.entries.delete(key);
  }
}
