import { describe, expect, it } from 'vitest';
import { BSON, MongoClient } from 'mongodb';
import type { ConnectionInfo } from '../../src/connections';
import type { HistoryEntry, SavedQuery } from '../../src/shared/messages';
import { McpTool, handleMessage } from '../../src/shared/mcp';
import { toolContext } from '../../src/mcp/context';
import { MonitorSection, OpenQueryArgs, RecordedDocument, WorkspaceHost, WorkspaceScope, workspaceTools } from '../../src/mcp/workspace';

const { ObjectId } = BSON;

/** A client whose databases have the given collections; `hello` answers as a replica set unless `standalone`. */
function fakeClient(collections: Record<string, string[]>, standalone = false): MongoClient {
  return {
    db: (name: string) => ({
      listCollections: (filter: { name?: string }) => ({
        toArray: async () => (collections[name] ?? []).filter((c) => !filter.name || c === filter.name).map((c) => ({ name: c, type: 'collection' })),
      }),
      collection: (c: string) => ({ collectionName: c }),
      command: async () => (standalone ? { isWritablePrimary: true } : { isWritablePrimary: true, setName: 'rs0' }),
    }),
  } as unknown as MongoClient;
}

const entry = (e: Partial<HistoryEntry> & { id: string; time: number }): HistoryEntry => ({
  connectionId: 'c1',
  connectionName: 'Local',
  database: 'shop',
  collection: 'orders',
  label: 'Update one',
  inserted: 0,
  updated: 0,
  deleted: 0,
  size: 100,
  ...e,
});

interface Setup {
  connections?: ConnectionInfo[];
  history?: HistoryEntry[];
  docs?: RecordedDocument[];
  saved?: SavedQuery[];
  recent?: SavedQuery[];
  enabled?: boolean;
  urlSet?: boolean;
  check?: string;
  lastError?: { time: number; message: string };
  standalone?: boolean;
}

function setup(s: Setup = {}) {
  const calls: { watch?: WorkspaceScope; monitor?: { id: string; section?: MonitorSection }; query?: OpenQueryArgs; history?: boolean; queries?: unknown } = {};
  const list = s.connections ?? [
    { id: 'c1', name: 'Local' },
    { id: 'c2', name: 'Prod', readOnly: true },
  ];
  const client = fakeClient({ shop: ['orders', 'users'] }, s.standalone);
  const ctx = toolContext({ list: () => list, getClient: async () => client, isConnected: () => true });
  const host: WorkspaceHost = {
    history: async () => s.history ?? [],
    historyEnabled: () => s.enabled ?? true,
    historyUsage: () => ({ bytes: 0, maxBytes: 100, maxDays: 7, maxEntries: 200, maxDocuments: 10_000 }),
    historyDocuments: async () => s.docs ?? [],
    queries: (ref) => {
      calls.queries = ref;
      return { saved: s.saved ?? [], recent: s.recent ?? [] };
    },
    redisUrlSet: async () => s.urlSet ?? true,
    checkRedis: async () => s.check,
    ...(s.lastError && { redisLastError: () => s.lastError }),
    openWatch: (_info, scope) => (calls.watch = scope),
    openMonitor: (info, section) => (calls.monitor = { id: info.id, section }),
    openQuery: async (args) => {
      calls.query = args;
    },
    openHistory: () => (calls.history = true),
  };
  return { tools: workspaceTools(ctx, host), calls };
}

async function call(tools: McpTool[], name: string, args: Record<string, unknown> = {}) {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools, { name: 'm', title: 'M', version: 't', instructions: '' });
  const result = (res as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { text: result.content.map((c) => c.text).join('\n'), isError: !!result.isError };
}

describe('workspace tools', () => {
  it('are all read-only, and only the write details return documents', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'mongoster_writes',
      'mongoster_write_details',
      'redis_oplog_status',
      'list_saved_queries',
      'open_watch',
      'open_monitor',
      'open_explain',
      'open_history',
    ]);
    expect(tools.every((t) => t.readOnly)).toBe(true);
    expect(tools.filter((t) => t.documents).map((t) => t.name)).toEqual(['mongoster_write_details']);
  });
});

