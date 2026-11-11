// The performance diagnostics MCP tools against real servers: explain, slow queries from the profiler and
// the log, running operations, the index advisor and collection statistics.
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { performanceTools } from '../../src/mcp/performance';
import { McpTool } from '../../src/shared/mcp';
import { callTool, testContext } from './mcpHelpers';

let client: MongoClient;
let tools: McpTool[];
const DATABASES = ['mcp_perf_explain', 'mcp_perf_slow', 'mcp_perf_off', 'mcp_perf_ops', 'mcp_perf_advice', 'mcp_perf_stats'];

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  tools = performanceTools(testContext(client));
  for (const db of DATABASES) await client.db(db).dropDatabase();
});
afterAll(async () => {
  for (const db of DATABASES) {
    await client.db(db).command({ profile: 0 });
    await client.db(db).dropDatabase();
  }
  await client?.close();
});

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ a: i % 100, b: i, s: i % 2 ? 'odd' : 'even' }));

describe('explain_query', () => {
  beforeAll(async () => {
    await client.db('mcp_perf_explain').collection('items').insertMany(items(2000));
  });

  it('shows a collection scan and suggests an index, then uses the index once it exists', async () => {
    const args = { connection: 'test', database: 'mcp_perf_explain', collection: 'items', filter: '{ a: 5 }', sort: '{ b: -1 }' };
    const before = await callTool(tools, 'explain_query', args);
    expect(before.isError).toBe(false);
    expect(before.text).toContain('COLLSCAN');
    expect(before.text).toContain('in-memory sort');
    expect(before.text).toContain('documents examined 2,000');
    expect(before.text).toContain('Suggested index');
    expect(before.text).toContain('db.getCollection("items").createIndex({ a: 1, b: -1 })');
    expect(before.text).toContain('Query plan:');

    await client.db('mcp_perf_explain').collection('items').createIndex({ a: 1, b: -1 });
    const after = await callTool(tools, 'explain_query', { ...args, limit: 5 });
    expect(after.isError).toBe(false);
    expect(after.text).toContain('IXSCAN');
    expect(after.text).toContain('index a_1_b_-1');
    expect(after.text).not.toContain('COLLSCAN');
    expect(after.text).not.toContain('Suggested index');
    expect(after.text).toContain('returned 5');
  });

  it('explains a pipeline, with the stages after the query layer', async () => {
    const res = await callTool(tools, 'explain_query', {
      connection: 'test',
      database: 'mcp_perf_explain',
      collection: 'items',
      pipeline: '[ { $match: { s: "odd" } }, { $group: { _id: "$a", n: { $sum: 1 } } } ]',
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('aggregate (2 stages: $match, $group)');
    expect(res.text).toMatch(/COLLSCAN/);
    expect(res.text).toContain('{ s: 1 }');
  });

  it('refuses $out, and a pipeline together with a filter', async () => {
    const out = await callTool(tools, 'explain_query', { connection: 'test', database: 'mcp_perf_explain', collection: 'items', pipeline: '[ { $match: {} }, { $out: "copy" } ]' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/\$out writes to the database/);
    const both = await callTool(tools, 'explain_query', { connection: 'test', database: 'mcp_perf_explain', collection: 'items', filter: '{ a: 1 }', pipeline: '[ { $match: {} } ]' });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/either a pipeline or filter/);
  });
});

describe('slow_queries', () => {
  it('groups the operations recorded by the profiler by shape, without their values, and leaves the profiler as it is', async () => {
    const db = client.db('mcp_perf_slow');
    await db.collection('orders').insertMany(items(500));
    await db.command({ profile: 2 });
    for (const a of [3, 4, 5]) await db.collection('orders').find({ a, s: 'needle-value' }).sort({ b: 1 }).toArray();
    await db.collection('orders').aggregate([{ $match: { b: { $gt: 10 } } }, { $count: 'n' }]).toArray();

    const res = await callTool(tools, 'slow_queries', { connection: 'test', database: 'mcp_perf_slow', sinceMinutes: 0 });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('from the profiler of mcp_perf_slow (level 2');
    expect(res.text).toContain('find mcp_perf_slow.orders: { a: ?, s: ? } · sort { b: 1 }');
    expect(res.text).toContain('3 operations');
    expect(res.text).toContain('plan COLLSCAN');
    expect(res.text).toContain('in-memory sort');
    expect(res.text).toContain('createIndex({ a: 1, s: 1, b: 1 })');
    expect(res.text).toContain('aggregate mcp_perf_slow.orders');
    expect(res.text).not.toContain('needle-value');
    expect((await db.command({ profile: -1 })).was).toBe(2);

    const narrowed = await callTool(tools, 'slow_queries', { connection: 'test', namespace: 'mcp_perf_slow.nothing', sinceMinutes: 0 });
    expect(narrowed.isError).toBe(false);
    expect(narrowed.text).toContain('0 operations');
    await db.command({ profile: 0 });
  });

  it('says when the profiler is off, and reads the server log', async () => {
    const db = client.db('mcp_perf_off');
    await db.collection('slow').insertOne({ x: 1 });
    // Slower than slowms (100 ms): logged as "Slow query" with the profiler off.
    await db.collection('slow').find({ $where: 'sleep(150) || true' }).toArray();

    const off = await callTool(tools, 'slow_queries', { connection: 'test', database: 'mcp_perf_off', source: 'profiler' });
    expect(off.isError).toBe(false);
    expect(off.text).toContain('The profiler of mcp_perf_off is off');
    expect(off.text).toContain('db.setProfilingLevel');
    expect((await db.command({ profile: -1 })).was).toBe(0);

    const auto = await callTool(tools, 'slow_queries', { connection: 'test', database: 'mcp_perf_off' });
    expect(auto.isError).toBe(false);
    expect(auto.text).toContain('from the server log');
    expect(auto.text).toContain('find mcp_perf_off.slow: { $where: ? }');

    const log = await callTool(tools, 'slow_queries', { connection: 'test', source: 'log', sinceMinutes: 0, limit: 1 });
    expect(log.isError).toBe(false);
    expect(log.text).toContain('from the server log');

    const missing = await callTool(tools, 'slow_queries', { connection: 'test', source: 'profiler' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('database is required');
  });
});

describe('current_operations', () => {
  it('lists an operation running now, with its command and client', async () => {
    const coll = client.db('mcp_perf_ops').collection('slow');
    await coll.insertOne({ x: 1 });
    const running = coll.find({ $where: 'sleep(2500) || true' }, { comment: 'mcp-perf-test' }).toArray();
    try {
      let text = '';
      for (let i = 0; i < 20 && !text.includes('mcp_perf_ops.slow'); i++) {
        await new Promise((r) => setTimeout(r, 100));
        const res = await callTool(tools, 'current_operations', { connection: 'test', namespace: 'mcp_perf_ops' });
        expect(res.isError).toBe(false);
        text = res.text;
      }
      expect(text).toMatch(/opid \d+ · active · [\d.]+ (s|ms) · query · mcp_perf_ops\.slow/);
      expect(text).toContain('$where');
      expect(text).toContain('client 127.0.0.1');
      expect(text).not.toContain('currentOp');
      expect(text).not.toContain('lsid');

      const none = await callTool(tools, 'current_operations', { connection: 'test', namespace: 'mcp_perf_ops', minSeconds: 3600 });
      expect(none.text).toMatch(/^0 operations running 3600 s or more, in mcp_perf_ops/);
    } finally {
      await running;
    }
  });

  it('shows an open transaction among the idle sessions of a replica set', async () => {
    const rs = await MongoClient.connect(inject('replSetUri'));
    const session = rs.startSession();
    try {
      await rs.db('mcp_perf_ops').collection('txn').insertOne({ x: 0 });
      session.startTransaction();
      await rs.db('mcp_perf_ops').collection('txn').insertOne({ x: 1 }, { session });
      const res = await callTool(performanceTools(testContext(rs)), 'current_operations', { connection: 'test', includeIdle: true });
      expect(res.isError).toBe(false);
      expect(res.text).toMatch(/transaction txnNumber \d+, open /);
    } finally {
      await session.abortTransaction().catch(() => undefined);
      await session.endSession();
      await rs.db('mcp_perf_ops').dropDatabase();
      await rs.close();
    }
  });
});

describe('index_advice', () => {
  it('suggests the index missing for the slow queries and finds a redundant one', async () => {
    const db = client.db('mcp_perf_advice');
    const coll = db.collection('people');
    await coll.insertMany(items(1000));
    await coll.createIndex({ s: 1 });
    await coll.createIndex({ s: 1, b: 1 });
    await db.command({ profile: 2 });
    for (const b of [7, 8, 9]) await coll.find({ b }).toArray();
    await db.command({ profile: 0 });

    const res = await callTool(tools, 'index_advice', { connection: 'test', database: 'mcp_perf_advice' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Index advice for mcp_perf_advice: 1 collection, 3 indexes');
    expect(res.text).toContain('from the profiler of mcp_perf_advice');
    expect(res.text).toContain('Indexes to create');
    expect(res.text).toContain('db.getCollection("people").createIndex({ b: 1 })');
    expect(res.text).toContain('find { b: ? }: 3 operations');
    expect(res.text).toContain('Redundant indexes');
    expect(res.text).toMatch(/- mcp_perf_advice\.people s_1 \{ s: 1 \}.*: served by s_1_b_1 \{ s: 1, b: 1 \}/);
    expect(res.text).toMatch(/not used yet, whose statistics started less than 24 hours ago/);

    const view = await db.createCollection('people_view', { viewOn: 'people', pipeline: [] }).then(() =>
      callTool(tools, 'index_advice', { connection: 'test', database: 'mcp_perf_advice', collection: 'people_view' }),
    );
    expect(view.text).toContain('is a view');
    const missing = await callTool(tools, 'index_advice', { connection: 'test', database: 'mcp_perf_advice', collection: 'nope' });
    expect(missing.isError).toBe(true);
  });
});

describe('collection_stats', () => {
  it('gives sizes, compression and the size and uses of each index', async () => {
    const db = client.db('mcp_perf_stats');
    const coll = db.collection('items');
    await coll.insertMany(items(1000));
    await coll.createIndex({ a: 1 });
    await coll.createIndex({ b: 1 }, { hidden: true });
    await coll.find({ a: 1 }).hint('a_1').toArray();
    await coll.find({ a: 2 }).hint('a_1').toArray();

    const res = await callTool(tools, 'collection_stats', { connection: 'test', database: 'mcp_perf_stats', collection: 'items' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('- documents: 1,000');
    expect(res.text).toMatch(/- data size: [\d.]+ KB \(uncompressed\), average document \d+ B/);
    expect(res.text).toMatch(/- storage size: [\d.]+ KB on disk/);
    expect(res.text).toContain('- capped: no');
    expect(res.text).toMatch(/- indexes: 3, total size [\d.]+ KB/);
    expect(res.text).toMatch(/- _id_ \{ _id: 1 \}: [\d.]+ KB, 0 uses since /);
    expect(res.text).toMatch(/- a_1 \{ a: 1 \}: [\d.]+ KB, 2 uses since /);
    expect(res.text).toMatch(/- b_1 \{ b: 1 \}: .*hidden/);

    await db.createCollection('items_view', { viewOn: 'items', pipeline: [{ $match: { s: 'odd' } }] });
    const view = await callTool(tools, 'collection_stats', { connection: 'test', database: 'mcp_perf_stats', collection: 'items_view' });
    expect(view.isError).toBe(false);
    expect(view.text).toContain('mcp_perf_stats.items_view is a view on items with the pipeline [{ $match: { s: "odd" } }]');

    const capped = await db.createCollection('capped', { capped: true, size: 1024 * 1024 });
    await capped.insertOne({ x: 1 });
    const cappedStats = await callTool(tools, 'collection_stats', { connection: 'test', database: 'mcp_perf_stats', collection: 'capped' });
    expect(cappedStats.text).toContain('- capped: yes, max 1.0 MB');
  });
});
