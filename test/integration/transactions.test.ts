// Playground sessions and transactions, against the single-node replica set of mongod.ts.
import { BSON, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { RunOptions, runPlayground } from '../../src/playground/shell';
import { OplogSink } from '../../src/redisOplog';
import type { OplogEvent } from '../../src/shared/oplog';

const DB = 'mongoster_tx';

let client: MongoClient;
const coll = (name: string) => client.db(DB).collection<{ _id?: string | number; [key: string]: unknown }>(name);

beforeAll(async () => {
  client = await MongoClient.connect(inject('replSetUri'));
});
afterAll(async () => {
  await client?.db(DB).dropDatabase();
  await client?.close();
});

let events: OplogEvent[];
/** What print() wrote, each line with the number of events published when it was printed. */
let printed: string[];

/** The same fake queue as shell.test.ts: the events published, in order. */
const oplog = (database: string, collection: string) =>
  new OplogSink({ enqueue: (_target: unknown, e: OplogEvent[]) => events.push(...e) } as never, { connectionId: 'test', database, collection } as never);
const published = () => events.map((e) => ({ ...e, id: BSON.EJSON.serialize({ id: e.id }).id }));

function run(source: string, opts: Partial<RunOptions> = {}) {
  return runPlayground(source, { client, database: DB, readOnly: false, oplog, print: (l) => printed.push(`${l} [${events.length}]`), ...opts });
}

beforeEach(async () => {
  events = [];
  printed = [];
  await client.db(DB).dropDatabase();
  // Collections exist before the transactions, as they would in an application.
  await coll('orders').insertOne({ _id: 'seed' });
  await coll('stock').insertOne({ _id: 'apple', n: 10 });
});

describe('playground transactions', () => {
  it('makes the writes visible to others only once committed', async () => {
    const r = await run(`
      const session = db.getMongo().startSession();
      const orders = session.getDatabase("${DB}").orders;
      session.startTransaction();
      orders.insertOne({ _id: 1, item: "apple" });
      orders.insertOne({ _id: 2, item: "pear" });
      const inside = orders.countDocuments();
      const outside = db.orders.countDocuments();
      const during = session.inTransaction();
      print("before commit");
      session.commitTransaction();
      print("after commit");
      const after = db.orders.countDocuments();
      session.endSession();
      ({ inside, outside, after, during, ended: session.hasEnded() })
    `);
    expect(r.value).toEqual({ inside: 3, outside: 1, after: 3, during: true, ended: true });
    expect(await coll('orders').countDocuments()).toBe(3);
    // Published only after the commit, in order.
    expect(printed).toEqual(['before commit [0]', 'after commit [2]']);
    expect(published()).toEqual([{ e: 'i', id: 1 }, { e: 'i', id: 2 }]);
  });

  it('leaves nothing behind, and publishes nothing, when aborted', async () => {
    const r = await run(`
      const session = db.getMongo().startSession();
      const shop = session.getDatabase("${DB}");
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      shop.orders.insertOne({ _id: 1 });
      shop.stock.updateOne({ _id: "apple" }, { $inc: { n: -1 } });
      shop.orders.deleteOne({ _id: "seed" });
      session.abortTransaction();
      session.inTransaction()
    `);
    expect(r.value).toBe(false);
    expect(await coll('orders').find().toArray()).toEqual([{ _id: 'seed' }]);
    expect(await coll('stock').findOne({ _id: 'apple' })).toEqual({ _id: 'apple', n: 10 });
    expect(events).toEqual([]);
  });

  it('runs withTransaction with a callback written without await, and publishes after the commit', async () => {
    const r = await run(`
      const session = db.getMongo().startSession();
      const shop = session.getDatabase("${DB}");
      session.withTransaction(() => {
        const stock = shop.stock.findOne({ _id: "apple" });
        shop.orders.insertOne({ _id: 7, item: "apple", was: stock.n });
        shop.stock.updateOne({ _id: "apple" }, { $inc: { n: -1 } });
        print("in callback");
        return "done";
      })
    `);
    expect(r.value).toBe('done');
    expect(await coll('orders').findOne({ _id: 7 })).toEqual({ _id: 7, item: 'apple', was: 10 });
    expect(await coll('stock').findOne({ _id: 'apple' })).toEqual({ _id: 'apple', n: 9 });
    // Published once committed; the session, left open, is ended at the end.
    expect(printed).toEqual(['in callback [0]', 'Note: a session left open was ended. [2]']);
    expect(published()).toEqual([{ e: 'i', id: 7 }, { e: 'u', id: 'apple', fields: ['n'] }]);
  });

  it('commits nothing when the withTransaction callback throws', async () => {
    await expect(
      run(`
        const session = db.getMongo().startSession();
        session.withTransaction(() => {
          session.getDatabase("${DB}").orders.insertOne({ _id: 8 });
          throw new Error("out of stock");
        });
      `),
    ).rejects.toThrow('out of stock');
    expect(await coll('orders').countDocuments({ _id: 8 })).toBe(0);
    expect(events).toEqual([]);
  });

  it('aborts a transaction left open at the end of the script', async () => {
    const r = await run(`
      const session = db.getMongo().startSession();
      session.startTransaction();
      session.getDatabase("${DB}").orders.insertOne({ _id: 9 });
      db.getMongo().startSession();
      "end"
    `);
    expect(r.value).toBe('end');
    expect(printed).toEqual([
      'Note: The transaction still open was aborted at the end of the script: nothing of it was committed (session.commitTransaction() commits). [0]',
      'Note: a session left open was ended. [0]',
    ]);
    expect(await coll('orders').countDocuments({ _id: 9 })).toBe(0);
    expect(events).toEqual([]);
  });

  it('aborts the open transaction after an error', async () => {
    await expect(
      run(`
        const session = db.getMongo().startSession();
        session.startTransaction();
        session.getDatabase("${DB}").orders.insertOne({ _id: 10 });
        undefinedThing.x;
      `),
    ).rejects.toThrow('undefinedThing is not defined');
    expect(printed[0]).toMatch(/^Note: The transaction still open was aborted after the error/);
    expect(await coll('orders').countDocuments({ _id: 10 })).toBe(0);
    expect(events).toEqual([]);
  });

  it('runs reads of the session in its snapshot, and writes outside it as usual', async () => {
    const r = await run(`
      const session = db.getMongo().startSession();
      const orders = session.getDatabase("${DB}").orders;
      session.startTransaction({ readConcern: { level: "snapshot" } });
      const first = orders.find().toArray().length;
      db.orders.insertOne({ _id: "outside" });
      const second = orders.find().toArray().length;
      session.commitTransaction();
      session.endSession();
      ({ first, second })
    `);
    // The transaction keeps reading its snapshot: the insert made outside isn't in it.
    expect(r.value).toEqual({ first: 1, second: 1 });
    expect(await coll('orders').countDocuments()).toBe(2);
    expect(published()).toEqual([{ e: 'i', id: 'outside' }]);
  });

  it('awaits the calls inside expressions in a transaction: nothing runs after the session ends', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const r = await run(`
        const s = db.getMongo().startSession();
        s.startTransaction();
        const n = s.getDatabase("${DB}").stock.findOne({ _id: "apple" }).n;
        const shop = s.getDatabase("${DB}");
        if (shop.stock.findOne({ _id: "apple" }).n > 5) {
          shop.orders.insertOne({ _id: 12, was: n, orders: shop.orders.countDocuments() });
        }
        print(\`in transaction: \${shop.orders.countDocuments()}\`);
        s.commitTransaction();
        s.endSession();
        ({ n, orders: db.orders.find().sort({ _id: 1 }).toArray().length })
      `);
      expect(r.value).toEqual({ n: 10, orders: 2 });
      expect(printed).toEqual(['in transaction: 2 [0]']);
      expect(await coll('orders').findOne({ _id: 12 })).toEqual({ _id: 12, was: 10, orders: 1 });
      expect(published()).toEqual([{ e: 'i', id: 12 }]);
      // A promise left running would reject later, once the session has ended.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('awaits inside a withTransaction callback the reads used in an expression', async () => {
    const r = await run(`
      const session = db.getMongo().startSession();
      const shop = session.getDatabase("${DB}");
      session.withTransaction(() => {
        shop.orders.insertOne({ _id: 13, was: shop.stock.findOne({ _id: "apple" }).n });
        return \`orders: \${shop.orders.countDocuments()}\`;
      })
    `);
    expect(r.value).toBe('orders: 2');
    expect(await coll('orders').findOne({ _id: 13 })).toEqual({ _id: 13, was: 10 });
  });

  it('allows read-only transactions on a read-only connection and refuses their writes', async () => {
    const r = await run(
      `
      const session = db.getMongo().startSession();
      session.startTransaction();
      const apple = session.getDatabase("${DB}").stock.findOne({ _id: "apple" });
      session.commitTransaction();
      session.endSession();
      apple.n
    `,
      { readOnly: true },
    );
    expect(r.value).toBe(10);
    await expect(
      run(
        `const s = db.getMongo().startSession(); s.startTransaction(); s.getDatabase("${DB}").orders.insertOne({ _id: 11 });`,
        { readOnly: true },
      ),
    ).rejects.toThrow('insertOne() is not allowed: the connection is read-only.');
    expect(await coll('orders').countDocuments({ _id: 11 })).toBe(0);
  });
});

describe('playground transactions on a standalone server', () => {
  it("gives MongoDB's error: transactions need a replica set", async () => {
    const standalone = await MongoClient.connect(inject('mongoUri'));
    try {
      await expect(
        runPlayground(
          `const s = db.getMongo().startSession(); s.startTransaction(); s.getDatabase("${DB}").orders.insertOne({ _id: 1 });`,
          { client: standalone, database: DB, readOnly: false, print: () => undefined },
        ),
      ).rejects.toThrow(/replica set|mongos/i);
      expect(await standalone.db(DB).collection('orders').countDocuments()).toBe(0);
    } finally {
      await standalone.db(DB).dropDatabase();
      await standalone.close();
    }
  });
});
