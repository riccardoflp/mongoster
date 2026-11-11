// The relations between the collections of a database, for the relationship diagram and the MCP server:
// a sample of every collection, the reference-looking fields checked against the other collections,
// DBRefs, and views on their source collection. No vscode dependency.
import { BSON, Db, Document } from 'mongodb';
import { Candidate, RefType, RelCollection, RelGraph, Relation, candidates, isReference, refKey, sampleFields } from './shared/relations';

const { EJSON } = BSON;

/** Collections sampled at the same time. */
const PARALLEL = 6;
/** Values looked up in one query. */
const LOOKUP_CHUNK = 1000;
const MAX_TIME_MS = 20_000;

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

/** Samples up to `sample` documents of every collection of `db` and finds the relations between them. */
export async function analyzeRelations(db: Db, sample: number, progress: (text: string) => void = () => undefined): Promise<RelationsFound> {
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

  const relations = await references(db, candidates(sampled), progress);
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
