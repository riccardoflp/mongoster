// Sharded cluster status read through a mongos: shards, sharded collections with their chunks, data and
// zones, the balancer and its recent events (config.changelog, config.actionlog); starting and stopping
// the balancer. No vscode dependency: the monitor asks for confirmations.
import { BSON, Document, MongoClient } from 'mongodb';
import type { ShardInfo, ShardedCollectionInfo, ShardingEvent, ShardingStatus, ShardZoneRange } from './shared/messages';
import { isPlainObject, relaxEjson, toShell } from './shared/query';

const { EJSON } = BSON;

/** Collections whose balancer status (and data per shard, without $shardedDataDistribution) are read: one command each. */
const PER_COLLECTION_LIMIT = 100;
const PARALLEL = 8;
const MAX_TIME_MS = 15_000;
const DAY_MS = 86_400_000;
/** A router that hasn't pinged the config servers for this long is considered gone. */
const ROUTER_PING_MS = 60_000;
const SUMMARY_MAX = 300;
/** Changelog entries about migrations, splits, merges and the balancer. */
const BALANCER_EVENTS = '^(moveChunk|moveRange|split|multi-split|merge|autoMerge|balancer|rangeDeletion|cleanUpOrphaned)';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (isPlainObject(v) ? v : {});
const relaxed = (v: unknown) => relaxEjson(EJSON.serialize(v, { relaxed: false }));
/** The error without the command that some servers append to it ("not authorized on config to execute command { … }"). */
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/ to execute command \{[\s\S]*$/, '');
const clip = (text: string, max = SUMMARY_MAX) => (text.length > max ? `${text.slice(0, max)}…` : text);
const num = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : Number(v));
/** Collection and chunk UUIDs as comparable text. */
const uuidKey = (v: unknown): string | undefined => (v instanceof BSON.Binary ? v.toString('hex') : v === undefined || v === null ? undefined : String(v));
const errorCode = (err: unknown): number | undefined => (err && typeof err === 'object' && 'code' in err ? Number((err as { code: unknown }).code) : undefined);

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

/** A shard key in mongosh syntax: { customerId: 1, _id: "hashed" }. */
export function formatShardKey(key: unknown): string {
  return toShell(relaxed(key ?? {}));
}

/** "rs/host1:27017,host2:27017" → the replica set and its members ("host:port" alone for a standalone shard). */
export function parseShardHost(host: string): { replSet?: string; members: string[] } {
  const slash = host.indexOf('/');
  const list = slash >= 0 ? host.slice(slash + 1) : host;
  return { replSet: slash >= 0 ? host.slice(0, slash) : undefined, members: list.split(',').filter(Boolean) };
}

/**
 * The state of the cluster. On a server that isn't a mongos only its kind (standalone, replica set, or a
 * member of a shard or of the config servers). `full`: also the commands run once per collection (balancer
 * status, and data per shard when $shardedDataDistribution is not available).
 */
