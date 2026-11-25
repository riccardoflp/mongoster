// What the MCP tools give with mongoster.mcp.readDocuments off (no value of a document, by any way),
// and what they refuse whatever the setting: the system.* collections and the pipeline stages that are
// not a plain read of the collection.
import { describe, expect, it } from 'vitest';
import { MongoClient, MongoServerError } from 'mongodb';
import type { ConnectionInfo } from '../../src/connections';
import type { HistoryEntry, SavedQuery, ShardingStatus } from '../../src/shared/messages';
import { McpTool, handleMessage } from '../../src/shared/mcp';
import { joinedCollections, notPlainReadStage } from '../../src/shared/pipeline';
import { parseQuery } from '../../src/shared/query';
import { ToolHost, mcpTools } from '../../src/mcpTools';
import { SKIP_MAX, errorCode, safeErrorText, schemaShape, toolContext, validatorShape } from '../../src/mcp/context';
import { optionsText } from '../../src/mcp/data';
import { commandLine, operationText } from '../../src/mcp/performance';
import { formatShardingStatus } from '../../src/mcp/topology';
import type { WorkspaceHost } from '../../src/mcp/workspace';

const SECRET = 'hunter2-the-secret-value';

/** The error a server gives to { $expr: { $toInt: "$secret" } }: it quotes the value it could not convert. */
const conversionError = () => new MongoServerError({ message: `Failed to parse number '${SECRET}' in $convert with no onError value`, code: 241, codeName: 'ConversionFailure' });

interface Fake {
  counted: unknown[];
  countError?: Error;
  listError?: Error;
}

function fakeClient(fake: Fake): MongoClient {
  return {
    db: (name: string) => ({
      databaseName: name,
      listCollections: (filter: { name?: string }) => ({
        toArray: async () => ['users', 'system.users', 'system.profile'].filter((c) => !filter.name || c === filter.name).map((c) => ({ name: c, type: 'collection' })),
      }),
      admin: () => ({
        listDatabases: async () => {
          if (fake.listError) throw fake.listError;
          return { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }] };
        },
      }),
      collection: (c: string) => ({
        collectionName: c,
        countDocuments: async (filter: unknown) => {
          fake.counted.push(filter);
          if (fake.countError) throw fake.countError;
          return 42;
        },
        estimatedDocumentCount: async () => 40,
      }),
    }),
  } as unknown as MongoClient;
}

const history: HistoryEntry[] = [
  { id: 'w1', time: 1_700_000_000_000, connectionId: 'c1', connectionName: 'Local', database: 'shop', collection: 'users', label: `Edit email of "${SECRET}"`, inserted: 0, updated: 1, deleted: 0, size: 10 },
];
const savedQuery: SavedQuery = { id: 'q1', name: 'By email', at: 1_700_000_000_000, filter: `{ email: "${SECRET}", age: { $gt: 30 } }`, sort: '{ createdAt: -1 }', projection: '', collation: `{ locale: "${SECRET}", strength: 1 }`, hint: SECRET };
const recentQuery: SavedQuery = {
  id: 'q2',
  at: 1_700_000_100_000,
  filter: '',
  sort: '',
  projection: '',
  pipeline: [
    { op: '$match', body: `{ token: "${SECRET}" }`, enabled: true },
    { op: '$sort', body: '{ createdAt: -1 }', enabled: true },
  ],
};

function setup(readDocuments: boolean, fake: Partial<Fake> = {}) {
  const state: Fake = { counted: [], ...fake };
  const client = fakeClient(state);
  const host: ToolHost = {
    connections: { list: () => [{ id: 'c1', name: 'Local' } as ConnectionInfo], getClient: async () => client, isConnected: () => true },
    openSearch: () => undefined,
    readDocuments: () => readDocuments,
    workspace: {
      history: async () => history,
      historyEnabled: () => true,
      historyUsage: () => ({ bytes: 0, maxBytes: 100, maxDays: 7, maxEntries: 200, maxDocuments: 10_000 }),
      queries: () => ({ saved: [savedQuery], recent: [recentQuery] }),
    } as unknown as WorkspaceHost,
  };
  return { tools: mcpTools(host), state };
}

