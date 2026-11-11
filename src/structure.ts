// Reading the structure of a database (collections, views, options, indexes, search indexes, shard
// keys) for Compare Structure, and running the steps that change it. The comparison itself and the
// script are in shared/structure.ts.
import type { Document, MongoClient } from 'mongodb';
import { relaxed } from './documentFs';
import { fromRelaxed } from './queries';
import { loadSearchIndexes } from './searchIndexes';
import { isPlainObject } from './shared/query';
import { CollectionShape, CollectionType, DatabaseShape, ShardKeyShape, StructureOp, indexShape, normalizeOptions, searchIndexShape } from './shared/structure';

/** Collections read at the same time. */
const PARALLEL = 8;

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

/** The structure of a database; `progress` is told each collection read. */
export async function readStructure(client: MongoClient, database: string, progress?: (done: number, total: number) => void): Promise<DatabaseShape> {
  const db = client.db(database);
  const infos = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c) => !c.name.startsWith('system.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const shardKeys = await readShardKeys(client, database);
  let done = 0;
  const collections = await inBatches(infos, async (info): Promise<CollectionShape> => {
    const type: CollectionType = info.type === 'view' ? 'view' : info.type === 'timeseries' ? 'timeseries' : 'collection';
    const options = normalizeOptions(type, (relaxed(info.options ?? {}) as Record<string, unknown>) ?? {});
    const indexes =
      type === 'view'
        ? []
        : (await db.collection(info.name).listIndexes().toArray())
            .map((ix) => indexShape(relaxed(ix) as Record<string, unknown>))
            .filter((ix): ix is NonNullable<typeof ix> => !!ix)
            .sort((a, b) => a.name.localeCompare(b.name));
    progress?.(++done, infos.length);
    return { name: info.name, type, options, indexes, ...(shardKeys?.has(info.name) && { shardKey: shardKeys.get(info.name) }) };
  });

  // Search indexes: only on collections. The first answer tells whether the server has search at all.
  const shape: DatabaseShape = { collections, search: 'ok', sharded: !!shardKeys };
  const searchable = collections.filter((c) => c.type === 'collection');
  for (const c of searchable) {
    const res = await loadSearchIndexes(db.collection(c.name));
    if (res.unsupported !== undefined) return { ...shape, search: 'unsupported', collections: withoutSearch(collections) };
    if (res.error !== undefined) return { ...shape, search: 'error', searchError: res.error, collections: withoutSearch(collections) };
    c.searchIndexes = res.indexes.map(searchIndexShape).sort((a, b) => a.name.localeCompare(b.name));
  }
  return shape;
}

const withoutSearch = (collections: CollectionShape[]) => collections.map(({ searchIndexes: _s, ...c }) => c);

/** Shard keys of the database's collections by name; undefined when the server isn't a mongos. */
async function readShardKeys(client: MongoClient, database: string): Promise<Map<string, ShardKeyShape> | undefined> {
  try {
    const hello = await client.db('admin').command({ hello: 1 });
    if (hello.msg !== 'isdbgrid') return undefined;
  } catch {
    return undefined;
  }
  const keys = new Map<string, ShardKeyShape>();
  try {
    const prefix = `${database}.`;
    const filter: Document = { _id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }, dropped: { $ne: true } };
    const docs = await client.db('config').collection('collections').find(filter).toArray();
    for (const d of docs) {
      const key = relaxed(d.key);
      if (!isPlainObject(key)) continue;
      keys.set(String(d._id).slice(prefix.length), { key, ...(d.unique === true && { unique: true }) });
    }
  } catch {
    // Without access to the config database, the shard keys are unknown: none are compared.
  }
  return keys;
}

/** Runs a step on the database. */
export async function applyOp(client: MongoClient, database: string, op: StructureOp): Promise<void> {
  const db = client.db(database);
  const bson = (v: unknown) => fromRelaxed(v) as Document;
  switch (op.type) {
    case 'createCollection':
      await db.createCollection(op.collection, bson(op.options));
      return;
    case 'collMod':
      await db.command({ collMod: op.collection, ...bson(op.changes) });
      return;
    case 'convertToCapped':
      await db.command({ convertToCapped: op.collection, size: op.size });
      return;
    case 'drop':
      await db.collection(op.collection).drop();
      return;
    case 'createIndex':
      await db.collection(op.collection).createIndex(bson(op.keys), bson(op.options));
      return;
    case 'dropIndex':
      await db.collection(op.collection).dropIndex(op.name);
      return;
    case 'createSearchIndex':
      await db.collection(op.collection).createSearchIndex({ name: op.name, type: op.searchType, definition: bson(op.definition) });
      return;
    case 'updateSearchIndex':
      await db.collection(op.collection).updateSearchIndex(op.name, bson(op.definition));
      return;
    case 'dropSearchIndex':
      await db.collection(op.collection).dropSearchIndex(op.name);
      return;
    case 'shardCollection':
      await client.db('admin').command({ shardCollection: `${database}.${op.collection}`, key: bson(op.key), ...(op.unique && { unique: true }) });
      return;
  }
}