describe('mongoster_writes', () => {
  const history = [
    entry({ id: 'a', time: Date.UTC(2026, 0, 1, 10), label: 'Delete many { status: "old" }', deleted: 3 }),
    entry({ id: 'b', time: Date.UTC(2026, 0, 2, 10), collection: 'users', updated: 1, undone: Date.UTC(2026, 0, 2, 11) }),
    entry({ id: 'c', time: Date.UTC(2026, 0, 2, 11), collection: 'users', label: 'Undo: Update one', updated: 1, undoOf: 'b' }),
  ];

  it('lists the writes newest first, with counts, undo state and limits', async () => {
    const { tools } = setup({ history });
    const { text } = await call(tools, 'mongoster_writes');
    const lines = text.split('\n');
    expect(lines[0]).toBe('3 writes in the undo history (newest first):');
    expect(lines[1]).toBe('- id c · 2026-01-02T11:00:00Z · Local › shop.users · Undo: Update one · 1 updated · undo of b');
    expect(lines[2]).toContain('undone 2026-01-02T11:00:00Z');
    expect(lines[3]).toBe('- id a · 2026-01-01T10:00:00Z · Local › shop.orders · Delete many { status: "old" } · 3 deleted');
    expect(text).toContain('up to 200 writes from the last 7 days');
    expect(text).toContain("Writes aren't recorded for: Prod (read-only).");
  });

  it('filters by connection, database, collection and limit', async () => {
    const { tools } = setup({ history });
    const { text } = await call(tools, 'mongoster_writes', { connection: 'local', database: 'shop', collection: 'users', limit: 1 });
    expect(text.split('\n')[0]).toBe('2 writes through Local on shop.users in the undo history, the newest 1 (newest first):');
    expect(text).toContain('- id c ');
    expect(text).not.toContain('- id b ');
    expect((await call(tools, 'mongoster_writes', { collection: 'users' })).text).toBe('collection needs database.');
    expect((await call(tools, 'mongoster_writes', { connection: 'nope' })).isError).toBe(true);
  });

  it('says when the history is off, globally or for the connection', async () => {
    const { tools } = setup({ enabled: false, connections: [{ id: 'c1', name: 'Local', noHistory: true }] });
    const { text } = await call(tools, 'mongoster_writes', { connection: 'Local' });
    expect(text).toContain('No writes through Local in the undo history.');
    expect(text).toContain('The undo history is off (setting mongoster.history.enabled)');
    expect(text).toContain("The undo history is off for Local: its writes aren't recorded.");
  });
});