async function call(tools: McpTool[], name: string, args: Record<string, unknown> = {}) {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools, { name: 'mongoster', title: 'Mongoster', version: 'test', instructions: '' });
  if (!res || !('result' in res)) return { text: JSON.stringify(res), isError: true, unknown: true };
  const result = res.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join('\n'), isError: !!result.isError, unknown: false };
}

const users = { connection: 'Local', database: 'shop', collection: 'users' };

describe('readDocuments off', () => {
  it('does not offer explain_query nor the tools that return documents', async () => {
    const off = setup(false).tools.map((t) => t.name);
    for (const name of ['explain_query', 'find_documents', 'aggregate', 'distinct_values', 'watch_changes', 'write_history', 'mongoster_write_details']) expect(off).not.toContain(name);
    expect(setup(true).tools.map((t) => t.name)).toContain('explain_query');
    // Not listed and not callable either.
    const res = await call(setup(false).tools, 'explain_query', { ...users, filter: '{ $expr: { $toInt: "$secret" } }' });
    expect(res.unknown).toBe(true);
  });

  it('makes count_documents give the total only and refuse a filter without running it', async () => {
    const { tools, state } = setup(false);
    const refused = await call(tools, 'count_documents', { ...users, filter: '{ email: /^a/ }' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('mongoster.mcp.readDocuments is off');
    expect(state.counted).toEqual([]);
    const total = await call(tools, 'count_documents', users);
    expect(total.isError).toBe(false);
    expect(total.text).toContain('shop.users has 42 documents');
    // An empty filter is no filter.
    expect((await call(tools, 'count_documents', { ...users, filter: '{}' })).isError).toBe(false);
  });

  it('keeps count_documents with a filter as it was when readDocuments is on', async () => {
    const { tools, state } = setup(true);
    const res = await call(tools, 'count_documents', { ...users, filter: '{ status: "active" }' });
    expect(res.text).toContain('42 documents match { status: "active" }');
    expect(state.counted).toEqual([{ status: 'active' }]);
    const failed = await call(setup(true, { countError: conversionError() }).tools, 'count_documents', { ...users, filter: '{ $expr: { $toInt: "$secret" } }' });
    expect(failed.text).toContain(SECRET);
  });

  it("gives a server error's code in place of its text, which can quote values", async () => {
    const caught = await call(setup(false, { countError: conversionError() }).tools, 'count_documents', users);
    expect(caught.isError).toBe(true);
    expect(caught.text).not.toContain(SECRET);
    expect(caught.text).toContain('server error 241 (ConversionFailure)');
    // An error no tool catches goes through the same reduction.
    const uncaught = await call(setup(false, { listError: conversionError() }).tools, 'list_databases', { connection: 'Local' });
    expect(uncaught.isError).toBe(true);
    expect(uncaught.text).not.toContain(SECRET);
    expect(uncaught.text).toContain('241');
    expect((await call(setup(true, { listError: conversionError() }).tools, 'list_databases', { connection: 'Local' })).text).toContain(SECRET);
  });

  it('keeps the text of the errors that are not the server\'s', () => {
    expect(safeErrorText(new Error('connect ECONNREFUSED 127.0.0.1:27017'), false)).toBe('connect ECONNREFUSED 127.0.0.1:27017');
    expect(safeErrorText(conversionError(), true)).toContain(SECRET);
    expect(safeErrorText({ errmsg: SECRET, code: 2 }, false)).not.toContain(SECRET);
    expect(errorCode({ code: 13, codeName: 'Unauthorized' })).toBe('server error 13 (Unauthorized)');
    expect(errorCode({ codeName: `x ${SECRET}` })).toBe('server error');
  });

  it('gives the saved and recent queries as shapes', async () => {
    const off = await call(setup(false).tools, 'list_saved_queries', users);
    expect(off.text).not.toContain(SECRET);
    expect(off.text).toContain('filter: { email: ?, age: { $gt: ? } }');
    expect(off.text).toContain('sort: { createdAt: -1 }');
    // A collation and a hint are the user's text too: nothing says they hold only a locale and a name.
    expect(off.text).toContain('collation: { locale: ?, strength: 1 }');
    expect(off.text).toContain('hint: ?');
    expect(off.text).toContain('pipeline: [ { $match: { token: ? } }, { $sort: { createdAt: -1 } } ]');
    expect((await call(setup(true).tools, 'list_saved_queries', users)).text).toContain(`{ email: "${SECRET}", age: { $gt: 30 } }`);
  });

  it("leaves what each write did out of Mongoster's writes", async () => {
    const off = await call(setup(false).tools, 'mongoster_writes');
    expect(off.text).not.toContain(SECRET);
    expect(off.text).toContain('id w1');
    expect(off.text).toContain('1 updated');
    expect((await call(setup(true).tools, 'mongoster_writes')).text).toContain(`Edit email of "${SECRET}"`);
  });

  it('reduces the command of a running operation to its shape', () => {
    const command = { find: 'users', filter: { email: SECRET, age: { $gt: 30 } }, sort: { createdAt: -1 }, limit: 5, lsid: { id: 'x' }, $db: 'shop' };
    expect(commandLine(command)).toContain(SECRET);
    const shaped = commandLine(command, 300, false);
    expect(shaped).toBe('{ find: "users", filter: { email: ?, age: { $gt: ? } }, sort: { createdAt: -1 }, limit: ? }');
    // An insert carries whole documents.
    expect(commandLine({ insert: 'users', documents: [{ email: SECRET }] }, 300, false)).toBe('{ insert: "users", documents: [{ email: ? }] }');
    // RS27: a command over the server's limit comes as its text, cut; a hash starts with $ like a field path.
    expect(commandLine({ $truncated: `{ insert: "users", documents: [ { email: "${SECRET}" } ] }` }, 300, false)).toBe('{ $truncated: ? }');
    expect(commandLine({ update: 'users', updates: [{ q: { _id: 1 }, u: { $set: { hash: '$2b$10$' + SECRET } } }] }, 300, false)).not.toContain(SECRET);
    const op = { opid: 7, active: true, secs_running: 3, op: 'query', ns: 'shop.users', command };
    expect(operationText(op)).toContain(SECRET);
    expect(operationText(op, false)).not.toContain(SECRET);
    expect(operationText(op, false)).toContain('opid 7');
  });

  it('gives a validator as field names and types, a view pipeline as its shape', () => {
    const validator = {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'plan'],
        properties: {
          email: { bsonType: 'string', pattern: `^${SECRET}`, description: SECRET },
          plan: { enum: [SECRET, 'free'] },
          tags: { bsonType: 'array', maxItems: 5, items: { bsonType: ['string', 'null'] } },
        },
      },
      status: { $in: [SECRET] },
    };
    const text = validatorShape(validator);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('bsonType: "object"');
    expect(text).toContain('required: ["email", "plan"]');
    expect(text).toContain('email: { bsonType: "string", pattern: ?, description: ? }');
    expect(text).toContain('plan: { enum: ? }');
    expect(text).toContain('tags: { bsonType: "array", maxItems: 5, items: { bsonType: ["string", "null"] } }');
    expect(text).toContain('status: { $in: [?] }');
    // A kept keyword with something else than a type in it is not shown.
    expect(schemaShape({ bsonType: { x: SECRET }, minLength: SECRET.length })).toBe(`{ bsonType: ?, minLength: ${SECRET.length} }`);

    const collection = optionsText('shop.users', { name: 'users', type: 'collection', options: { validator } }, null, false);
    expect(collection).not.toContain(SECRET);
    expect(collection).toContain('field names and types only');
    expect(optionsText('shop.users', { name: 'users', type: 'collection', options: { validator } }, null)).toContain(SECRET);
    const view = optionsText('shop.active', { name: 'active', type: 'view', options: { viewOn: 'users', pipeline: [{ $match: { tenant: SECRET } }] } }, null, false);
    expect(view).not.toContain(SECRET);
    expect(view).toContain('[{ $match: { tenant: ? } }]');
  });

  it('leaves the shard key values out of the sharding status', () => {
    const status = {
      kind: 'mongos',
      at: 0,
      errors: [`balancer: not authorized, ${SECRET}`],
      collections: [{ ns: 'shop.users', key: '{ email: 1 }', balancing: true, chunks: {}, totalChunks: 1, zones: [{ zone: 'eu', min: `{ email: "${SECRET}" }`, max: '{ email: "z" }' }] }],
    } as unknown as ShardingStatus;
    const events = [{ key: '1', time: '2024-01-01T00:00:00Z', what: 'split', ns: 'shop.users', summary: `at { email: "${SECRET}" }`, raw: {} }];
    expect(formatShardingStatus(status, events)).toContain(SECRET);
    const off = formatShardingStatus(status, events, undefined, false);
    expect(off).not.toContain(SECRET);
    expect(off).toContain('zones eu');
    expect(off).toContain('split shop.users');
    expect(off).toContain('- balancer');
  });
});