export async function shardingStatus(client: MongoClient, full = true): Promise<ShardingStatus> {
  const admin = client.db('admin');
  const config = client.db('config');
  const hello = await admin.command({ hello: 1 });
  const status: ShardingStatus = { kind: 'mongos', errors: [], at: Date.now() };
  if (hello.msg !== 'isdbgrid') {
    status.me = hello.me;
    status.kind = hello.setName ? 'replicaSet' : 'standalone';
    if (hello.configsvr) {
      status.kind = 'shardMember';
      status.shardName = 'config';
    } else if (hello.setName) {
      try {
        const st = await admin.command({ shardingState: 1 });
        if (st.enabled) {
          status.kind = 'shardMember';
          status.shardName = st.shardName;
          status.configServer = st.configServer;
        }
      } catch {
        // Not allowed: shown as a replica set.
      }
    }
    return status;
  }

  const since = new Date(Date.now() - DAY_MS);
  const settled = await Promise.allSettled([
    admin.command({ buildInfo: 1 }),
    admin.command({ listShards: 1 }),
    admin.command({ balancerStatus: 1 }),
    config.collection('settings').find({}).toArray(),
    config.collection('collections').find({ dropped: { $ne: true } }).sort({ _id: 1 }).toArray(),
    config
      .collection('chunks')
      .aggregate([{ $group: { _id: { uuid: '$uuid', ns: '$ns', shard: '$shard' }, n: { $sum: 1 }, jumbo: { $sum: { $cond: [{ $eq: ['$jumbo', true] }, 1, 0] } } } }], { maxTimeMS: MAX_TIME_MS })
      .toArray(),
    config.collection('tags').find({}).sort({ ns: 1, min: 1 }).toArray(),
    config.collection('databases').find({}, { projection: { primary: 1 } }).toArray(),
    admin.command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, opcounters: 0, opcountersRepl: 0, network: 0, connections: 0, mem: 0, extra_info: 0 }),
    config
      .collection('changelog')
      .aggregate(
        [
          { $match: { time: { $gte: since }, what: { $in: ['moveChunk.commit', 'moveChunk.from', 'moveChunk.error'] } } },
          { $group: { _id: { what: '$what', ok: { $eq: ['$details.note', 'success'] } }, n: { $sum: 1 } } },
        ],
        { maxTimeMS: MAX_TIME_MS },
      )
      .toArray(),
    config.collection('actionlog').countDocuments({ time: { $gte: since }, $or: [{ 'details.errorOccured': true }, { 'details.errorOccurred': true }] }, { maxTimeMS: MAX_TIME_MS }),
    config.collection('mongos').find({}, { projection: { ping: 1 } }).toArray(),
    admin.aggregate([{ $shardedDataDistribution: {} }], { maxTimeMS: MAX_TIME_MS }).toArray(),
  ]);
  const [build, shardsRes, balancerRes, settingsRes, collsRes, chunksRes, tagsRes, dbsRes, serverRes, migrationsRes, roundsRes, routersRes, distRes] = settled;
  const failed = (label: string, r: PromiseSettledResult<unknown>) => {
    if (r.status === 'rejected') status.errors.push(`${label}: ${message(r.reason)}`);
  };

  if (build.status === 'fulfilled') status.version = build.value.version;
  if (serverRes.status === 'fulfilled') status.configServer = serverRes.value.sharding?.configsvrConnectionString;
  else {
    try {
      status.configServer = (await admin.command({ getShardMap: 1 })).map?.config;
    } catch {
      // Without clusterMonitor: not shown.
    }
  }

  // ---- balancer
  failed('balancer (balancerStatus)', balancerRes);
  failed('settings (config.settings)', settingsRes);
  const settings = settingsRes.status === 'fulfilled' ? settingsRes.value : [];
  const balancerDoc = settings.find((s) => String(s._id) === 'balancer');
  const chunkSizeDoc = settings.find((s) => String(s._id) === 'chunksize');
  if (balancerRes.status === 'fulfilled' || balancerDoc) {
    const b = balancerRes.status === 'fulfilled' ? balancerRes.value : undefined;
    const window = obj(balancerDoc?.activeWindow);
    status.balancer = {
      mode: b?.mode ?? (balancerDoc ? (balancerDoc.stopped || balancerDoc.mode === 'off' ? 'off' : 'full') : undefined),
      running: b?.inBalancerRound,
      rounds: num(b?.numBalancerRounds),
      window: typeof window.start === 'string' && typeof window.stop === 'string' ? { start: window.start, stop: window.stop } : undefined,
      chunkSize: num(chunkSizeDoc?.value) ?? (serverRes.status === 'fulfilled' && serverRes.value.sharding?.maxChunkSizeInBytes ? Number(serverRes.value.sharding.maxChunkSizeInBytes) / 1024 / 1024 : undefined),
      secondaryThrottle: balancerDoc?._secondaryThrottle === undefined ? undefined : balancerDoc._secondaryThrottle !== false,
      waitForDelete: balancerDoc?._waitForDelete === undefined ? undefined : !!balancerDoc._waitForDelete,
      settings: balancerDoc ? relaxed(balancerDoc) : undefined,
    };
  }

  if (migrationsRes.status === 'fulfilled') {
    const count = (what: string, ok?: boolean) => migrationsRes.value.filter((g) => g._id.what === what && (ok === undefined || g._id.ok === ok)).reduce((a, g) => a + Number(g.n), 0);
    // A failed migration can log both moveChunk.error and an aborted moveChunk.from.
    status.migrations = {
      done: count('moveChunk.commit'),
      failed: Math.max(count('moveChunk.error'), count('moveChunk.from', false)),
      failedRounds: roundsRes.status === 'fulfilled' ? roundsRes.value : 0,
    };
  } else failed('migrations (config.changelog)', migrationsRes);

  if (routersRes.status === 'fulfilled') {
    const now = Date.now();
    const pings = routersRes.value.map((r) => (r.ping instanceof Date ? r.ping.getTime() : 0));
    status.routers = { active: pings.filter((p) => now - p < ROUTER_PING_MS).length, total: pings.length };
  }

  // ---- chunks, per collection and per shard
  failed('chunks (config.chunks)', chunksRes);
  const chunkGroups = chunksRes.status === 'fulfilled' ? chunksRes.value : [];
  const chunksPerShard = new Map<string, number>();
  for (const g of chunkGroups) chunksPerShard.set(String(g._id.shard), (chunksPerShard.get(String(g._id.shard)) ?? 0) + Number(g.n));

  // ---- data per collection and shard
  const data = new Map<string, Record<string, { size: number; count: number }>>();
  if (distRes.status === 'fulfilled') {
    for (const d of distRes.value) {
      data.set(
        String(d.ns),
        Object.fromEntries(((d.shards ?? []) as Document[]).map((s) => [String(s.shardName), { size: Number(s.ownedSizeBytes ?? 0), count: Number(s.numOwnedDocuments ?? 0) }])),
      );
    }
  }

  // ---- shards
  failed('shards (listShards)', shardsRes);
  const primaries = new Map<string, string[]>();
  if (dbsRes.status === 'fulfilled') for (const d of dbsRes.value) primaries.set(String(d.primary), [...(primaries.get(String(d.primary)) ?? []), String(d._id)]);

  // ---- collections
  failed('sharded collections (config.collections)', collsRes);
  failed('zones (config.tags)', tagsRes);
  const tags = tagsRes.status === 'fulfilled' ? tagsRes.value : [];
  if (collsRes.status === 'fulfilled') {
    const docs = collsRes.value;
    status.collections = docs.map((c): ShardedCollectionInfo => {
      const ns = String(c._id);
      const uuid = uuidKey(c.uuid);
      const chunks: Record<string, number> = {};
      let jumbo = 0;
      for (const g of chunkGroups) {
        const mine = g._id.uuid !== undefined && g._id.uuid !== null ? uuidKey(g._id.uuid) === uuid : g._id.ns === ns;
        if (!mine) continue;
        chunks[String(g._id.shard)] = (chunks[String(g._id.shard)] ?? 0) + Number(g.n);
        jumbo += Number(g.jumbo);
      }
      const zones: ShardZoneRange[] = tags.filter((t) => t.ns === ns).map((t) => ({ zone: String(t.tag), min: toShell(relaxed(t.min)), max: toShell(relaxed(t.max)) }));
      return {
        ns,
        key: formatShardKey(c.key),
        unique: c.unique === true,
        balancing: c.noBalance !== true,
        chunks,
        totalChunks: Object.values(chunks).reduce((a, n) => a + n, 0),
        jumbo,
        data: data.get(ns),
        zones,
        raw: relaxed(c),
      };
    });

    const colls = status.collections;
    if (full && colls.length) {
      const first = colls.slice(0, PER_COLLECTION_LIMIT);
      // Before 6.0.3: $collStats on the mongos gives one document per shard.
      if (distRes.status === 'rejected') {
        let lastError: unknown;
        await inBatches(first, async (c) => {
          const [database, ...rest] = c.ns.split('.');
          try {
            const per = await client
              .db(database)
              .collection(rest.join('.'))
              .aggregate([{ $collStats: { storageStats: {} } }, { $project: { shard: 1, 'storageStats.size': 1, 'storageStats.count': 1 } }], { maxTimeMS: MAX_TIME_MS })
              .toArray();
            c.data = Object.fromEntries(per.map((s) => [String(s.shard), { size: Number(s.storageStats?.size ?? 0), count: Number(s.storageStats?.count ?? 0) }]));
          } catch (err) {
            lastError = err;
          }
        });
        if (first.every((c) => !c.data)) status.errors.push(`data per shard ($shardedDataDistribution, $collStats): ${message(distRes.reason)}${lastError ? ` · ${message(lastError)}` : ''}`);
        else if (colls.length > first.length) status.dataLimited = first.length;
      }
      let statusError: unknown;
      await inBatches(first, async (c) => {
        try {
          const r = await admin.command({ balancerCollectionStatus: c.ns });
          c.balancerCompliant = r.balancerCompliant === true;
          c.violation = r.firstComplianceViolation;
        } catch (err) {
          statusError = err;
        }
      });
      if (statusError && first.every((c) => c.balancerCompliant === undefined)) status.errors.push(`balancer status of the collections (balancerCollectionStatus, clusterManager role): ${message(statusError)}`);
    }
  }

  if (shardsRes.status === 'fulfilled') {
    const shardData = new Map<string, { size: number; count: number }>();
    for (const c of status.collections ?? []) {
      for (const [shard, d] of Object.entries(c.data ?? {})) {
        const t = shardData.get(shard) ?? { size: 0, count: 0 };
        t.size += d.size;
        t.count += d.count;
        shardData.set(shard, t);
      }
    }
    const known = (status.collections ?? []).some((c) => c.data);
    status.shards = ((shardsRes.value.shards ?? []) as Document[]).map((s): ShardInfo => {
      const name = String(s._id);
      const host = String(s.host ?? '');
      const d = shardData.get(name);
      return {
        name,
        host,
        ...parseShardHost(host),
        state: num(s.state),
        draining: s.draining === true || undefined,
        tags: ((s.tags ?? []) as unknown[]).map(String),
        chunks: chunksRes.status === 'fulfilled' ? chunksPerShard.get(name) ?? 0 : undefined,
        dataSize: known ? d?.size ?? 0 : undefined,
        documents: known ? d?.count ?? 0 : undefined,
        primaryOf: (primaries.get(name) ?? []).sort(),
        raw: relaxed(s),
      };
    });
  }
  status.zones = [...new Set([...(status.shards ?? []).flatMap((s) => s.tags), ...tags.map((t) => String(t.tag))])].sort();
  return status;
}

