// The MCP tools about the deployment rather than its data: the server's status (serverStatus, hello),
// database and collection sizes (dbStats, $collStats), the replica set with its oplog window, and the
// sharded cluster (shards, sharded collections, balancer, recent changelog events). Read only: they
// never step down a primary or start / stop the balancer. No vscode dependency.
import { BSON, Db, Document, MongoClient } from 'mongodb';
import type { ReplMember, ShardedCollectionInfo, ShardingEvent, ShardingStatus } from '../shared/messages';
import { McpTool, ToolError, intArg, stringArg, truncate } from '../shared/mcp';
import { relaxEjson, toShell } from '../shared/query';
import { helloMembers, oplogEntry, replMembers } from '../replication';
import { shardingEvents, shardingStatus } from '../sharding';
import { MAX_OUTPUT, MAX_TIME_MS, ToolContext, connectionProp, message, plural } from './context';

const { EJSON } = BSON;
/** Databases and collections whose statistics are read in parallel. */
const PARALLEL = 8;

const relaxed = (v: unknown) => relaxEjson(EJSON.serialize(v, { relaxed: false }));
const num = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : Number(v));
const count = (n: number | undefined) => (n === undefined ? '?' : n.toLocaleString('en-US'));
const percent = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '0%');

/** Missing a privilege: the server says "not authorized" / "Unauthorized" (code 13). */
const isDenied = (err: unknown) => (err as { code?: unknown })?.code === 13 || /not authorized|unauthorized|requires authentication/i.test(message(err));
/** The error, with the role to ask for when it is a missing privilege. */
const failure = (err: unknown, role: string) => `${message(err).replace(/ to execute command \{[\s\S]*$/, '')}${isDenied(err) ? ` (needs ${role})` : ''}`;

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

/** 1536 → "1.5 KB". */
export function formatBytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** 93784 → "1d 2h 3m"; under a minute in seconds. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds)) return '?';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : '', d || h ? `${h}h` : '', `${m}m`].filter(Boolean).join(' ');
}

