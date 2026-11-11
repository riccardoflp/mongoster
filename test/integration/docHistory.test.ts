// A document's history read from the oplog of the single-node replica set: every kind of write rebuilt
// exactly as the server stored it, the pages of Load older, transactions, and the errors of a
// standalone server and of a view.
import { BSON, Document, Double, Int32, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DocumentOplog, OplogHistoryError } from '../../src/oplogHistory';
import { opKey } from '../../src/shared/docHistory';

const { EJSON } = BSON;
const DB = `mongoster_dochistory_${Date.now().toString(36)}`;
const canonical = (doc: Document | null) => (doc ? EJSON.serialize(doc, { relaxed: false }) : null);

let rs: MongoClient;
let standalone: MongoClient;
beforeAll(async () => {
  [rs, standalone] = await Promise.all([MongoClient.connect(inject('replSetUri')), MongoClient.connect(inject('mongoUri'))]);
  await rs.db(DB).createCollection('orders');
});
afterAll(async () => {
  await rs?.db(DB).dropDatabase().catch(() => undefined);
  await Promise.all([rs?.close(), standalone?.close()]);
});

const READ = { promoteValues: false, bsonRegExp: true } as const;
// Documents of any _id type.
type AnyDoc = { _id?: string | number; [key: string]: unknown };