describe('mongoster_write_details', () => {
  const id = new ObjectId('65a1b2c3d4e5f60718293a4b');
  const docs: RecordedDocument[] = [
    { id: 1, before: { _id: 1, name: 'Ann', n: new BSON.Int32(5) }, after: 'x' },
    { id: 2, before: { _id: 2, name: 'Bob' }, after: null },
    { id, before: null, after: 'y' },
  ];

  it('returns the documents as they were, by kind', async () => {
    const { tools } = setup({ history: [entry({ id: 'a', time: 0, updated: 1, deleted: 1, inserted: 1 })], docs });
    const { text, isError } = await call(tools, 'mongoster_write_details', { id: 'a' });
    expect(isError).toBe(false);
    expect(text).toContain('3 documents recorded.');
    expect(text).toMatch(/Updated, as they were before:\n\[\n\{[\s\S]*name: "Ann"/);
    expect(text).toMatch(/Deleted, as they were:\n\[\n\{[\s\S]*name: "Bob"/);
    expect(text).toContain('Inserted (only their _id is kept): ObjectId("65a1b2c3d4e5f60718293a4b")');
  });

  it('limits the documents', async () => {
    const { tools } = setup({ history: [entry({ id: 'a', time: 0 })], docs });
    const { text } = await call(tools, 'mongoster_write_details', { id: 'a', limit: 1 });
    expect(text).toContain('3 documents recorded, the first 1 shown.');
    expect(text).not.toContain('Bob');
  });

  it('refuses unknown and undone writes', async () => {
    const { tools } = setup({ history: [entry({ id: 'u', time: 0, undone: Date.UTC(2026, 0, 1) })] });
    expect((await call(tools, 'mongoster_write_details', { id: 'zz' })).text).toMatch(/^No write zz/);
    const undone = await call(tools, 'mongoster_write_details', { id: 'u' });
    expect(undone).toEqual({ isError: true, text: 'The write u was undone on 2026-01-01T00:00:00Z: its documents are no longer kept.' });
  });
});

describe('redis_oplog_status', () => {
  const connections: ConnectionInfo[] = [
    { id: 'c1', name: 'Local' },
    { id: 'c2', name: 'Meteor', redisOplog: { prefix: 'app:', namespaces: ['tenant1'], scope: ['shop.orders', 'logs', 'crm.*'] } },
  ];

  it('says when the connection does not publish', async () => {
    const { tools } = setup({ connections });
    expect((await call(tools, 'redis_oplog_status', { connection: 'Local' })).text).toMatch(/^Local doesn't publish/);
  });

  it('gives the settings and the channels of a published collection', async () => {
    const { tools } = setup({ connections });
    const { text } = await call(tools, 'redis_oplog_status', { connection: 'Meteor', database: 'shop', collection: 'orders' });
    expect(text).toContain('Redis URL: set.');
    expect(text).toContain('Channel prefix: "app:".');
    expect(text).toContain('Namespaces: tenant1.');
    expect(text).toContain('Published: shop.orders, logs, crm.*.');
    expect(text).toContain('on the channels "app:orders", "app:tenant1::orders", "app:orders::<_id>"');
    expect((await call(tools, 'redis_oplog_status', { connection: 'Meteor', database: 'shop', collection: 'users' })).text).toContain(
      'The writes on shop.users are not published',
    );
  });

  it('tells whether a database is published, wholly or in part', async () => {
    const { tools } = setup({ connections });
    expect((await call(tools, 'redis_oplog_status', { connection: 'Meteor', database: 'logs' })).text).toContain('every collection of logs are published');
    expect((await call(tools, 'redis_oplog_status', { connection: 'Meteor', database: 'shop' })).text).toContain('Only the writes on the collections of shop matching shop.orders');
    expect((await call(tools, 'redis_oplog_status', { connection: 'Meteor', database: 'other' })).text).toContain('The writes on other are not published');
  });

  it('checks Redis and reports the last error without URLs', async () => {
    const failing = setup({ connections, urlSet: false, check: 'Invalid Redis URL: redis://user:secret@host:6379', lastError: { time: 0, message: 'connect ECONNREFUSED 127.0.0.1:6379' } });
    const { text } = await call(failing.tools, 'redis_oplog_status', { connection: 'Meteor', check: true });
    expect(text).toContain('Redis URL: missing');
    expect(text).toContain('Last publishing error, 1970-01-01T00:00:00Z: connect ECONNREFUSED 127.0.0.1:6379');
    expect(text).toContain('Redis check failed: Invalid Redis URL: <Redis URL>');
    expect(text).not.toContain('secret');
    const ok = setup({ connections });
    expect((await call(ok.tools, 'redis_oplog_status', { connection: 'Meteor', check: true })).text).toContain('Redis check: Redis answers.');
  });
});

describe('list_saved_queries', () => {
  it('lists saved and recent queries in mongosh text', async () => {
    const saved: SavedQuery[] = [
      { id: '1', name: 'Active', filter: '{ status: "active" }', sort: '{ at: -1 }', projection: '', at: Date.UTC(2026, 0, 1) },
      {
        id: '2',
        name: 'By city',
        filter: '',
        sort: '',
        projection: '',
        pipeline: [
          { op: '$match', body: '{\n  a: 1\n}', enabled: true },
          { op: '$group', body: '{ _id: "$city" }', enabled: true },
          { op: '$limit', body: '10', enabled: false },
        ],
        at: Date.UTC(2026, 0, 2),
      },
    ];
    const recent: SavedQuery[] = [{ id: '3', filter: '', sort: '', projection: '{ name: 1 }', at: Date.UTC(2026, 0, 3) }];
    const { tools, calls } = setup({ saved, recent });
    const { text } = await call(tools, 'list_saved_queries', { connection: 'c1', database: 'shop', collection: 'orders' });
    expect(calls.queries).toEqual({ connectionId: 'c1', database: 'shop', collection: 'orders' });
    expect(text).toBe(
      [
        'Queries of shop.orders on Local.',
        '',
        'Saved (2):',
        '- "By city", saved 2026-01-02T00:00:00Z',
        '  pipeline: [ { $match: { a: 1 } }, { $group: { _id: "$city" } } ]',
        '  disabled stages: { $limit: 10 }',
        '- "Active", saved 2026-01-01T00:00:00Z',
        '  filter: { status: "active" }',
        '  sort: { at: -1 }',
        '',
        'Recent (1, newest first):',
        '- run 2026-01-03T00:00:00Z',
        '  projection: { name: 1 }',
      ].join('\n'),
    );
  });

  it('checks the collection exists when nothing is stored', async () => {
    const { tools } = setup();
    expect((await call(tools, 'list_saved_queries', { connection: 'Local', database: 'shop', collection: 'orders' })).text).toBe('No saved or recent queries for shop.orders on Local.');
    const missing = await call(tools, 'list_saved_queries', { connection: 'Local', database: 'shop', collection: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("shop.nope doesn't exist");
  });
});

describe('open tools', () => {
  it('open_watch opens the scope, checking the collection and the deployment', async () => {
    const { tools, calls } = setup();
    expect((await call(tools, 'open_watch', { connection: 'Local', database: 'shop', collection: 'orders' })).text).toBe('Opened the Watch tab on shop.orders of Local.');
    expect(calls.watch).toEqual({ connectionId: 'c1', database: 'shop', collection: 'orders' });
    await call(tools, 'open_watch', { connection: 'Local' });
    expect(calls.watch).toEqual({ connectionId: 'c1' });
    expect((await call(tools, 'open_watch', { connection: 'Local', database: 'shop', collection: 'nope' })).isError).toBe(true);
    expect((await call(tools, 'open_watch', { connection: 'Local', collection: 'orders' })).text).toBe('collection needs database.');
    const standalone = setup({ standalone: true });
    expect((await call(standalone.tools, 'open_watch', { connection: 'Local', database: 'shop' })).text).toContain('The server is a standalone');
  });

  it('open_monitor opens a section', async () => {
    const { tools, calls } = setup();
    expect((await call(tools, 'open_monitor', { connection: 'Prod', section: 'slow-queries' })).text).toBe('Opened the server monitor of Prod on slow-queries.');
    expect(calls.monitor).toEqual({ id: 'c2', section: 'slow-queries' });
    expect((await call(tools, 'open_monitor', { connection: 'Prod', section: 'nope' })).isError).toBe(true);
  });

  it('open_explain opens a find query or a pipeline with explain', async () => {
    const { tools, calls } = setup();
    const find = await call(tools, 'open_explain', { connection: 'Local', database: 'shop', collection: 'orders', filter: '{ a: 1 }', sort: '{ b: -1 }' });
    expect(find.text).toBe('Opened shop.orders on Local with the filter { a: 1 }, sort { b: -1 } and its explain plan.');
    expect(calls.query).toEqual({ connectionId: 'c1', database: 'shop', collection: 'orders', query: { filter: '{ a: 1 }', sort: '{ b: -1 }', projection: '' }, explain: true });
    const agg = await call(tools, 'open_explain', { connection: 'Local', database: 'shop', collection: 'orders', pipeline: '[{ $match: { a: 1 } }, { $count: "n" }]' });
    expect(agg.text).toContain('2 stages ($match, $count)');
    expect(calls.query?.query.pipeline?.map((s) => s.op)).toEqual(['$match', '$count']);
    expect(calls.query?.explain).toBe(true);
    expect((await call(tools, 'open_explain', { connection: 'Local', database: 'shop', collection: 'orders', pipeline: '[{ $out: "x" }]' })).isError).toBe(true);
    expect((await call(tools, 'open_explain', { connection: 'Local', database: 'shop', collection: 'orders', filter: '{}', pipeline: '[{ $match: {} }]' })).isError).toBe(true);
    expect((await call(tools, 'open_explain', { connection: 'Local', database: 'shop', collection: 'nope' })).isError).toBe(true);
  });

  it('open_history opens the Undo History tab', async () => {
    const { tools, calls } = setup({ history: [entry({ id: 'a', time: 0 })], enabled: false });
    expect((await call(tools, 'open_history')).text).toBe('Opened the Undo History tab (1 write recorded; the history is off, new writes are not recorded).');
    expect(calls.history).toBe(true);
  });
});