/** The tools of this group. */
export function topologyTools(ctx: ToolContext): McpTool[] {
  const { connection, client } = ctx;
  const connectionOnly = { type: 'object' as const, properties: { connection: connectionProp }, required: ['connection'], additionalProperties: false };

  return [
    {
      name: 'server_status',
      title: 'Server status',
      description:
        'The state of the server a connection points to: version, topology (standalone, replica set member and its state, mongos), uptime, storage engine, connections, operation counters, network, memory, WiredTiger cache, global lock queues, asserts and transactions. Use it to see whether the server is overloaded or misconfigured when debugging an application.',
      inputSchema: connectionOnly,
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const admin = (await client(info)).db('admin');
        const hello = await admin.command({ hello: 1 });
        let s: Document | undefined;
        const notes: string[] = [];
        try {
          s = await admin.command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, maxTimeMS: MAX_TIME_MS });
        } catch (err) {
          notes.push(`serverStatus could not be read: ${failure(err, 'the clusterMonitor role')}. Only what hello and buildInfo tell is shown.`);
        }
        let version = s?.version as string | undefined;
        if (!version) version = await admin.command({ buildInfo: 1 }).then((b) => b.version as string, () => undefined);

        const mongos = hello.msg === 'isdbgrid' || s?.process === 'mongos';
        const host = (s?.host as string | undefined) ?? (hello.me as string | undefined) ?? info.name;
        const lines = [
          `Server ${host} (${mongos ? 'mongos' : 'mongod'} ${version ?? 'unknown version'})${s ? `, up ${formatDuration(num(s.uptime))}` : ''}${s?.storageEngine?.name ? `, storage engine ${s.storageEngine.name}` : ''}.`,
          `Topology: ${topology(hello, s)}.`,
        ];
        if (s) {
          const c = s.connections ?? {};
          lines.push(
            `Connections: ${count(num(c.current))} current, ${count(num(c.available))} available${c.active !== undefined ? `, ${count(num(c.active))} active` : ''}${c.totalCreated !== undefined ? `, ${count(num(c.totalCreated))} created since startup` : ''}.`,
          );
          const counters = (o: Document | undefined) => ['insert', 'query', 'update', 'delete', 'getmore', 'command'].map((k) => `${k} ${count(num(o?.[k]) ?? 0)}`).join(', ');
          if (s.opcounters) lines.push(`Operations since startup (opcounters): ${counters(s.opcounters)}.`);
          if (s.opcountersRepl && hello.setName) lines.push(`Replicated operations applied (opcountersRepl): ${counters(s.opcountersRepl)}.`);
          if (s.network) lines.push(`Network since startup: ${formatBytes(num(s.network.bytesIn))} in, ${formatBytes(num(s.network.bytesOut))} out, ${count(num(s.network.numRequests))} requests.`);
          // serverStatus gives memory in MB.
          if (s.mem) lines.push(`Memory: ${formatBytes((num(s.mem.resident) ?? 0) * 1024 * 1024)} resident, ${formatBytes((num(s.mem.virtual) ?? 0) * 1024 * 1024)} virtual.`);
          const cache = s.wiredTiger?.cache as Document | undefined;
          if (cache) {
            const max = num(cache['maximum bytes configured']) ?? 0;
            const used = num(cache['bytes currently in the cache']) ?? 0;
            const dirty = num(cache['tracked dirty bytes in the cache']) ?? 0;
            lines.push(`WiredTiger cache: ${formatBytes(used)} used (${percent(used, max)}), ${formatBytes(dirty)} dirty (${percent(dirty, max)}), of ${formatBytes(max)} configured.`);
          }
          const g = s.globalLock as Document | undefined;
          if (g) {
            const rw = (o: Document | undefined) => `${count(num(o?.total) ?? 0)} (${count(num(o?.readers) ?? 0)} readers, ${count(num(o?.writers) ?? 0)} writers)`;
            lines.push(`Global lock: queued ${rw(g.currentQueue)}; active clients ${rw(g.activeClients)}.`);
          }
          if (s.asserts) lines.push(`Asserts since startup: ${Object.entries(s.asserts as Document).map(([k, v]) => `${k} ${count(num(v))}`).join(', ')}.`);
          const t = s.transactions as Document | undefined;
          if (t && (t.currentOpen !== undefined || t.totalStarted !== undefined)) {
            lines.push(
              `Transactions: ${count(num(t.currentOpen) ?? 0)} open (${count(num(t.currentActive) ?? 0)} active, ${count(num(t.currentInactive) ?? 0)} inactive${t.currentPrepared !== undefined ? `, ${count(num(t.currentPrepared))} prepared` : ''}); since startup ${count(num(t.totalStarted) ?? 0)} started, ${count(num(t.totalCommitted) ?? 0)} committed, ${count(num(t.totalAborted) ?? 0)} aborted.`,
            );
          }
        }
        return truncate([...lines, ...notes.map((n) => `Note: ${n}`)].join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'database_stats',
      title: 'Database statistics',
      description:
        'Sizes from dbStats: for every database (or the one given) its collections, views, documents, data size, storage size, indexes and index size, largest first. With a database, also each collection: documents, data size, storage size and index size, largest first. Use it to find what takes space or which collections are large.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: { type: 'string', description: 'One database (also lists its collections); every database when omitted.' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Databases, or collections of the database, listed.' },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = stringArg(args, 'database');
        const limit = intArg(args, 'limit', 50, 1, 1000);
        const mc = await client(info);
        const names = (await mc.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
        if (database && !names.includes(database)) throw new ToolError(`The database ${database} doesn't exist on ${info.name}: use list_databases.`);
        const stats = await inBatches(database ? [database] : names, (name) => databaseStats(mc, name));
        const onDisk = (d: DbStats) => (d.storageSize ?? 0) + (d.indexSize ?? 0);
        stats.sort((a, b) => onDisk(b) - onDisk(a));
        const lines = database
          ? []
          : [`${plural(stats.length, 'database')} on ${info.name}, largest on disk (storage + indexes) first${stats.length > limit ? `; the first ${limit}` : ''}:`];
        lines.push(...stats.slice(0, limit).map(dbLine));
        if (!database && stats.length > 1) {
          const sum = (k: keyof DbStats) => stats.reduce((a, d) => a + (typeof d[k] === 'number' ? (d[k] as number) : 0), 0);
          lines.push(`Total: ${count(sum('objects'))} documents, data ${formatBytes(sum('dataSize'))}, storage ${formatBytes(sum('storageSize'))}, indexes ${formatBytes(sum('indexSize'))}.`);
        }
        if (database) lines.push('', ...(await collectionLines(mc.db(database), limit)));
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'replica_set_status',
      title: 'Replica set status',
      description:
        "The replica set of a connection: its name, the primary, every member (state, health, uptime, last applied operation and lag behind the primary in seconds, last heartbeat, ping, sync source, priority, votes, hidden, arbiter, delay, tags) and the oplog window (first and last entry, hours covered, used and configured size). Use it when writes fail, reads are stale, or a member falls behind. On a standalone server or a mongos it says so.",
      inputSchema: connectionOnly,
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const mc = await client(info);
        const admin = mc.db('admin');
        const hello = await admin.command({ hello: 1 });
        const me = (hello.me as string | undefined) ?? info.name;
        if (hello.msg === 'isdbgrid') return `${info.name} is a mongos (a sharded cluster's router), not a replica set member: use sharding_status for the shards, or connect to a shard's replica set to see its members.`;
        if (!hello.setName) return `${me} is a standalone server, not a replica set member: there are no members, no replication and no oplog.`;

        const notes: string[] = [];
        const [st, conf] = await Promise.allSettled([admin.command({ replSetGetStatus: 1, maxTimeMS: MAX_TIME_MS }), admin.command({ replSetGetConfig: 1, maxTimeMS: MAX_TIME_MS })]);
        let members: ReplMember[];
        let term: number | undefined;
        let settings: Document = {};
        if (st.status === 'fulfilled') {
          const config = conf.status === 'fulfilled' ? (conf.value.config as Document) : undefined;
          if (conf.status === 'rejected') notes.push(`replSetGetConfig: ${failure(conf.reason, 'the clusterMonitor role')}: priority, votes, hidden, delay and tags are missing.`);
          members = replMembers(relaxed(st.value.members) as unknown[], (relaxed(config?.members ?? []) as unknown[]) ?? []);
          term = num(st.value.term);
          settings = { ...(config?.settings ?? {}), protocolVersion: config?.protocolVersion };
        } else {
          notes.push(`replSetGetStatus: ${failure(st.reason, 'the clusterMonitor role')}. Members are from hello alone: only names and which one is the primary, without health, lag or heartbeats.`);
          members = helloMembers(hello);
        }

        const lines = [
          `Replica set ${hello.setName}${term !== undefined ? `, term ${term}` : ''}, connected to ${me}. Primary: ${hello.primary ?? 'none (no primary: writes fail until one is elected)'}.`,
          '',
          `Members (${members.length}):`,
          ...members.map(memberLine),
        ];
        const s = settings;
        const settingsText = [
          s.electionTimeoutMillis !== undefined ? `election timeout ${count(num(s.electionTimeoutMillis))} ms` : '',
          s.heartbeatIntervalMillis !== undefined ? `heartbeat every ${count(num(s.heartbeatIntervalMillis))} ms` : '',
          s.chainingAllowed !== undefined ? `chaining ${s.chainingAllowed ? 'allowed' : 'not allowed'}` : '',
          s.protocolVersion !== undefined ? `protocol version ${num(s.protocolVersion)}` : '',
        ].filter(Boolean);
        if (settingsText.length) lines.push(`Settings: ${settingsText.join(', ')}.`);
        lines.push('', await oplogLine(mc));
        return truncate([...lines, ...notes.map((n) => `Note: ${n}`)].join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'sharding_status',
      title: 'Sharding status',
      description:
        'The sharded cluster behind a mongos: shards (state, draining, zones, chunks, data, documents, primary of which databases), sharded collections (shard key, balancing on or off, chunks and data per shard, imbalance, jumbo chunks, zones), the balancer (enabled, running, migrations in the last 24 hours) and the most recent changelog events, failures first. Read only: it never starts or stops the balancer. On a server that is not a mongos it says what it is.',
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, events: { type: 'integer', minimum: 0, maximum: 100, default: 20, description: 'Recent changelog / balancer events listed.' } },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const limit = intArg(args, 'events', 20, 0, 100);
        const mc = await client(info);
        const status = await shardingStatus(mc, true);
        let events: ShardingEvent[] | undefined;
        let eventsError: string | undefined;
        if (status.kind === 'mongos' && limit) {
          try {
            events = await shardingEvents(mc, 'all', '', limit);
          } catch (err) {
            eventsError = failure(err, 'the clusterMonitor role (read on the config database)');
          }
        }
        return truncate(formatShardingStatus(status, events, eventsError), MAX_OUTPUT);
      },
    },
  ];
}

