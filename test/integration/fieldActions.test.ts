// The column actions (rename, remove, convert a field) against the standalone mongod.
import { BSON, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { FieldOperation, convertField, removeField, renameField, typeCounts } from '../../src/fieldActions';

const { Decimal128, Int32, Long, ObjectId } = BSON;
const DB = 'mongoster_fields';

let client: MongoClient;
const coll = () => client.db(DB).collection<{ _id?: number; [key: string]: unknown }>('people');

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
});
afterAll(async () => {
  await client?.db(DB).dropDatabase();
  await client?.close();
});
beforeEach(async () => {
  await client.db(DB).dropDatabase();
});

/** Counts, then runs the operation as the panel does. */
async function apply(op: FieldOperation): Promise<{ reached: number; matched: number; modified: number }> {
  const reached = await coll().countDocuments(op.reached);
  const res = await coll().updateMany(op.filter, op.update);
  return { reached, matched: res.matchedCount, modified: res.modifiedCount };
}
const all = () => coll().find({}, { sort: { _id: 1 } }).toArray();

describe('rename field', () => {
  beforeEach(async () => {
    await coll().insertMany([
      { _id: 1, name: 'a', addr: { city: 'Rome', zip: '00100' }, kind: 'x' },
      { _id: 2, name: 'b', addr: [{ city: 'Milan' }], kind: 'x' },
      { _id: 3, other: true, kind: 'x' },
      { _id: 4, name: 'd', addr: { city: 'Turin' }, kind: 'y' },
      { _id: 5, name: 'e', fullName: 'kept?', kind: 'x' },
    ]);
  });

  it('renames a top-level field in the matching documents, and tells which ones it overwrites', async () => {
    const op = renameField({ kind: 'x' }, 'name', 'fullName');
    expect(await coll().countDocuments(op.overwrites)).toBe(1);
    expect(await apply(op)).toEqual({ reached: 3, matched: 3, modified: 3 });
    expect(await all()).toEqual([
      { _id: 1, addr: { city: 'Rome', zip: '00100' }, kind: 'x', fullName: 'a' },
      { _id: 2, addr: [{ city: 'Milan' }], kind: 'x', fullName: 'b' },
      { _id: 3, other: true, kind: 'x' },
      { _id: 4, name: 'd', addr: { city: 'Turin' }, kind: 'y' },
      { _id: 5, kind: 'x', fullName: 'e' },
    ]);
  });

  it('moves a nested field, leaving out documents where its parent is an array', async () => {
    const op = renameField({}, 'addr.city', 'city');
    const r = await apply(op);
    // Document 2 has addr.city inside an array: reached, but left out ($rename would fail on it).
    expect(r).toEqual({ reached: 3, matched: 2, modified: 2 });
    const docs = await all();
    expect(docs[0]).toEqual({ _id: 1, name: 'a', addr: { zip: '00100' }, kind: 'x', city: 'Rome' });
    expect(docs[1]).toEqual({ _id: 2, name: 'b', addr: [{ city: 'Milan' }], kind: 'x' });
    expect(docs[3]).toEqual({ _id: 4, name: 'd', addr: {}, kind: 'y', city: 'Turin' });
  });

  it('fails without the array guard: the guard is what makes it run', async () => {
    const op = renameField({}, 'addr.city', 'city');
    await expect(coll().updateMany(op.reached, op.update)).rejects.toThrow();
  });
});