describe('system collections', () => {
  it('are refused to the tools that take a collection, whatever readDocuments is', async () => {
    for (const readDocuments of [true, false]) {
      const { tools, state } = setup(readDocuments);
      for (const [name, args] of [
        ['count_documents', {}],
        ['describe_collection', {}],
        ['collection_options', {}],
        ['collection_stats', {}],
        ['open_query', {}],
        ['index_advice', {}],
        ['list_saved_queries', {}],
        ['open_search', { text: 'x' }],
        ['open_watch', {}],
      ] as const) {
        const res = await call(tools, name, { connection: 'Local', database: 'admin', collection: 'system.users', ...args });
        expect(res.isError, name).toBe(true);
        expect(res.text, name).toContain('system collection');
      }
      expect(state.counted).toEqual([]);
    }
    const { tools } = setup(true);
    for (const name of ['find_documents', 'distinct_values', 'watch_changes', 'write_history', 'explain_query']) {
      const res = await call(tools, name, { connection: 'Local', database: 'shop', collection: 'system.profile', field: 'a' });
      expect(res.text, name).toContain('system collection');
    }
  });

  // RS28: the oplog holds the writes to the system collections (users and their credentials) as documents.
  it('refuses the oplog of local as a collection, whatever the setting', async () => {
    for (const on of [true, false]) {
      const { tools } = setup(on);
      for (const name of ['find_documents', 'distinct_values', 'count_documents', 'describe_collection', 'explain_query']) {
        if (!tools.some((t) => t.name === name)) continue;
        const res = await call(tools, name, { connection: 'Local', database: 'local', collection: 'oplog.rs', field: 'ns' });
        expect(res.isError, name).toBe(true);
        expect(res.text, name).toContain('is the oplog');
      }
    }
  });
});

