// The playground's writes when the connection publishes to redis-oplog: the same methods as the
// collection's, which also tell the sink which documents they changed. A write of one document
// (updateOne, replaceOne, deleteOne, findOneAnd…) first finds the _id of the document it changes and then
// runs only on it, as redis-oplog does; a write of many finds their _ids before running. bulkWrite compares
// the documents it may touch before and after.
import { Collection, Document, MongoBulkWriteError } from 'mongodb';
import type { OplogSink } from '../redisOplog';
import { documentFields } from '../shared/oplog';

const BATCH = 1000;

/** The filter restricted to the document with `id`. */
function only(filter: Document, id: unknown): Document {
  return '_id' in filter ? { $and: [filter, { _id: id }] } : { ...filter, _id: id };
}

async function idsOf(coll: Collection, filter: Document): Promise<unknown[]> {
  return (await coll.find(filter, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
}

async function docsOf(coll: Collection, ids: unknown[]): Promise<Document[]> {
  const out: Document[] = [];
  for (let i = 0; i < ids.length; i += BATCH) out.push(...(await coll.find({ _id: { $in: ids.slice(i, i + BATCH) } } as Document).toArray()));
  return out;
}

/** Which operations of a failed bulk write ran: all but the failed ones, and an ordered write stops at the first. */
function ranOf(err: unknown, total: number, ordered: boolean): ((i: number) => boolean) | undefined {
  if (!(err instanceof MongoBulkWriteError)) return undefined;
  const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
  const failed = new Set(errors.map((e) => e.index));
  const stop = ordered ? Math.min(total, ...failed) : total;
  return (i) => i < stop && !failed.has(i);
}

export function publishedWrites(coll: Collection, sink: OplogSink) {
  /** The value of a findOneAnd… result, also with includeResultMetadata. */
  const valueOf = (res: unknown, o: Document) => (o.includeResultMetadata ? (res as { value?: Document | null } | null)?.value : (res as Document | null));
  /** A findOneAnd… that matched nothing and upserted: the new document is the one now matching. */
  const upserted = async (filter: Document, value: Document | null | undefined) => {
    const id = value?._id ?? (await coll.findOne(filter, { projection: { _id: 1 } }))?._id;
    sink.inserted([id]);
  };
  const sortOf = (o?: Document) => (o?.sort ? { sort: o.sort } : {});

  const insertOne = async (doc: Document, o?: Document) => {
    const res = await coll.insertOne(doc, o);
    sink.inserted([res.insertedId]);
    return res;
  };
  const insertMany = async (docs: Document[], o?: Document) => {
    try {
      const res = await coll.insertMany(docs, o);
      sink.inserted(Object.values(res.insertedIds));
      return res;
    } catch (err) {
      // The driver gave the documents their _id.
      const ran = ranOf(err, docs.length, o?.ordered !== false);
      if (ran) sink.inserted(docs.filter((_, i) => ran(i)).map((d) => d._id));
      throw err;
    }
  };

  return {
    insertOne,
    insertMany,
    async updateOne(f: Document, u: Document, o?: Document) {
      const doc = await coll.findOne(f, { projection: { _id: 1 }, ...sortOf(o) });
      const res = await coll.updateOne(doc ? only(f, doc._id) : f, u, o);
      if (res.upsertedId != null) sink.inserted([res.upsertedId]);
      else if (doc && res.modifiedCount) await sink.updatedBy(coll, [doc._id], u);
      return res;
    },
    async updateMany(f: Document, u: Document, o?: Document) {
      const ids = await idsOf(coll, f);
      const res = await coll.updateMany(f, u, o);
      if (res.upsertedId != null) sink.inserted([res.upsertedId]);
      if (res.modifiedCount) await sink.updatedBy(coll, ids, u);
      return res;
    },
    async replaceOne(f: Document, r: Document, o?: Document) {
      const doc = await coll.findOne(f, sortOf(o));
      const res = await coll.replaceOne(doc ? only(f, doc._id) : f, r, o);
      if (res.upsertedId != null) sink.inserted([res.upsertedId]);
      else if (doc && res.modifiedCount) sink.updated([doc._id], documentFields(doc, r));
      return res;
    },
    async deleteOne(f: Document, o?: Document) {
      const doc = await coll.findOne(f, { projection: { _id: 1 } });
      const res = await coll.deleteOne(doc ? only(f, doc._id) : f, o);
      if (doc && res.deletedCount) sink.removed([doc._id]);
      return res;
    },
    async deleteMany(f: Document, o?: Document) {
      const ids = await idsOf(coll, f);
      const res = await coll.deleteMany(f, o);
      await sink.removedOf(coll, ids, res.deletedCount);
      return res;
    },
    async findOneAndUpdate(f: Document, u: Document, o: Document) {
      const doc = await coll.findOne(f, { projection: { _id: 1 }, ...sortOf(o) });
      const res = await coll.findOneAndUpdate(doc ? only(f, doc._id) : f, u, o);
      const value = valueOf(res, o);
      if (doc) {
        if (value) await sink.updatedBy(coll, [doc._id], u);
      } else if (o.upsert) await upserted(f, value);
      return res;
    },
    async findOneAndReplace(f: Document, r: Document, o: Document) {
      const doc = await coll.findOne(f, sortOf(o));
      const res = await coll.findOneAndReplace(doc ? only(f, doc._id) : f, r, o);
      const value = valueOf(res, o);
      if (doc) {
        if (value) sink.updated([doc._id], documentFields(doc, r));
      } else if (o.upsert) await upserted(f, value);
      return res;
    },
    async findOneAndDelete(f: Document, o: Document) {
      const doc = await coll.findOne(f, { projection: { _id: 1 }, ...sortOf(o) });
      if (!doc) return coll.findOneAndDelete(f, o);
      const res = await coll.findOneAndDelete(only(f, doc._id), o);
      if (valueOf(res, o)) sink.removed([doc._id]);
      return res;
    },
    async bulkWrite(ops: Document[], o?: Document) {
      // The documents the operations may change, found before they run (inserts: those with an _id).
      const ids: unknown[] = [];
      const insertedId = (op: Document) => (op?.insertOne as { document?: Document } | undefined)?.document?._id;
      for (const op of ops) {
        const [kind, body] = (Object.entries(op ?? {})[0] ?? []) as [string, Document | undefined];
        const filter = (body?.filter ?? {}) as Document;
        if (kind === 'insertOne') ids.push(insertedId(op));
        else if (kind === 'updateOne' || kind === 'replaceOne' || kind === 'deleteOne') ids.push((await coll.findOne(filter, { projection: { _id: 1 } }))?._id);
        else if (kind === 'updateMany' || kind === 'deleteMany') ids.push(...(await idsOf(coll, filter)));
      }
      const known = ids.filter((id) => id !== undefined && id !== null);
      const before = await docsOf(coll, known);
      let res: Awaited<ReturnType<Collection['bulkWrite']>> | undefined;
      let error: unknown;
      try {
        res = await coll.bulkWrite(ops as never, o);
      } catch (err) {
        error = err;
      }
      const upsertedIds = res?.upsertedIds ?? (error instanceof MongoBulkWriteError ? error.result?.upsertedIds : undefined) ?? {};
      const touched = [...known, ...ops.map(insertedId), ...Object.values(upsertedIds)].filter((id) => id !== undefined && id !== null);
      sink.changes(before, await docsOf(coll, touched));
      if (error) throw error;
      return res;
    },
  };
}