/** One-line summary of a changelog or actionlog entry, and whether it reports a failure. */
export function shardingEvent(e: Document, action = false): ShardingEvent {
  const r = obj(relaxed(e));
  const d = obj(r.details);
  const what = String(r.what ?? '');
  const range = (min: unknown, max: unknown) => (min === undefined ? '' : `${toShell(min)} → ${toShell(max)}`);
  const parts: string[] = [];
  if (/^(moveChunk|moveRange)/.test(what)) {
    parts.push(range(d.min, d.max));
    if (d.from || d.to) parts.push(`${d.from ?? '?'} → ${d.to ?? '?'}`);
    const counts = obj(d.counts);
    if (counts.cloned !== undefined) parts.push(`${Number(counts.cloned).toLocaleString('en-US')} documents copied`);
    if (d.note && d.note !== 'success') parts.push(String(d.note));
  } else if (what === 'split') {
    const left = obj(d.left);
    parts.push(left.max !== undefined ? `at ${toShell(left.max)}` : '', range(obj(d.before).min, obj(d.before).max));
  } else if (what === 'multi-split') {
    const chunk = obj(d.chunk);
    parts.push(`${d.number ?? '?'} of ${d.of ?? '?'}`, range(chunk.min, chunk.max));
  } else if (what === 'balancer.round') {
    if (d.chunksMoved !== undefined) parts.push(`${d.chunksMoved} chunk${Number(d.chunksMoved) === 1 ? '' : 's'} moved`);
    if (d.candidateChunks !== undefined) parts.push(`${d.candidateChunks} candidate${Number(d.candidateChunks) === 1 ? '' : 's'}`);
    if (d.executionTimeMillis !== undefined) parts.push(`${d.executionTimeMillis} ms`);
  } else if (Object.keys(d).length) {
    parts.push(toShell(d));
  }
  const errmsg = d.errmsg ?? d.errMsg ?? d.error;
  if (errmsg) parts.push(typeof errmsg === 'string' ? errmsg : toShell(errmsg));
  const error = what.endsWith('.error') || !!errmsg || (/^moveChunk\.(from|to)$/.test(what) && !!d.note && d.note !== 'success') || d.errorOccured === true || d.errorOccurred === true;
  const time = obj(r.time).$date;
  return {
    key: String(toShell(r._id)),
    time: typeof time === 'string' ? time : typeof time === 'number' ? new Date(time).toISOString() : '',
    what,
    ns: String(r.ns ?? ''),
    shard: (r.shard as string) || (r.server as string) || undefined,
    summary: clip(parts.filter(Boolean).join(' · ')),
    error: error || undefined,
    action: action || undefined,
    raw: r,
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The most recent events, newest first: config.changelog, with the balancer rounds of config.actionlog. */
export async function shardingEvents(client: MongoClient, scope: 'balancer' | 'all', ns: string, limit: number): Promise<ShardingEvent[]> {
  const config = client.db('config');
  const filter: Document = {};
  if (scope === 'balancer') filter.what = { $regex: BALANCER_EVENTS };
  const name = ns.trim();
  if (name) filter.ns = name.includes('.') ? name : { $regex: `^${escapeRegex(name)}\\.` };
  const [changes, actions] = await Promise.all([
    config.collection('changelog').find(filter, { sort: { time: -1 }, limit, maxTimeMS: MAX_TIME_MS }).toArray(),
    // Balancer rounds aren't about one collection.
    name ? Promise.resolve([]) : config.collection('actionlog').find({}, { sort: { time: -1 }, limit, maxTimeMS: MAX_TIME_MS }).toArray(),
  ]).catch((err) => {
    throw new Error(`config.changelog: ${message(err)}`);
  });
  return [...changes.map((e) => shardingEvent(e)), ...actions.map((e) => shardingEvent(e, true))].sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
}

export async function setBalancer(client: MongoClient, enabled: boolean): Promise<void> {
  await client.db('admin').command(enabled ? { balancerStart: 1 } : { balancerStop: 1 });
}

/**
 * Enables or disables balancing of a collection: configureCollectionBalancing with enableBalancing, or the
 * noBalance field of config.collections on servers without that option. Returns how it was done.
 */
export async function setCollectionBalancing(client: MongoClient, ns: string, enabled: boolean): Promise<string> {
  try {
    await client.db('admin').command({ configureCollectionBalancing: ns, enableBalancing: enabled });
    return 'configureCollectionBalancing';
  } catch (err) {
    // 40415: unknown field (enableBalancing), 59: unknown command.
    if (![40415, 59].includes(errorCode(err) ?? 0)) throw err;
  }
  const res = await client.db('config').collection<{ _id: string; noBalance?: boolean }>('collections').updateOne({ _id: ns }, { $set: { noBalance: !enabled } });
  if (!res.matchedCount) throw new Error(`${ns} is not a sharded collection.`);
  return 'config.collections (noBalance)';
}
