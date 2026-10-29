import { BSON, Document, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PlaygroundError, RESULT_LIMIT, RunOptions, runPlayground } from '../../src/playground/shell';
import { OplogSink } from '../../src/redisOplog';
import type { OplogEvent } from '../../src/shared/oplog';

const { Long, Decimal128, Int32, ObjectId } = BSON;
const DB = 'mongoster_shell';

let client: MongoClient;
/** A collection whose _id can be of any type. */
const coll = (name: string) => client.db(DB).collection<{ _id?: string | number | BSON.ObjectId; [key: string]: unknown }>(name);
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

function run(source: string, opts: Partial<RunOptions> = {}) {
  const printed: string[] = [];
  const result = runPlayground(source, { client, database: DB, readOnly: false, print: (l) => printed.push(l), ...opts });
  return result.then((r) => ({ ...r, printed }));
}

describe('playground runtime', () => {
  it('runs mongosh-style code without await and returns the documents of a cursor', async () => {
    const r = await run(`
      db.people.insertMany([{ _id: 1, name: "ada", age: 36 }, { _id: 2, name: "alan", age: 41 }, { _id: 3, name: "grace", age: 85 }]);
      const n = db.people.countDocuments({ age: { $gt: 40 } });
      print("older than 40:", n);
      db.people.find({ age: { $gt: 40 } }, { name: 1 }).sort({ age: -1 }).limit(5)
    `);
    expect(r.kind).toBe('documents');
    expect(r.value).toEqual([{ _id: 3, name: 'grace' }, { _id: 2, name: 'alan' }]);
    expect(r.more).toBe(false);
    expect(r.printed).toEqual(['older than 40: 2']);
  });

  it(`stops a cursor at ${RESULT_LIMIT} documents and says there were more`, async () => {
    await coll('many').insertMany(Array.from({ length: RESULT_LIMIT + 5 }, (_, i) => ({ i })));
    const r = await run('db.many.find().sort({ i: 1 })');
    expect((r.value as unknown[]).length).toBe(RESULT_LIMIT);
    expect(r.more).toBe(true);
    const all = await run('db.many.find().toArray().length');
    expect(all).toMatchObject({ kind: 'value', value: RESULT_LIMIT + 5 });
  });

  it('awaits every call where it is, as mongosh does', async () => {
    await coll('stock').insertMany([
      { _id: 1, n: 5, items: [{ sku: 'a1' }, { sku: 'a2' }] },
      { _id: 2, n: 7, items: [] },
    ]);
    const r = await run(`
      const n = db.stock.findOne({ _id: 1 }).n;
      print(db.stock.countDocuments({}));
      print(\`skus: \${db.stock.findOne({ _id: 1 }).items.map((i) => i.sku).join(",")}\`);
      let found = "none";
      if (db.stock.findOne({ n: 7 })) found = "seven";
      if (db.stock.findOne({ n: 99 })) found = "ninety-nine";
      let total = 0;
      for (const d of db.stock.find().sort({ _id: 1 }).toArray()) total += d.n;
      ({
        n,
        length: db.stock.find().toArray().length,
        sku: db.stock.findOne({}).items[0].sku,
        counts: [db.stock.countDocuments({ n: 5 }), db.stock.countDocuments({ n: { $gt: 5 } })],
        found,
        total,
        missing: db.stock.findOne({ _id: 3 })?.n,
      })
    `);
    expect(r.value).toEqual({ n: 5, length: 2, sku: 'a1', counts: [1, 1], found: 'seven', total: 12, missing: null });
    expect(r.printed).toEqual(['2', 'skus: a1,a2']);
  });

  it('awaits in the blocks of if, for, while and try at the top level', async () => {
    await coll('c').insertMany([{ _id: 1 }, { _id: 2 }]);
    const r = await run(`
      if (db.c.countDocuments() === 2) {
        db.c.insertOne({ _id: 3 });
      }
      for (let i = 4; i < 6; i++) db.c.insertOne({ _id: i });
      while (db.c.countDocuments() < 7) db.c.insertOne({ _id: db.c.countDocuments() + 1 });
      try {
        db.c.insertOne({ _id: 1 });
      } catch (e) {
        print("duplicate:", db.c.findOne({ _id: 1 })._id);
      }
      db.c.countDocuments()
    `);
    expect(r.value).toBe(7);
    expect(r.printed).toEqual(['duplicate: 1']);
  });

  it('keeps cursors lazy: chained, kept in a variable, iterated, explained', async () => {
    await coll('c').insertMany([{ n: 3 }, { n: 1 }, { n: 2 }]);
    const r = await run(`
      const cur = db.c.find({}, { _id: 0 }).sort({ n: 1 });
      cur.forEach((d) => print(d.n));
      print(db.c.find().count(), db.c.find().sort({ n: -1 }).limit(1).toArray()[0].n);
      print(db.c.find({ n: 1 }).explain().queryPlanner.namespace);
      db.c.find({}, { _id: 0 }).sort({ n: -1 }).limit(2)
    `);
    expect(r.printed).toEqual(['1', '2', '3', '3 3', `${DB}.c`]);
    expect(r).toMatchObject({ kind: 'documents', value: [{ n: 3 }, { n: 2 }], more: false });
  });

  it('stores the BSON helpers as their exact types and returns them as relaxed EJSON', async () => {
    const r = await run(`
      db.types.insertOne({
        _id: ObjectId("64b7f0c2a1b2c3d4e5f60718"),
        long: NumberLong("9223372036854775807"),
        small: NumberLong(5),
        int: NumberInt(7),
        dec: NumberDecimal("0.1"),
        when: ISODate("2024-02-29T12:00:00Z"),
        uuid: UUID("0123456789abcdef0123456789abcdef"),
      });
      db.types.findOne()
    `);
    const stored = await client.db(DB).collection('types').findOne({}, { promoteValues: false });
    expect(stored!.long).toBeInstanceOf(Long);
    expect(stored!.long.toString()).toBe('9223372036854775807');
    expect(stored!.int).toBeInstanceOf(Int32);
    expect(stored!.dec).toBeInstanceOf(Decimal128);
    expect(stored!.when).toEqual(new Date('2024-02-29T12:00:00Z'));
    // One document is a value; documents are an array of them.
    expect(r.kind).toBe('value');
    expect(r.value).toEqual({
      _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' },
      long: { $numberLong: '9223372036854775807' },
      small: 5,
      int: 7,
      dec: { $numberDecimal: '0.1' },
      when: { $date: '2024-02-29T12:00:00.000Z' },
      uuid: { $binary: { base64: 'ASNFZ4mrze8BI0VniavN7w==', subType: '04' } },
    });
  });

  it('switches database with use() and reports the database it ends in', async () => {
    const r = await run(`use("${DB}_other");\ndb.getName()`);
    expect(r).toMatchObject({ value: `${DB}_other`, kind: 'value', database: `${DB}_other` });
    const sibling = await run(`db.getSiblingDB("${DB}_other").getName()`);
    expect(sibling).toMatchObject({ value: `${DB}_other`, database: DB });
  });

  it('reaches dotted collection names and aggregates with stages as separate arguments', async () => {
    await coll('logs.archive').insertMany([{ k: 'a' }, { k: 'b' }, { k: 'a' }]);
    const r = await run('db.logs.archive.aggregate({ $group: { _id: "$k", n: { $sum: 1 } } }, { $sort: { _id: 1 } })');
    expect(r.value).toEqual([{ _id: 'a', n: 2 }, { _id: 'b', n: 1 }]);
    expect((await run('db.logs.archive.getFullName()')).value).toBe(`${DB}.logs.archive`);
  });

  it('applies cursor.map() and returns plain values as "value"', async () => {
    await coll('c').insertMany([{ n: 1 }, { n: 2 }]);
    expect(await run('db.c.find().sort({ n: 1 }).map(d => d.n * 10).toArray()')).toMatchObject({ value: [10, 20], kind: 'value' });
    expect(await run('const x = 1;')).toMatchObject({ value: undefined, kind: 'none' });
  });

  it('refuses every write on a read-only connection, and allows reads', async () => {
    await coll('c').insertOne({ n: 1 });
    const ro = { readOnly: true };
    await expect(run('db.c.insertOne({ n: 2 })', ro)).rejects.toThrow('insertOne() is not allowed: the connection is read-only.');
    await expect(run('db.c.drop()', ro)).rejects.toThrow(/drop\(\) is not allowed/);
    await expect(run('db.c.aggregate([{ $match: {} }, { $out: "copy" }])', ro)).rejects.toThrow(/A pipeline with \$out is not allowed/);
    await expect(run('db.runCommand({ drop: "c" })', ro)).rejects.toThrow(/The command drop is not allowed/);
    await expect(run('db.runCommand({ aggregate: "c", pipeline: [{ $merge: "x" }], cursor: {} })', ro)).rejects.toThrow(/\$merge/);
    await expect(run('db.dropDatabase()', ro)).rejects.toThrow(/not allowed/);
    expect(await run('db.c.countDocuments()', ro)).toMatchObject({ value: 1 });
    expect(await run('const res = db.runCommand({ ping: 1 });\nres.ok', ro)).toMatchObject({ value: 1 });
    expect(await coll('c').countDocuments()).toBe(1);
  });

  it('gives syntax and runtime errors with the script’s line', async () => {
    const syntax = await run('db.c.find(\n{ a: }').catch((e) => e);
    expect(syntax).toBeInstanceOf(PlaygroundError);
    expect(syntax).toMatchObject({ line: 2 });
    expect(syntax.message).toMatch(/^SyntaxError: /);
    const runtime = await run('const a = 1;\nundefinedThing.x').catch((e) => e);
    expect(runtime).toBeInstanceOf(PlaygroundError);
    expect(runtime).toMatchObject({ line: 2, message: 'ReferenceError: undefinedThing is not defined' });
    const server = await run('db.c.insertOne({ _id: 1 });\ndb.c.insertOne({ _id: 1 })').catch((e) => e);
    expect(server.message).toMatch(/E11000 duplicate key/);
  });
});

