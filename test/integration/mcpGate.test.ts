// mongoster.mcp.readDocuments off against the standalone mongod: a value of a document comes out
// neither through a count, nor through the text of a server error, nor through a definition; and the
// system.* collections and the pipeline stages that are not a plain read are refused.
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ConnectionInfo } from '../../src/connections';
import { ToolHost, mcpTools } from '../../src/mcpTools';
import type { WorkspaceHost } from '../../src/mcp/workspace';
import type { McpTool } from '../../src/shared/mcp';
import { TEST_CONNECTION, callTool } from './mcpHelpers';

const DB = `mcp_gate_${process.pid}`;
const SECRET = 'hunter2-the-secret-value';

let client: MongoClient;
let db: Db;
let on: McpTool[];
let off: McpTool[];

const host = (readDocuments: boolean): ToolHost => ({
  connections: { list: () => [{ id: 'test-id', name: TEST_CONNECTION } as ConnectionInfo], getClient: async () => client, isConnected: () => true },
  openSearch: () => undefined,
  readDocuments: () => readDocuments,
  workspace: {} as WorkspaceHost,
});
const call = (tools: McpTool[], name: string, args: Record<string, unknown>) => callTool(tools, name, { connection: TEST_CONNECTION, database: DB, ...args });

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  db = client.db(DB);
  on = mcpTools(host(true));
  off = mcpTools(host(false));
  await db.collection('users').insertMany([
    { email: 'a@example.com', secret: SECRET, tenant: 'acme' },
    { email: 'b@example.com', secret: `${SECRET}-2`, tenant: 'acme' },
  ]);
  await db.collection('users').createIndex({ email: 1 }, { partialFilterExpression: { tenant: SECRET } });
  await db.createCollection('checked', { validator: { $jsonSchema: { bsonType: 'object', required: ['plan'], properties: { plan: { enum: [SECRET, 'free'] } } } } });
  await db.createCollection('acme', { viewOn: 'users', pipeline: [{ $match: { tenant: SECRET } }] });
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

describe('readDocuments off', () => {
  const leak = '{ $expr: { $toInt: "$secret" } }';

  it('gives no value through a count or the error of a count', async () => {
    // With the setting on, the server's error quotes the value: what the setting off must not let out.
    const quoted = await call(on, 'count_documents', { collection: 'users', filter: leak });
    expect(quoted.isError).toBe(true);
    expect(quoted.text).toContain(SECRET);
    const refused = await call(off, 'count_documents', { collection: 'users', filter: leak });
    expect(refused.isError).toBe(true);
    expect(refused.text).not.toContain(SECRET);
    expect((await call(off, 'count_documents', { collection: 'users', filter: '{ email: /^a/ }' })).isError).toBe(true);
    const total = await call(off, 'count_documents', { collection: 'users' });
    expect(total.text).toContain('has 2 documents');
  });

  it('does not run explain_query', async () => {
    expect(off.map((t) => t.name)).not.toContain('explain_query');
    // With the gate on it is offered: what it returns for such a filter depends on the server's version.
    expect(on.map((t) => t.name)).toContain('explain_query');
  });

  it('gives the definitions without their values', async () => {
    for (const [name, collection] of [
      ['collection_options', 'checked'],
      ['collection_options', 'acme'],
      ['collection_stats', 'acme'],
      ['collection_stats', 'users'],
      ['describe_collection', 'users'],
    ]) {
      const shown = await call(on, name, { collection });
      expect(shown.isError, `${name} ${collection}`).toBe(false);
      expect(shown.text, `${name} ${collection}`).toContain(SECRET);
      const hidden = await call(off, name, { collection });
      expect(hidden.isError, `${name} ${collection}`).toBe(false);
      expect(hidden.text, `${name} ${collection}`).not.toContain(SECRET);
    }
    expect((await call(off, 'collection_options', { collection: 'checked' })).text).toContain('required: ["plan"]');
    expect((await call(off, 'collection_stats', { collection: 'users' })).text).toContain('partial { tenant: ? }');
    // The structure stays: field names and types.
    expect((await call(off, 'describe_collection', { collection: 'users' })).text).toContain('- email: string');
  });

  it('gives the running operations without the values of their commands', async () => {
    const res = await callTool(off, 'current_operations', { connection: TEST_CONNECTION, includeIdle: true });
    expect(res.isError).toBe(false);
  });
});

describe('what is refused whatever the setting', () => {
  it('the system collections', async () => {
    await client.db('admin').command({ ping: 1 });
    for (const [name, args] of [
      ['find_documents', { database: 'admin', collection: 'system.users' }],
      ['find_documents', { database: 'admin', collection: 'system.version' }],
      ['count_documents', { database: DB, collection: 'system.views' }],
      ['describe_collection', { database: DB, collection: 'system.views' }],
      ['aggregate', { collection: 'users', pipeline: '[ { $lookup: { from: "system.views", pipeline: [], as: "v" } } ]' }],
      ['aggregate', { collection: 'users', pipeline: '[ { $unionWith: { coll: "users", pipeline: [ { $unionWith: "system.views" } ] } } ]' }],
    ] as const) {
      const res = await call(on, name, args);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(res.text).toMatch(/system/);
    }
  });

  it('the stages that are not a plain read of the collection', async () => {
    for (const pipeline of [
      '[ { $currentOp: { allUsers: true } } ]',
      '[ { $listLocalSessions: {} } ]',
      '[ { $changeStream: {} } ]',
      '[ { $facet: { a: [ { $out: "copy" } ] } } ]',
      '[ { $lookup: { from: "users", as: "u", pipeline: [ { $merge: { into: "copy" } } ] } } ]',
    ]) {
      const res = await call(on, 'aggregate', { collection: 'users', pipeline });
      expect(res.isError, pipeline).toBe(true);
      expect(res.text, pipeline).toMatch(/refused|only reads/);
    }
    expect(await db.listCollections({ name: 'copy' }).toArray()).toEqual([]);
    const ok = await call(on, 'aggregate', { collection: 'users', pipeline: '[ { $lookup: { from: "users", localField: "tenant", foreignField: "tenant", as: "same" } }, { $project: { email: 1, n: { $size: "$same" } } } ]' });
    expect(ok.isError).toBe(false);
  });

  it('a skip past the limit', async () => {
    expect((await call(on, 'find_documents', { collection: 'users', skip: 5_000_000 })).isError).toBe(true);
    expect((await call(on, 'find_documents', { collection: 'users', sort: '{ email: 1 }', skip: 1 })).text).toContain('b@example.com');
  });
});
