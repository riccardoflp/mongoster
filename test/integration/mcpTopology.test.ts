// The MCP tools about the deployment (src/mcp/topology.ts) against the standalone mongod and the
// single-node replica set: server status, database statistics, replica set and sharding status.
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { McpTool } from '../../src/shared/mcp';
import { topologyTools } from '../../src/mcp/topology';
import { TEST_CONNECTION, callTool, testContext } from './mcpHelpers';

const DB = 'mcp_topo_stats';
const conn = { connection: TEST_CONNECTION };

let standalone: MongoClient;
let replSet: MongoClient;
let single: McpTool[];
let rs: McpTool[];

beforeAll(async () => {
  [standalone, replSet] = await Promise.all([MongoClient.connect(inject('mongoUri')), MongoClient.connect(inject('replSetUri'))]);
  single = topologyTools(testContext(standalone));
  rs = topologyTools(testContext(replSet));
  const db = standalone.db(DB);
  await db.dropDatabase();
  await db.collection('big').insertMany(Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(200) })));
  await db.collection('small').insertOne({ a: 1 });
  await db.collection('small').createIndex({ a: 1 });
  await db.createCollection('bigView', { viewOn: 'big', pipeline: [{ $match: { i: { $lt: 10 } } }] });
});

afterAll(async () => {
  await standalone?.db(DB).dropDatabase();
  await Promise.all([standalone?.close(), replSet?.close()]);
});

describe('server_status', () => {
  it('describes a standalone server', async () => {
    const { text, isError } = await callTool(single, 'server_status', conn);
    expect(isError).toBe(false);
    expect(text).toMatch(/^Server .+:\d+ \(mongod \d+\.\d+/);
    expect(text).toContain('Topology: standalone server.');
    expect(text).toMatch(/storage engine wiredTiger/);
    expect(text).toMatch(/Connections: [\d,]+ current, [\d,]+ available/);
    expect(text).toMatch(/opcounters\): insert [\d,]+, query [\d,]+/);
    expect(text).toMatch(/WiredTiger cache: .+ used \(.+%\), .+ dirty/);
    expect(text).toMatch(/Global lock: queued \d+/);
    expect(text).toMatch(/Asserts since startup: regular \d+/);
    expect(text).not.toContain('opcountersRepl');
  });

  it('describes a replica set member and its state', async () => {
    const { text, isError } = await callTool(rs, 'server_status', conn);
    expect(isError).toBe(false);
    expect(text).toMatch(/Topology: member of the replica set \S+, state PRIMARY; primary \S+:\d+, 1 electable member/);
    expect(text).toContain('opcountersRepl');
    expect(text).toMatch(/Transactions: \d+ open/);
  });

  it('names the connections when the one given does not exist', async () => {
    const { text, isError } = await callTool(single, 'server_status', { connection: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('Connections: test');
  });
});

describe('database_stats', () => {
  it('lists every database, largest first, with a total', async () => {
    const { text, isError } = await callTool(single, 'database_stats', conn);
    expect(isError).toBe(false);
    expect(text).toMatch(/^\d+ databases on test, largest on disk/);
    // dbStats also counts system.views.
    expect(text).toMatch(new RegExp(`- ${DB}: \\d+ collections, 1 view, \\d+ documents, data .+, storage .+, \\d+ indexes`));
    expect(text).toMatch(/- admin: /);
    expect(text).toMatch(/\nTotal: [\d,]+ documents/);
  });

  it('limits the databases listed', async () => {
    const { text } = await callTool(single, 'database_stats', { ...conn, limit: 1 });
    expect(text).toContain('; the first 1:');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
  });

  it('lists the collections of one database, largest first', async () => {
    const { text, isError } = await callTool(single, 'database_stats', { ...conn, database: DB });
    expect(isError).toBe(false);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(new RegExp(`^- ${DB}: \\d+ collections, 1 view`));
    expect(text).toContain(`Collections of ${DB} (2), largest data first:`);
    const big = lines.findIndex((l) => l.startsWith('- big: 500 documents, data '));
    const small = lines.findIndex((l) => /^- small: 1 document, data .+, 2 indexes /.test(l));
    expect(big).toBeGreaterThan(0);
    expect(small).toBeGreaterThan(big);
    expect(text).toContain('Views (1): bigView');
    expect(text).not.toContain('Total:');
  });

  it('limits the collections listed', async () => {
    const { text } = await callTool(single, 'database_stats', { ...conn, database: DB, limit: 1 });
    expect(text).toContain('largest data first; the first 1:');
    expect(text).toContain('- big:');
    expect(text).not.toContain('- small:');
  });

  it('refuses a database that does not exist', async () => {
    const { text, isError } = await callTool(single, 'database_stats', { ...conn, database: 'mcp_topo_missing' });
    expect(isError).toBe(true);
    expect(text).toContain("doesn't exist on test: use list_databases");
  });
});

describe('replica_set_status', () => {
  it('lists the members of the replica set and the oplog window', async () => {
    const { text, isError } = await callTool(rs, 'replica_set_status', conn);
    expect(isError).toBe(false);
    expect(text).toMatch(/^Replica set \S+, term \d+, connected to \S+:\d+\. Primary: \S+:\d+\./);
    expect(text).toContain('Members (1):');
    expect(text).toMatch(/- \S+:\d+ PRIMARY \(connected\): up .+, last applied \d{4}-\d\d-\d\dT.+, priority 1, 1 vote/);
    expect(text).toMatch(/Settings: election timeout [\d,]+ ms/);
    expect(text).toMatch(/Oplog: first entry \d{4}-.+, last entry \d{4}-.+: a window of [\d.]+ hours .+ used of .+ configured \(.+%\), [\d,]+ entr/);
    expect(text).not.toContain('Note:');
  });

  it('says that a standalone server is not a replica set', async () => {
    const { text, isError } = await callTool(single, 'replica_set_status', conn);
    expect(isError).toBe(false);
    expect(text).toMatch(/is a standalone server, not a replica set member/);
  });
});

describe('sharding_status', () => {
  it('says that a standalone server is not a sharded cluster', async () => {
    const { text, isError } = await callTool(single, 'sharding_status', conn);
    expect(isError).toBe(false);
    expect(text).toMatch(/is a standalone server: it is not a sharded cluster\.$/);
  });

  it('says that a replica set is not a sharded cluster either', async () => {
    const { text, isError } = await callTool(rs, 'sharding_status', conn);
    expect(isError).toBe(false);
    expect(text).toMatch(/^\S+:\d+ is a replica set member, not a mongos: it is not a sharded cluster/);
  });
});
