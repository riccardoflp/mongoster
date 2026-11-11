// Compare Structure against the standalone mongod: reading two databases, their differences, applying the
// steps, and running the generated script in the playground's runtime.
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { runPlayground } from '../../src/playground/shell';
import { applyOp, readStructure } from '../../src/structure';
import { StructureDiff, diffStructure, diffTitle, orderForScript, structureScript } from '../../src/shared/structure';

const LEFT = 'mongoster_structure_left';
const RIGHT = 'mongoster_structure_right';

let client: MongoClient;
beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
});
afterAll(async () => {
  await client?.db(LEFT).dropDatabase();
  await client?.db(RIGHT).dropDatabase();
  await client?.close();
});

/** dev (left) and prod (right): prod lags behind and has a few things of its own. */
async function setup(): Promise<void> {
  await client.db(LEFT).dropDatabase();
  await client.db(RIGHT).dropDatabase();
  const l = client.db(LEFT);
  await l.createCollection('orders', { validator: { $jsonSchema: { bsonType: 'object', required: ['status'] } }, validationLevel: 'moderate' });
  const orders = l.collection('orders');
  await orders.createIndex({ status: 1 });
  await orders.createIndex({ customer: 1, date: -1 }, { name: 'byCustomer' });
  await orders.createIndex({ code: 1 }, { unique: true });
  await orders.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
  await orders.createIndex({ title: 'text', body: 'text' }, { weights: { title: 5 } });
  await l.createCollection('logs', { capped: true, size: 1 << 20 });
  await l.createCollection('events', { timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' } });
  await l.createCollection('users', { clusteredIndex: { key: { _id: 1 }, unique: true } });
  await l.createCollection('recent', { viewOn: 'orders', pipeline: [{ $sort: { date: -1 } }] });
  await l.createCollection('big', { viewOn: 'recent', pipeline: [{ $match: { total: { $gt: 100 } } }] });

  const r = client.db(RIGHT);
  await r.createCollection('orders');
  const rOrders = r.collection('orders');
  await rOrders.insertOne({ status: 'open', code: 'A1' });
  await rOrders.createIndex({ status: 1 });
  await rOrders.createIndex({ customer: 1, date: -1 });
  await rOrders.createIndex({ code: 1 });
  await rOrders.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 60 });
  await rOrders.createIndex({ legacy: 1 });
  await r.createCollection('legacy');
  await r.collection('legacy').insertOne({ old: true });
  await r.createCollection('users');
  await r.createCollection('recent', { viewOn: 'orders', pipeline: [] });
}

const compare = async () => diffStructure(await readStructure(client, LEFT), await readStructure(client, RIGHT));
const differences = (diffs: StructureDiff[]) =>
  diffs
    .filter((d) => d.kind !== 'same')
    .map((d) => `${d.collection} ${diffTitle(d)} ${d.kind}`)
    .sort();

describe('compare structure', () => {
  beforeEach(setup);

  it('reads both databases and finds their differences', async () => {
    const left = await readStructure(client, LEFT);
    // A mongod without mongot: no search, and the comparison goes on.
    expect(left.search).toBe('unsupported');
    expect(left.sharded).toBe(false);
    expect(left.collections.map((c) => [c.name, c.type])).toEqual([
      ['big', 'view'],
      ['events', 'timeseries'],
      ['logs', 'collection'],
      ['orders', 'collection'],
      ['recent', 'view'],
      ['users', 'collection'],
    ]);
    const orders = left.collections.find((c) => c.name === 'orders')!;
    expect(orders.options).toEqual({ validator: { $jsonSchema: { bsonType: 'object', required: ['status'] } }, validationLevel: 'moderate' });
    expect(orders.indexes.find((i) => i.name === 'title_text_body_text')).toEqual({ name: 'title_text_body_text', keys: { body: 'text', title: 'text' }, options: { weights: { title: 5 } } });

    const result = await compare();
    expect(result.notes).toEqual([]);
    expect(differences(result.diffs)).toEqual([
      'big view onlyLeft',
      'events time series collection onlyLeft',
      'legacy collection onlyRight',
      'logs collection onlyLeft',
      'orders index byCustomer different',
      'orders index code_1 different',
      'orders index expiresAt_1 different',
      'orders index legacy_1 onlyRight',
      'orders index title_text_body_text onlyLeft',
      'orders options different',
      'recent view different',
      'users options different',
    ]);
    const ttl = result.diffs.find((d) => d.name === 'expiresAt_1')!;
    expect(ttl.steps).toEqual([{ op: { type: 'collMod', collection: 'orders', changes: { index: { name: 'expiresAt_1', expireAfterSeconds: 3600 } } } }]);
    expect(result.diffs.find((d) => d.name === 'byCustomer')?.summary).toBe('Same keys { customer: 1, date: -1 }, named customer_1_date_-1 on the right');
  });

  it('applies the steps: first without the drops, then with them', async () => {
    const run = async (drops: boolean) => {
      const { diffs } = await compare();
      for (const d of orderForScript(diffs)) for (const s of d.steps) if (s.op && (drops || !s.destructive)) await applyOp(client, RIGHT, s.op);
    };
    await run(false);
    expect(differences((await compare()).diffs)).toEqual([
      'legacy collection onlyRight',
      'orders index byCustomer different',
      'orders index code_1 different',
      'orders index legacy_1 onlyRight',
      // A collection can't become clustered: only said.
      'users options different',
    ]);
    // The documents are still there.
    expect(await client.db(RIGHT).collection('orders').countDocuments()).toBe(1);

    await run(true);
    expect(differences((await compare()).diffs)).toEqual(['users options different']);
    expect((await client.db(RIGHT).listCollections({ name: 'legacy' }).toArray()).length).toBe(0);
  });

  it('runs the generated script in the playground', async () => {
    const { diffs } = await compare();
    const script = structureScript(diffs, { database: RIGHT, left: 'dev', right: 'prod', drops: true });
    await runPlayground(script, { client, database: 'test', readOnly: false, print: () => undefined });
    expect(differences((await compare()).diffs)).toEqual(['users options different']);

    // A read-only playground refuses the script.
    await setup();
    const again = structureScript((await compare()).diffs, { database: RIGHT, left: 'dev', right: 'prod', drops: false });
    await expect(runPlayground(again, { client, database: 'test', readOnly: true, print: () => undefined })).rejects.toThrow();
  });
});
