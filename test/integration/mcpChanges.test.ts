// The change stream and oplog MCP tools (watch_changes, write_history) on the single-node replica set,
// and their errors on the standalone mongod.
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { changesTools } from '../../src/mcp/changes';
import { TEST_CONNECTION, callTool, testContext } from './mcpHelpers';

const DB = `mcp_changes_${Date.now().toString(36)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tokenOf = (text: string) => /Resume token: ([0-9a-f]+)/i.exec(text)?.[1];

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

describe('watch_changes', () => {
  it('returns the changes made while it waits, and resumes right after them', async () => {
    const tools = changesTools(testContext(rs));
    const coll = rs.db(DB).collection('orders');
    const call = callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, collection: 'orders', waitSeconds: 4 });
    await pause(1500);
    await coll.insertOne({ _id: 'w1', status: 'new', qty: 1 } as never);
    await coll.updateOne({ _id: 'w1' } as never, { $set: { status: 'failed' }, $unset: { qty: '' } });
    await coll.deleteOne({ _id: 'w1' } as never);
    const first = await call;
    expect(first.isError).toBe(false);
    expect(first.text).toContain(`Changes of ${DB}.orders: 3 events, waited 4 s.`);
    expect(first.text).toMatch(/insert .*orders _id: "w1"\n {2}document: \{ _id: "w1", status: "new", qty: 1 \}/);
    expect(first.text).toMatch(/update .*orders _id: "w1"\n {2}set: \{ status: "failed" \}\n {2}unset: qty/);
    expect(first.text).toMatch(/delete .*orders _id: "w1"/);
    const token = tokenOf(first.text);
    expect(token).toBeDefined();

    await coll.insertOne({ _id: 'w2' } as never);
    const next = await callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, collection: 'orders', waitSeconds: 1, resumeAfter: token });
    expect(next.isError).toBe(false);
    expect(next.text).toContain('1 event');
    expect(next.text).toContain('_id: "w2"');
    expect(next.text).not.toContain('"w1"');
    // The token as { _data } works too.
    const again = await callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, collection: 'orders', waitSeconds: 0, resumeAfter: `{ _data: "${token}" }` });
    expect(again.text).toContain('_id: "w2"');
  });

  it('stops at maxEvents and gives the rest on the next call', async () => {
    const tools = changesTools(testContext(rs));
    const coll = rs.db(DB).collection('batch');
    const since = new Date(Date.now() - 1000).toISOString();
    await coll.insertMany([1, 2, 3, 4, 5].map((n) => ({ _id: n, n })) as never[]);
    const first = await callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, collection: 'batch', since, maxEvents: 2 });
    expect(first.text).toContain('2 events, stopped at maxEvents (2)');
    expect(first.text).toContain('_id: 1\n');
    expect(first.text).toContain('_id: 2\n');
    const rest = await callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, collection: 'batch', resumeAfter: tokenOf(first.text), waitSeconds: 1 });
    expect(rest.text).toContain('3 events');
    expect(rest.text).not.toMatch(/_id: [12]\n/);
    expect(rest.text).toContain('_id: 5\n');
  });

  it('filters by operation type and with a $match on the event, on the whole database', async () => {
    const tools = changesTools(testContext(rs));
    const coll = rs.db(DB).collection('filtered');
    const since = new Date(Date.now() - 1000).toISOString();
    await coll.insertMany([
      { _id: 'a', status: 'ok' },
      { _id: 'b', status: 'failed' },
    ] as never[]);
    await coll.deleteOne({ _id: 'a' } as never);
    const deletes = await callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, since, waitSeconds: 1, operationTypes: ['delete'] });
    expect(deletes.text).toContain('1 event');
    expect(deletes.text).toMatch(/delete .*filtered _id: "a"/);
    expect(deletes.text).not.toContain('insert');
    const failed = await callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, since, waitSeconds: 1, filter: '{ "fullDocument.status": "failed" }' });
    expect(failed.text).toContain('1 event');
    expect(failed.text).toContain('_id: "b"');
  });

  it('explains the errors: standalone server, bad arguments, invalid token', async () => {
    const tools = changesTools(testContext(standalone));
    const res = await callTool(tools, 'watch_changes', { connection: TEST_CONNECTION, waitSeconds: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`Change streams need a replica set or a sharded cluster: ${TEST_CONNECTION} is a standalone server.`);

    const rsTools = changesTools(testContext(rs));
    expect((await callTool(rsTools, 'watch_changes', { connection: TEST_CONNECTION, collection: 'x' })).text).toBe('collection needs database.');
    expect((await callTool(rsTools, 'watch_changes', { connection: TEST_CONNECTION, resumeAfter: 'not a token' })).text).toMatch(/^resumeAfter must be the resume token/);
    expect((await callTool(rsTools, 'watch_changes', { connection: TEST_CONNECTION, operationTypes: ['upsert'] })).text).toMatch(/unknown upsert/);
    const bad = await callTool(rsTools, 'watch_changes', { connection: TEST_CONNECTION, database: DB, waitSeconds: 0, resumeAfter: '8200' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Invalid resume token/);
  });
});

describe('write_history', () => {
  it('shows the writes newest first, filtered by _id, operation and time', async () => {
    const tools = changesTools(testContext(rs));
    const coll = rs.db(DB).collection('history');
    await coll.insertMany([{ _id: 'h1', status: 'new', items: [1, 2, 3] }, { _id: 'h2' }] as never[]);
    await pause(1200);
    const mark = new Date().toISOString();
    await coll.updateOne({ _id: 'h1' } as never, { $set: { status: 'done', 'meta.by': 'job' }, $unset: { items: '' } });
    await coll.deleteOne({ _id: 'h2' } as never);

    const all = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, collection: 'history' });
    expect(all.isError).toBe(false);
    // The update, the delete, the two inserts of insertMany (one batched applyOps entry), and the create of the collection.
    expect(all.text).toMatch(/^Writes to .*history, newest first: 5 operations\./);
    expect(all.text).toMatch(/batched write \(one command applied as applyOps\), lsid UUID\("[^"]+"\), txnNumber \d+:\n {2}insert /);
    expect(all.text).toMatch(/command .*\$cmd\n {2}\{ create: "history"/);
    const order = ['delete', 'update', 'insert'].map((op) => all.text.indexOf(`${op} ${DB}.history`));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(all.text).toMatch(/Oplog window: \S+ → \S+/);

    const h1 = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, collection: 'history', id: '"h1"' });
    expect(h1.text).toContain('2 operations');
    expect(h1.text).toMatch(/update .*history _id: "h1"\n {2}set: \{ status: "done", meta: \{ by: "job" \} \}/);
    expect(h1.text).toContain('unset: items');
    expect(h1.text).toMatch(/insert .*history _id: "h1"\n\s+document: \{ _id: "h1", status: "new", items: \[1, 2, 3\] \}/);
    expect(h1.text).not.toContain('"h2"');

    const deletes = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, collection: 'history', operations: ['delete'] });
    expect(deletes.text).toMatch(/^Writes to \S+\.history \(delete\), newest first: 1 operation\./);
    expect(deletes.text).not.toMatch(/insert|update|create/);
    expect(deletes.text).toMatch(/delete .*history _id: "h2"/);

    const recent = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, collection: 'history', since: mark });
    expect(recent.text).toContain('2 operations');
    expect(recent.text).not.toContain('insert');

    const limited = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, collection: 'history', limit: 1 });
    expect(limited.text).toContain('1 operation (there are older ones');

    const old = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, since: '2000-01-01T00:00:00Z', limit: 1 });
    expect(old.text).toContain("since is older than the oplog's first entry");
  });

  it('expands the operations of a transaction', async () => {
    const tools = changesTools(testContext(rs));
    await rs.db(DB).createCollection('txA');
    await rs.db(DB).createCollection('txB');
    const session = rs.startSession();
    try {
      await session.withTransaction(async () => {
        await rs.db(DB).collection('txA').insertOne({ _id: 't1', v: 1 } as never, { session });
        await rs.db(DB).collection('txB').insertOne({ _id: 't2', v: 2 } as never, { session });
      });
    } finally {
      await session.endSession();
    }
    const both = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, operations: ['insert'], since: '1m' });
    expect(both.text).toMatch(/transaction, lsid UUID\("[^"]+"\), txnNumber \S+:\n {2}insert .*txA _id: "t1"\n {4}document: .*\n {2}insert .*txB _id: "t2"/);
    const onlyB = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, database: DB, collection: 'txB', operations: ['insert'] });
    expect(onlyB.text).toContain('1 operation');
    expect(onlyB.text).toMatch(/transaction.*:\n {2}insert .*txB _id: "t2"/);
    expect(onlyB.text).not.toContain('"t1"');
    const byId = await callTool(tools, 'write_history', { connection: TEST_CONNECTION, id: '"t1"' });
    expect(byId.text).toContain('1 operation');
    expect(byId.text).toContain('txA _id: "t1"');
  });

  it('explains the errors: standalone server, bad time', async () => {
    const res = await callTool(changesTools(testContext(standalone)), 'write_history', { connection: TEST_CONNECTION });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`The oplog exists only on replica sets: ${TEST_CONNECTION} is a standalone server.`);
    const bad = await callTool(changesTools(testContext(rs)), 'write_history', { connection: TEST_CONNECTION, since: 'yesterday' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^since must be an ISO date/);
  });
});