/** The topology from hello (and serverStatus): standalone, replica set member and its state, mongos. */
function topology(hello: Document, s: Document | undefined): string {
  if (hello.msg === 'isdbgrid' || s?.process === 'mongos') return 'mongos (router of a sharded cluster): use sharding_status for the shards';
  const shard = s?.sharding?.configsvrConnectionString as string | undefined;
  const cluster = hello.configsvr ? ', a config server of a sharded cluster' : shard ? `, a shard of a sharded cluster (config servers ${shard})` : '';
  if (!hello.setName) return `standalone server${cluster}`;
  const state = hello.isWritablePrimary || hello.ismaster ? 'PRIMARY' : hello.secondary ? 'SECONDARY' : hello.arbiterOnly ? 'ARBITER' : 'neither primary nor secondary (starting up, recovering or removed)';
  const extra = [hello.hidden ? 'hidden' : '', hello.passive ? 'passive' : '', hello.secondaryDelaySecs ? `delayed ${hello.secondaryDelaySecs} s` : ''].filter(Boolean).join(', ');
  return `member of the replica set ${hello.setName}${cluster}, state ${state}${extra ? ` (${extra})` : ''}; primary ${hello.primary ?? 'none'}, ${plural(((hello.hosts as string[]) ?? []).length, 'electable member')}${hello.arbiters?.length ? `, ${plural(hello.arbiters.length, 'arbiter')}` : ''}`;
}