describe('pipelines', () => {
  const parsed = (text: string) => parseQuery(text) as unknown[];

  it('finds the stages that are not a plain read, in the nested pipelines too', () => {
    expect(notPlainReadStage(parsed('[ { $match: { a: 1 } }, { $group: { _id: "$a" } } ]'))).toBeUndefined();
    for (const op of ['$out', '$merge', '$changeStream', '$changeStreamSplitLargeEvent', '$currentOp', '$listSessions', '$listLocalSessions', '$queryStats', '$listSampledQueries', '$planCacheStats']) {
      expect(notPlainReadStage(parsed(`[ { ${op}: {} } ]`)), op).toBe(op);
      expect(notPlainReadStage(parsed(`[ { $facet: { a: [ { $match: {} } ], b: [ { ${op}: {} } ] } } ]`)), op).toBe(op);
      expect(notPlainReadStage(parsed(`[ { $lookup: { from: "x", as: "y", pipeline: [ { ${op}: {} } ] } } ]`)), op).toBe(op);
      expect(notPlainReadStage(parsed(`[ { $unionWith: { coll: "x", pipeline: [ { $lookup: { from: "z", as: "y", pipeline: [ { $facet: { f: [ { ${op}: {} } ] } } ] } } ] } } ]`)), op).toBe(op);
    }
    // A field named like a stage is not a stage.
    expect(notPlainReadStage(parsed('[ { $match: { $out: 1, pipeline: [ { $merge: {} } ] } } ]'))).toBeUndefined();
  });

  it('lists the collections a pipeline joins', () => {
    expect(
      joinedCollections(
        parsed(
          '[ { $lookup: { from: "a", as: "x", pipeline: [ { $unionWith: "b" }, { $graphLookup: { from: "c", startWith: "$p", connectFromField: "p", connectToField: "_id", as: "t" } } ] } }, { $unionWith: { coll: "d", pipeline: [ { $lookup: { from: { db: "admin", coll: "e" }, as: "y" } } ] } }, { $facet: { f: [ { $lookup: { from: "g", as: "z" } } ] } } ]',
        ),
      ).sort(),
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'g']);
  });

  it('are refused by the tools when they are not a plain read or read a system collection', () => {
    const ctx = toolContext({ list: () => [], getClient: () => Promise.reject(new Error('no server')), isConnected: () => false });
    const run = (pipeline: string) => () => ctx.pipeline({ pipeline });
    expect(run('[ { $match: { a: 1 } }, { $lookup: { from: "orders", localField: "a", foreignField: "b", as: "o" } } ]')).not.toThrow();
    expect(run('[ { $out: "copy" } ]')).toThrow(/\$out writes/);
    expect(run('[ { $facet: { a: [ { $merge: { into: "copy" } } ] } } ]')).toThrow(/\$merge writes/);
    expect(run('[ { $changeStream: {} } ]')).toThrow(/\$changeStream is refused/);
    expect(run('[ { $currentOp: { allUsers: true } } ]')).toThrow(/\$currentOp is refused/);
    expect(run('[ { $lookup: { from: "users", as: "u", pipeline: [ { $listSessions: {} } ] } } ]')).toThrow(/\$listSessions is refused/);
    expect(run('[ { $queryStats: {} } ]')).toThrow(/\$queryStats is refused/);
    expect(run('[ { $listSampledQueries: {} } ]')).toThrow(/\$listSampledQueries is refused/);
    expect(run('[ { $facet: { plans: [ { $planCacheStats: {} } ] } } ]')).toThrow(/\$planCacheStats is refused/);
    expect(run('[ { $lookup: { from: "system.users", localField: "a", foreignField: "user", as: "u" } } ]')).toThrow(/reads system\.users/);
    expect(run('[ { $unionWith: "system.profile" } ]')).toThrow(/reads system\.profile/);
    expect(run('[ { $lookup: { from: "oplog.rs", pipeline: [], as: "o" } } ]')).toThrow(/reads oplog\.rs/);
    expect(run('[ { $unionWith: { coll: "users", pipeline: [ { $lookup: { from: { db: "local", coll: "oplog.rs" }, pipeline: [], as: "o" } } ] } } ]')).toThrow(/reads oplog\.rs/);
    expect(run('[ { $unionWith: { coll: "users", pipeline: [ { $graphLookup: { from: "system.js", startWith: "$a", connectFromField: "a", connectToField: "_id", as: "t" } } ] } } ]')).toThrow(/reads system\.js/);
  });

  // RS42: JavaScript that runs on the server is not a plain read.
  it('refuses the operators that run JavaScript on the server, at any depth', () => {
    const ctx = toolContext({ list: () => [], getClient: () => Promise.reject(new Error('no server')), isConnected: () => false });
    expect(() => ctx.query({ filter: '{ $where: "sleep(1000) || true" }' })).toThrow(/\$where runs JavaScript/);
    expect(() => ctx.query({ filter: '{ $or: [ { a: 1 }, { $expr: { $function: { body: "function() { return true }", args: [], lang: "js" } } } ] }' })).toThrow(/\$function runs JavaScript/);
    expect(() => ctx.query({ filter: '{}', projection: '{ x: { $function: { body: "function() { return 1 }", args: [], lang: "js" } } }' })).toThrow(/\$function runs JavaScript/);
    expect(() => ctx.pipeline({ pipeline: '[ { $group: { _id: null, n: { $accumulator: { init: "function() { return 0 }", accumulate: "function(s) { return s }", accumulateArgs: [], merge: "function(a) { return a }", lang: "js" } } } } ]' })).toThrow(/\$accumulator runs JavaScript/);
    expect(() => ctx.pipeline({ pipeline: '[ { $lookup: { from: "users", as: "u", pipeline: [ { $match: { $where: "true" } } ] } } ]' })).toThrow(/\$where runs JavaScript/);
    expect(() => ctx.query({ filter: '{ where: "x", note: "$where" }' })).not.toThrow();
  });

  it('bounds the skip of find_documents', async () => {
    const res = await call(setup(true).tools, 'find_documents', { ...users, skip: SKIP_MAX + 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`skip must be between 0 and ${SKIP_MAX}`);
  });
});