describe('DocumentOplog', () => {
  it('rebuilds every version exactly as stored, forwards from the insert', async () => {
    const coll = rs.db(DB).collection('orders');
    const id = new ObjectId();
    const snapshots: (Document | null)[] = [];
    const step = async (write: () => Promise<unknown>) => {
      await write();
      snapshots.push(await coll.findOne({ _id: id }, READ));
    };
    await step(() => coll.insertOne({ _id: id, status: 'new', qty: new Int32(1), price: new Double(2.5), items: [{ sku: 'a', n: 1 }], tags: ['x', 'y', 'z'], address: { city: 'Rome', zip: '00100' } }));
    await step(() => coll.updateOne({ _id: id }, { $set: { status: 'paid', 'address.zip': '00184', paidAt: new Date('2024-05-01T10:00:00Z') }, $inc: { qty: 2 } }));
    await step(() => coll.updateOne({ _id: id }, { $push: { items: { sku: 'b', n: 2 } }, $unset: { price: '' } } as Document));
    await step(() => coll.updateOne({ _id: id }, { $pull: { tags: 'y' } } as Document));
    await step(() => coll.updateOne({ _id: id, 'items.sku': 'a' }, { $inc: { 'items.$.n': 5 }, $set: { 'address.geo': { lat: 41.9, lng: 12.5 } } }));
    await step(() => coll.updateOne({ _id: id }, [{ $set: { total: { $multiply: ['$qty', 10] } } }, { $unset: 'address' }]));
    await step(() => coll.replaceOne({ _id: id }, { status: 'archived', note: 'replaced' }));
    await step(() => coll.updateOne({ _id: id }, { $rename: { note: 'comment' } }));
    await step(() => coll.deleteOne({ _id: id }));
    await step(() => coll.insertOne({ _id: id, status: 'again', list: [1, 2, 3, 4] }));
    await step(() => coll.updateOne({ _id: id }, { $set: { 'list.1': 20, 'list.6': 7 } }));
    await step(() => coll.updateOne({ _id: id }, { $pop: { list: 1 } } as Document));
    // Another document's writes are not in the history.
    await coll.insertOne({ _id: new ObjectId(), status: 'other' });

    const reader = new DocumentOplog(rs, DB, 'orders', id);
    await reader.check();
    await reader.readPage();
    expect(reader.complete).toBe(true);
    expect(reader.firstTime).toBeDefined();
    const h = reader.history(await reader.current());
    expect(h.conflict).toBe(false);
    expect(h.versions.map((v) => v.kind)).toEqual(['insert', 'update', 'update', 'update', 'update', 'update', 'replace', 'update', 'delete', 'insert', 'update', 'update']);
    expect(h.versions.map((v) => v.state)).toEqual(['exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'absent', 'exact', 'exact', 'exact']);
    // Each version is the document the server had after that write, types and field order included.
    h.versions.forEach((v, k) => expect(v.doc ?? null, `version ${k} (${v.kind})`).toEqual(canonical(snapshots[k])));
    expect(h.versions[1].changes?.set).toEqual(expect.arrayContaining(['status', 'qty', 'paidAt']));
    expect(h.versions[2].diff.map((d) => d.path)).toEqual(expect.arrayContaining(['price', 'items']));
    expect(h.before.state).toBe('absent');

    // A version put back from its canonical EJSON is the same BSON (Int32, Double and Date kept).
    const second = h.versions[1].doc!;
    await coll.replaceOne({ _id: id }, EJSON.deserialize(second, { relaxed: false }) as Document);
    expect(canonical(await coll.findOne({ _id: id }, READ))).toEqual(canonical(snapshots[1]));
  });

  it('reads a page at a time: the versions before the page are partial until Load older reaches the insert', async () => {
    const coll = rs.db(DB).collection<AnyDoc>('paged');
    await coll.insertOne({ _id: 'p', n: 0, keep: true });
    for (let n = 1; n <= 4; n++) await coll.updateOne({ _id: 'p' }, { $set: { n } });
    const reader = new DocumentOplog(rs, DB, 'paged', 'p', { operations: 2, ms: 8000 });
    await reader.readPage();
    expect(reader.complete).toBe(false);
    let h = reader.history(await reader.current());
    expect(h.versions.map((v) => v.state)).toEqual(['partial', 'exact']);
    expect(h.versions[0].unknown).toEqual(['n']);
    expect(h.versions[0].doc).toMatchObject({ _id: 'p', keep: true });
    const keys = h.versions.map((v) => opKey(v.op));

    await reader.readPage();
    await reader.readPage();
    expect(reader.complete).toBe(true);
    h = reader.history(await reader.current());
    expect(h.versions.map((v) => v.state)).toEqual(['exact', 'exact', 'exact', 'exact', 'exact']);
    expect(h.versions.map((v) => (v.doc?.n as { $numberInt: string }).$numberInt)).toEqual(['0', '1', '2', '3', '4']);
    // The same writes keep their keys.
    expect(h.versions.slice(-2).map((v) => opKey(v.op))).toEqual(keys);
  });

  it('expands transactions and tells who wrote them', async () => {
    const coll = rs.db(DB).collection<AnyDoc>('txn');
    await coll.insertOne({ _id: 7, stock: 10 });
    const session = rs.startSession();
    try {
      await session.withTransaction(async () => {
        await coll.updateOne({ _id: 7 }, { $inc: { stock: -1 } } as Document, { session });
        await coll.insertOne({ _id: 8 }, { session });
        await coll.updateOne({ _id: 7 }, { $set: { reserved: true } }, { session });
      });
    } finally {
      await session.endSession();
    }
    const reader = new DocumentOplog(rs, DB, 'txn', 7);
    await reader.readPage();
    const h = reader.history(await reader.current());
    expect(h.versions.map((v) => v.kind)).toEqual(['insert', 'update', 'update']);
    expect(h.versions.map((v) => v.state)).toEqual(['exact', 'exact', 'exact']);
    const [, first, second] = h.versions;
    expect(first.op.group).toBe('transaction');
    expect(first.op.lsid).toMatch(/^UUID\("/);
    expect(first.op.txnNumber).toBeDefined();
    expect(second.op.t).toBe(first.op.t);
    expect(second.op.index).toBeGreaterThan(first.op.index);
    expect(h.versions[2].doc).toEqual({ _id: { $numberInt: '7' }, stock: { $numberInt: '9' }, reserved: true });
  });

  it('marks the versions after a drop as no document', async () => {
    const coll = rs.db(DB).collection<AnyDoc>('dropped');
    await coll.insertOne({ _id: 1, v: 1 });
    await coll.drop();
    await coll.insertOne({ _id: 1, v: 2 });
    const reader = new DocumentOplog(rs, DB, 'dropped', 1);
    await reader.readPage();
    const h = reader.history(await reader.current());
    expect(h.versions.map((v) => [v.kind, v.state])).toEqual([
      ['insert', 'exact'],
      ['drop', 'absent'],
      ['insert', 'exact'],
    ]);
    expect(h.versions[1].op.command).toBe('collection dropped');
  });

  it('says why there is no history: a standalone server, a view', async () => {
    const err = await new DocumentOplog(standalone, DB, 'orders', 1).check().catch((e) => e);
    expect(err).toBeInstanceOf(OplogHistoryError);
    expect(err.kind).toBe('standalone');
    expect(err.message).toMatch(/needs a replica set/);

    await rs.db(DB).createCollection('orders_view', { viewOn: 'orders', pipeline: [] });
    const view = await new DocumentOplog(rs, DB, 'orders_view', 1).check().catch((e) => e);
    expect(view.kind).toBe('view');
  });
});