interface DbStats {
  name: string;
  collections?: number;
  views?: number;
  objects?: number;
  dataSize?: number;
  storageSize?: number;
  indexes?: number;
  indexSize?: number;
  error?: string;
}

async function databaseStats(client: MongoClient, name: string): Promise<DbStats> {
  try {
    const s = await client.db(name).command({ dbStats: 1, maxTimeMS: MAX_TIME_MS });
    return {
      name,
      collections: num(s.collections),
      views: num(s.views),
      objects: num(s.objects),
      dataSize: num(s.dataSize),
      storageSize: num(s.storageSize),
      indexes: num(s.indexes),
      indexSize: num(s.indexSize),
    };
  } catch (err) {
    return { name, error: failure(err, 'the dbStats privilege on the database, e.g. the dbAdmin or clusterMonitor role') };
  }
}

const dbLine = (d: DbStats) =>
  d.error
    ? `- ${d.name}: could not be read: ${d.error}`
    : `- ${d.name}: ${plural(d.collections ?? 0, 'collection')}${d.views ? `, ${plural(d.views, 'view')}` : ''}, ${plural(d.objects ?? 0, 'document')}, data ${formatBytes(d.dataSize)}, storage ${formatBytes(d.storageSize)}, ${count(d.indexes ?? 0)} ${d.indexes === 1 ? 'index' : 'indexes'} ${formatBytes(d.indexSize)}`;

