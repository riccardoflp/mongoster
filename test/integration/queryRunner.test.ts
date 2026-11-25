// The queries of a collection's tab against the standalone mongod: a page with its count, collation and hint,
// the time limit, and a cancelled run, which must stop on the server too.
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { QueryRun, findPage, pipelinePage } from '../../src/queryRunner';

const DB = 'mongoster_query_runner';

let client: MongoClient;
const people = () => client.db(DB).collection('people');
const page = { sort: '', projection: '', skip: 0, limit: 50 };
/** A filter that takes 300 ms for each document it looks at. */
const SLOW = '{ $where: "sleep(300) || true" }';

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  await client.db(DB).dropDatabase();
  await people().insertMany([
    { _id: 1, name: 'mario', city: 'Rome' },
    { _id: 2, name: 'Mario', city: 'Milan' },
    { _id: 3, name: 'MARIO', city: 'Rome' },
    { _id: 4, name: 'luigi', city: 'Turin' },
    ...Array.from({ length: 60 }, (_, i) => ({ _id: 100 + i, name: `user ${i}`, city: 'Naples' })),
  ] as never[]);
  await people().createIndex({ city: 1 }, { name: 'by_city' });
});
afterAll(async () => {
  await client?.db(DB).dropDatabase();
  await client?.close();
});

/** The operations running on the server with the run's comment. */
async function running(run: QueryRun): Promise<number> {
  const ops = await client
    .db('admin')
    .aggregate([{ $currentOp: { allUsers: true, idleCursors: false } }, { $match: { 'command.comment': run.comment } }])
    .toArray();
  return ops.length;
}

async function until(condition: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('query.find-options: against mongod', () => {
  it('matches and counts by the collation', async () => {
    const plain = await findPage(people(), { ...page, filter: '{ name: "mario" }' }, new QueryRun());
    expect(plain.docs.map((d) => d._id)).toEqual([1]);
    expect(plain.count).toBe(1);
    const folded = await findPage(people(), { ...page, filter: '{ name: "mario" }', sort: '{ _id: 1 }', collation: '{ locale: "en", strength: 2 }' }, new QueryRun());
    expect(folded.docs.map((d) => d._id)).toEqual([1, 2, 3]);
    expect(folded.count).toBe(3);
  });

  it('takes a hint by the name of an index and by its keys', async () => {
    for (const hint of ['by_city', '"by_city"', '{ city: 1 }']) {
      const res = await findPage(people(), { ...page, filter: '{ city: "Rome" }', sort: '{ _id: 1 }', hint }, new QueryRun());
      expect(res.docs.map((d) => d._id), hint).toEqual([1, 3]);
      expect(res.count, hint).toBe(2);
    }
  });

  it('refuses a hint that names no index, and a collation without a locale', async () => {
    await expect(findPage(people(), { ...page, filter: '{ city: "Rome" }', hint: 'no_such_index' }, new QueryRun())).rejects.toThrow(/hint/i);
    await expect(findPage(people(), { ...page, filter: '{}', collation: '{ strength: 2 }' }, new QueryRun())).rejects.toThrow('Collation needs a locale');
  });
});

describe('query.timeout: against mongod', () => {
  it('gives a page of a find and of a pipeline with the total', async () => {
    const found = await findPage(people(), { ...page, filter: '{ city: "Naples" }', sort: '{ _id: 1 }', skip: 50, limit: 50 }, new QueryRun());
    expect(found.docs).toHaveLength(10);
    expect(found.count).toBe(60);
    const grouped = await pipelinePage(people(), [{ $group: { _id: '$city', n: { $sum: 1 } } }, { $sort: { _id: 1 } }], 1, 2, new QueryRun());
    expect(grouped.docs.map((d) => d._id)).toEqual(['Naples', 'Rome']);
    expect(grouped.count).toBe(4);
  });

  it('stops a query at the time limit and names the setting', async () => {
    const run = new QueryRun(1);
    const started = Date.now();
    const error = await findPage(people(), { ...page, filter: SLOW }, run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(run.describe(error)).toContain('the time limit of the setting mongoster.query.timeout');
    expect(run.cancelled).toBe(false);
  });
});

describe('query.cancel: against mongod', () => {
  it('ends the wait at once and stops the operation on the server', async () => {
    // Without a limit and uncancelled, this find would run for about 19 seconds.
    const run = new QueryRun(0);
    const started = Date.now();
    const result = findPage(people(), { ...page, filter: SLOW }, run).catch((e: unknown) => e);
    expect(await until(async () => (await running(run)) > 0), 'the find is running').toBe(true);

    await run.cancel(client);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(run.cancelled).toBe(true);
    expect(run.describe(error)).toBe('Query cancelled.');
    expect(await until(async () => (await running(run)) === 0), 'nothing of the run is left on the server').toBe(true);

    // The connection the driver closed is replaced: the next query works.
    const next = await findPage(people(), { ...page, filter: '{ _id: 4 }' }, new QueryRun());
    expect(next.docs.map((d) => d.name)).toEqual(['luigi']);
  });

  it('does nothing for a run that already ended', async () => {
    const run = new QueryRun();
    await findPage(people(), { ...page, filter: '{ _id: 1 }' }, run);
    expect(await run.cancel(client)).toBe(0);
  });
});