describe('remove field', () => {
  beforeEach(async () => {
    await coll().insertMany([
      { _id: 1, tmp: 1, meta: { a: 1, b: 2 }, items: [{ sku: 'x', q: 1 }, { sku: 'y', q: 2 }, { q: 3 }] },
      { _id: 2, tmp: null, meta: [{ a: 1 }], items: { sku: 'not-an-array' } },
      { _id: 3, meta: { b: 3 } },
    ]);
  });

  it('removes a top-level field, null values included', async () => {
    expect(await apply(removeField({}, 'tmp'))).toEqual({ reached: 2, matched: 2, modified: 2 });
    expect(await coll().countDocuments({ tmp: { $exists: true } })).toBe(0);
  });

  it('removes a nested field where the parent is a document', async () => {
    expect(await apply(removeField({}, 'meta.a'))).toEqual({ reached: 2, matched: 1, modified: 1 });
    expect((await all()).map((d) => d.meta)).toEqual([{ b: 2 }, [{ a: 1 }], { b: 3 }]);
  });

  it('removes a field of the elements of an array from every element', async () => {
    expect(await apply(removeField({}, 'items.sku', 'items'))).toEqual({ reached: 2, matched: 1, modified: 1 });
    const docs = await all();
    expect(docs[0].items).toEqual([{ q: 1 }, { q: 2 }, { q: 3 }]);
    // Where items isn't an array, $[] would fail: left as it is.
    expect(docs[1].items).toEqual({ sku: 'not-an-array' });
  });
});

describe('convert field', () => {
  beforeEach(async () => {
    await coll().insertMany([
      { _id: 1, v: '42' },
      { _id: 2, v: 7.9 },
      { _id: 3, v: 'not a number' },
      { _id: 4, v: null },
      { _id: 5, v: [1, 2] },
      { _id: 6, v: new Int32(5) },
      { _id: 7, d: '2024-03-15T10:00:00Z', o: '65a1b2c3d4e5f60718293a4b', s: 12 },
      { _id: 8, nested: { n: '3' } },
      { _id: 9, nested: [{ n: '4' }] },
    ]);
  });

  it('converts what it can to int, keeps the rest, and counts what is left', async () => {
    const op = convertField({}, 'v', 'int');
    // Strings, double: three to convert, one of which can't be.
    expect(await apply(op)).toEqual({ reached: 3, matched: 3, modified: 2 });
    const byId = Object.fromEntries((await coll().find({}, { promoteValues: false }).toArray()).map((d) => [String(d._id), d.v]));
    expect(byId['1']).toEqual(new Int32(42));
    expect(byId['2']).toEqual(new Int32(7));
    expect(byId['3']).toBe('not a number');
    expect(byId['4']).toBeNull();
    expect(byId['5']).toEqual([new Int32(1), new Int32(2)]);
    expect(await coll().countDocuments(op.filter)).toBe(1);
    const counts = await coll().aggregate(typeCounts({}, 'v')).toArray();
    // Most frequent first; ties in any order.
    expect(counts[0]).toEqual({ _id: 'int', n: 3 });
    expect(counts.slice(1).sort((x, y) => x._id.localeCompare(y._id))).toEqual([
      { _id: 'array', n: 1 },
      { _id: 'null', n: 1 },
      { _id: 'string', n: 1 },
    ]);
  });

  it('converts to long, decimal, string, date and objectId', async () => {
    await apply(convertField({ _id: 6 }, 'v', 'long'));
    await apply(convertField({ _id: 2 }, 'v', 'decimal'));
    await apply(convertField({}, 's', 'string'));
    await apply(convertField({}, 'd', 'date'));
    await apply(convertField({}, 'o', 'objectId'));
    const docs = Object.fromEntries((await coll().find({}, { promoteValues: false, promoteLongs: false }).toArray()).map((d) => [String(d._id), d]));
    expect(docs['6'].v).toEqual(Long.fromNumber(5));
    expect(docs['2'].v).toBeInstanceOf(Decimal128);
    expect(String(docs['2'].v)).toMatch(/^7\.9/);
    expect(docs['7']).toMatchObject({ s: '12', d: new Date('2024-03-15T10:00:00Z'), o: new ObjectId('65a1b2c3d4e5f60718293a4b') });
  });

  it('converts a nested field, leaving out documents where its parent is an array', async () => {
    expect(await apply(convertField({}, 'nested.n', 'int'))).toEqual({ reached: 2, matched: 1, modified: 1 });
    expect((await coll().findOne({ _id: 8 }))?.nested).toEqual({ n: 3 });
    expect((await coll().findOne({ _id: 9 }))?.nested).toEqual([{ n: '4' }]);
  });
});