/** The collections of a database with their sizes ($collStats), largest first, and its views. */
async function collectionLines(db: Db, limit: number): Promise<string[]> {
  const infos = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c) => !c.name.startsWith('system.'));
  const views = infos.filter((c) => c.type === 'view').map((c) => c.name).sort();
  const colls = infos.filter((c) => c.type !== 'view');
  const stats = await inBatches(colls, async (c) => {
    try {
      const [s] = await db
        .collection(c.name)
        .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: MAX_TIME_MS })
        .toArray();
      const st = (s?.storageStats ?? {}) as Document;
      return { name: c.name, count: num(st.count), size: num(st.size), storage: num(st.storageSize), indexes: num(st.nindexes), indexSize: num(st.totalIndexSize), capped: st.capped === true };
    } catch (err) {
      return { name: c.name, error: failure(err, 'the collStats privilege, e.g. the dbAdmin or clusterMonitor role') };
    }
  });
  stats.sort((a, b) => ('size' in b ? (b.size ?? 0) : -1) - ('size' in a ? (a.size ?? 0) : -1) || a.name.localeCompare(b.name));
  if (!stats.length && !views.length) return [`${db.databaseName} has no collections.`];
  const lines = [`Collections of ${db.databaseName} (${stats.length}), largest data first${stats.length > limit ? `; the first ${limit}` : ''}:`];
  for (const c of stats.slice(0, limit)) {
    lines.push(
      'error' in c
        ? `- ${c.name}: could not be read: ${c.error}`
        : `- ${c.name}${c.capped ? ' (capped)' : ''}: ${plural(c.count ?? 0, 'document')}, data ${formatBytes(c.size)}, storage ${formatBytes(c.storage)}, ${c.indexes ?? '?'} ${c.indexes === 1 ? 'index' : 'indexes'} ${formatBytes(c.indexSize)}`,
    );
  }
  if (views.length) lines.push(`Views (${views.length}): ${views.join(', ')}`);
  return lines;
}