describe('playground writes published for redis-oplog', () => {
  const COLL = 'pub';
  let events: OplogEvent[];
  const oplog = (database: string, collection: string) =>
    new OplogSink({ enqueue: (_target: unknown, e: OplogEvent[]) => events.push(...e) } as never, { connectionId: 'test', database, collection } as never);
  const runPublished = (source: string) => run(source, { oplog });
  /** The events with their ids as relaxed EJSON. */
  const published = () => events.map((e) => ({ ...e, id: BSON.EJSON.serialize({ id: e.id }).id }));

  beforeEach(async () => {
    events = [];
    await coll(COLL).insertMany([
      { _id: 1, name: 'a', n: 1, tags: ['x'] },
      { _id: 2, name: 'b', n: 2 },
      { _id: 3, name: 'c', n: 3 },
    ]);
  });

  it('announces inserted documents, with the _id the driver gave them', async () => {
    await runPublished(`db.${COLL}.insertOne({ _id: 10 }); db.${COLL}.insertMany([{ _id: 11 }, { _id: 12 }])`);
    expect(published()).toEqual([{ e: 'i', id: 10 }, { e: 'i', id: 11 }, { e: 'i', id: 12 }]);
    events = [];
    await runPublished(`db.${COLL}.insertOne({ x: 1 })`);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBeInstanceOf(ObjectId);
  });

  it('announces the inserts that ran when an ordered insertMany fails', async () => {
    await expect(runPublished(`db.${COLL}.insertMany([{ _id: 20 }, { _id: 1 }, { _id: 21 }])`)).rejects.toThrow(/E11000/);
    expect(published()).toEqual([{ e: 'i', id: 20 }]);
  });

  it('runs updateOne only on the document it found, and announces the fields of the update', async () => {
    await runPublished(`db.${COLL}.updateOne({ n: { $gte: 2 } }, { $set: { "name": "B", "tags.0": "y" }, $inc: { n: 1 } }, { sort: { n: -1 } })`);
    expect(published()).toEqual([{ e: 'u', id: 3, fields: ['name', 'tags', 'n'] }]);
    expect(await coll(COLL).findOne({ _id: 3 })).toMatchObject({ name: 'B', n: 4 });
  });

  it('announces nothing for an update that changes nothing, and an insert for an upsert', async () => {
    await runPublished(`db.${COLL}.updateOne({ _id: 1 }, { $set: { name: "a" } })`);
    expect(events).toEqual([]);
    await runPublished(`db.${COLL}.updateOne({ _id: 99 }, { $set: { name: "z" } }, { upsert: true })`);
    expect(published()).toEqual([{ e: 'i', id: 99 }]);
  });

  it('announces updateMany and deleteMany for each document they matched', async () => {
    await runPublished(`db.${COLL}.updateMany({ n: { $lt: 3 } }, [{ $set: { big: { $gt: ["$n", 1] } } }])`);
    expect(published()).toEqual([{ e: 'u', id: 1, fields: ['big'] }, { e: 'u', id: 2, fields: ['big'] }]);
    events = [];
    await runPublished(`db.${COLL}.deleteMany({ n: { $gte: 2 } })`);
    expect(published()).toEqual([{ e: 'r', id: 2 }, { e: 'r', id: 3 }]);
  });

  it('announces the fields a replacement changes, added or removed', async () => {
    await runPublished(`db.${COLL}.replaceOne({ _id: 1 }, { name: "a", other: true })`);
    expect(published()).toEqual([{ e: 'u', id: 1, fields: expect.arrayContaining(['name', 'n', 'tags', 'other']) }]);
  });

  it('announces findOneAndUpdate, findOneAndDelete and an upserting findOneAndReplace', async () => {
    await runPublished(`db.${COLL}.findOneAndUpdate({ name: "b" }, { $unset: { n: "" } })`);
    await runPublished(`db.${COLL}.findOneAndDelete({ _id: 3 })`);
    await runPublished(`db.${COLL}.findOneAndReplace({ _id: 50 }, { name: "new" }, { upsert: true })`);
    expect(published()).toEqual([{ e: 'u', id: 2, fields: ['n'] }, { e: 'r', id: 3 }, { e: 'i', id: 50 }]);
  });

  it('compares the documents before and after a bulkWrite', async () => {
    await runPublished(`db.${COLL}.bulkWrite([
      { insertOne: { document: { _id: 30 } } },
      { updateOne: { filter: { _id: 1 }, update: { $set: { n: 100 } } } },
      { updateOne: { filter: { _id: 2 }, update: { $set: { n: 2 } } } },
      { deleteOne: { filter: { _id: 3 } } },
      { updateOne: { filter: { _id: 40 }, update: { $set: { n: 0 } }, upsert: true } },
    ])`);
    const byId = Object.fromEntries(published().map((e) => [String(e.id), e]));
    expect(byId).toEqual({
      '30': { e: 'i', id: 30 },
      '1': { e: 'u', id: 1, fields: ['n'] },
      '3': { e: 'r', id: 3 },
      '40': { e: 'i', id: 40 },
    });
  });

  it('publishes nothing without a sink', async () => {
    await run(`db.${COLL}.insertOne({ _id: 60 })`, { oplog: () => undefined });
    expect(events).toEqual([]);
    const doc: Document | null = await coll(COLL).findOne({ _id: 60 });
    expect(doc).not.toBeNull();
  });
});