/** A member on one line. */
function memberLine(m: ReplMember): string {
  const parts = [
    m.health === 0 ? 'NOT REACHABLE' : '',
    m.uptime !== undefined ? `up ${formatDuration(m.uptime)}` : '',
    m.optime ? `last applied ${m.optime}` : '',
    m.lag !== undefined && m.state !== 'PRIMARY' ? `lag ${m.lag < 10 ? m.lag.toFixed(1) : Math.round(m.lag)} s behind the primary` : '',
    m.lastHeartbeat ? `last heartbeat ${m.lastHeartbeat}` : '',
    m.pingMs !== undefined ? `ping ${m.pingMs} ms` : '',
    m.syncSource ? `syncs from ${m.syncSource}` : '',
    m.priority !== undefined ? `priority ${m.priority}` : '',
    m.votes !== undefined ? `${m.votes} vote${m.votes === 1 ? '' : 's'}` : '',
    m.hidden ? 'hidden' : '',
    m.arbiter && m.state !== 'ARBITER' ? 'arbiter' : '',
    m.delay ? `delayed ${m.delay} s` : '',
    m.buildIndexes === false ? 'builds no indexes' : '',
    m.tags ? `tags ${toShell(m.tags)}` : '',
    m.message ? `"${m.message}"` : '',
  ].filter(Boolean);
  return `- ${m.name} ${m.state}${m.self ? ' (connected)' : ''}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** The oplog window and size, or why it could not be read. */
async function oplogLine(client: MongoClient): Promise<string> {
  try {
    const oplog = client.db('local').collection('oplog.rs');
    const [[stats], [first], [last]] = await Promise.all([
      oplog.aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: MAX_TIME_MS }).toArray(),
      oplog.find({}, { sort: { $natural: 1 }, limit: 1, projection: { ts: 1, wall: 1 }, maxTimeMS: MAX_TIME_MS }).toArray(),
      oplog.find({}, { sort: { $natural: -1 }, limit: 1, projection: { ts: 1, wall: 1 }, maxTimeMS: MAX_TIME_MS }).toArray(),
    ]);
    const storage = (stats?.storageStats ?? {}) as Document;
    const [from, to] = [first, last].map((e) => (e ? oplogEntry(relaxed(e) as Record<string, unknown>) : undefined));
    if (!from || !to) return 'Oplog: empty.';
    const seconds = Math.max(0, Number(to.key.split(':')[0]) - Number(from.key.split(':')[0]));
    const size = num(storage.size);
    const max = num(storage.maxSize);
    return `Oplog: first entry ${from.time}, last entry ${to.time}: a window of ${(seconds / 3600).toFixed(seconds < 36_000 ? 2 : 1)} hours (a member that falls further behind needs a full resync). ${formatBytes(size)} used${max ? ` of ${formatBytes(max)} configured (${percent(size ?? 0, max)})` : ''}, ${count(num(storage.count) ?? 0)} ${num(storage.count) === 1 ? 'entry' : 'entries'}.`;
  } catch (err) {
    return `Oplog: could not be read: ${failure(err, 'read access to the local database')}.`;
  }
}

const VIOLATIONS: Record<string, string> = { chunksImbalance: 'uneven chunks', zoneViolation: 'zone violation', draining: 'a shard is draining', defragmentingChunks: 'defragmenting chunks' };

/**
 * Whether a collection's data is unevenly spread: the balancer's own verdict when it could be read, otherwise
 * when the most loaded shard has 1.5 times its even share and the gap exceeds the balancer's threshold (3 chunks).
 */
function balanceText(c: ShardedCollectionInfo, s: ShardingStatus): string {
  if (c.balancerCompliant) return 'balanced';
  if (c.balancerCompliant === false) return `NOT BALANCED (${VIOLATIONS[c.violation ?? ''] ?? c.violation ?? 'the balancer has chunks to move or merge'})`;
  const shards = (s.shards ?? []).filter((x) => !x.draining).map((x) => x.name);
  if (!c.data || shards.length < 2) return '';
  const sizes = shards.map((x) => c.data?.[x]?.size ?? 0);
  const total = sizes.reduce((a, n) => a + n, 0);
  const max = Math.max(...sizes);
  const threshold = 3 * (s.balancer?.chunkSize ?? 128) * 1024 * 1024;
  return total > 0 && max >= (1.5 * total) / shards.length && max - Math.min(...sizes) > threshold ? `UNEVEN (the largest shard holds ${percent(max, total)} of the data)` : '';
}

/** What shardingStatus (and the recent events) found, as text for the model. */
export function formatShardingStatus(s: ShardingStatus, events?: ShardingEvent[], eventsError?: string): string {
  const me = s.me ?? 'This server';
  if (s.kind !== 'mongos') {
    return s.kind === 'shardMember'
      ? s.shardName === 'config'
        ? `${me} is a config server of a sharded cluster, not a mongos: connect to a mongos to see the shards, the sharded collections and the balancer.`
        : `${me} is a member of the shard ${s.shardName ?? '?'} of a sharded cluster${s.configServer ? ` (config servers ${s.configServer})` : ''}, not a mongos: connect to a mongos to see the whole cluster.`
      : s.kind === 'replicaSet'
        ? `${me} is a replica set member, not a mongos: it is not a sharded cluster (use replica_set_status).`
        : `${me} is a standalone server: it is not a sharded cluster.`;
  }

  const lines = [
    `Sharded cluster${s.version ? ` (mongos ${s.version})` : ''}${s.configServer ? `, config servers ${s.configServer}` : ''}${s.routers ? `, ${s.routers.active} of ${plural(s.routers.total, 'mongos router')} active in the last minute` : ''}.`,
  ];
  const b = s.balancer;
  if (b) {
    const parts = [
      b.mode === 'off' ? 'Balancer: DISABLED' : `Balancer: enabled${b.mode && b.mode !== 'full' ? ` (mode ${b.mode})` : ''}`,
      b.running === undefined ? '' : b.running ? 'a round is running now' : 'no round running now',
      b.window ? `active window ${b.window.start}–${b.window.stop}` : '',
      b.chunkSize ? `chunk size ${b.chunkSize} MB` : '',
      b.secondaryThrottle === false ? 'secondary throttle off' : '',
      b.waitForDelete ? 'waits for deletes' : '',
    ];
    lines.push(`${parts.filter(Boolean).join(', ')}.`);
  }
  if (s.migrations) {
    const m = s.migrations;
    lines.push(`Last 24 hours: ${plural(m.done, 'migration')} done, ${count(m.failed)} failed${m.failedRounds ? `, ${plural(m.failedRounds, 'balancer round')} with errors` : ''}.`);
  }

  if (s.shards) {
    lines.push('', `Shards (${s.shards.length})${s.zones?.length ? `, zones ${s.zones.join(', ')}` : ''}:`);
    for (const x of s.shards) {
      const parts = [
        x.draining ? 'DRAINING' : '',
        x.state !== undefined && x.state !== 1 ? `NOT ACTIVE (state ${x.state})` : '',
        x.chunks !== undefined ? plural(x.chunks, 'chunk') : '',
        x.dataSize !== undefined ? `${formatBytes(x.dataSize)} of sharded data` : '',
        x.documents !== undefined ? plural(x.documents, 'document') : '',
        x.tags.length ? `zones ${x.tags.join(', ')}` : '',
        x.primaryOf.length ? `primary shard of ${x.primaryOf.join(', ')}` : '',
      ].filter(Boolean);
      lines.push(`- ${x.name} (${x.replSet ? `replica set ${x.replSet}: ` : ''}${x.members.join(', ')})${parts.length ? `: ${parts.join(', ')}` : ''}`);
    }
  }

  if (s.collections) {
    lines.push('', `Sharded collections (${s.collections.length}):`);
    if (!s.collections.length) lines.push('- none');
    for (const c of s.collections) {
      const perShard = Object.entries(c.chunks)
        .sort((a, b) => b[1] - a[1])
        .map(([shard, n]) => `${shard} ${count(n)}`)
        .join(', ');
      const total = c.data ? Object.values(c.data).reduce((a, d) => a + d.size, 0) : 0;
      const data = c.data
        ? Object.entries(c.data)
            .sort((a, b) => b[1].size - a[1].size)
            .map(([shard, d]) => `${shard} ${formatBytes(d.size)} / ${count(d.count)} docs (${percent(d.size, total)})`)
            .join(', ')
        : '';
      const parts = [
        `key ${c.key}${c.unique ? ' unique' : ''}`,
        c.balancing ? 'balancing on' : 'BALANCING OFF',
        `${plural(c.totalChunks, 'chunk')}${perShard ? ` (${perShard})` : ''}`,
        c.jumbo ? `${count(c.jumbo)} JUMBO` : '',
        data ? `data ${data}` : '',
        balanceText(c, s),
        c.zones.length ? `zones ${c.zones.map((z) => `${z.zone} [${z.min} → ${z.max})`).join(', ')}` : '',
      ].filter(Boolean);
      lines.push(`- ${c.ns}: ${parts.join('; ')}`);
    }
    if (s.dataLimited) lines.push(`(data per shard read for the first ${s.dataLimited} collections only)`);
  }

  if (events || eventsError) {
    const sorted = [...(events ?? [])].sort((a, b) => Number(!!b.error) - Number(!!a.error) || b.time.localeCompare(a.time));
    const failed = sorted.filter((e) => e.error).length;
    lines.push('', `Recent events (config.changelog and balancer rounds), failures first${failed ? ` (${failed} failed)` : ''}:`);
    if (eventsError) lines.push(`- could not be read: ${eventsError}`);
    else if (!sorted.length) lines.push('- none');
    for (const e of sorted) lines.push(`- ${e.time} ${e.error ? 'FAILED ' : ''}${e.what}${e.ns ? ` ${e.ns}` : ''}${e.shard ? ` on ${e.shard}` : ''}${e.summary ? `: ${e.summary}` : ''}`);
  }

  if (s.errors.length) lines.push('', 'Could not be read (missing roles, usually clusterMonitor):', ...s.errors.map((e) => `- ${e}`));
  return lines.join('\n');
}
