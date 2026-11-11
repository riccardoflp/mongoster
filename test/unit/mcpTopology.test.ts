// The text of the topology MCP tools that needs no server: sizes, durations, and a sharded cluster's
// status (hand-made, since the integration tests have no mongos).
import { describe, expect, it } from 'vitest';
import type { ShardingEvent, ShardingStatus } from '../../src/shared/messages';
import { formatBytes, formatDuration, formatShardingStatus } from '../../src/mcp/topology';

const MB = 1024 * 1024;

describe('formatBytes and formatDuration', () => {
  it('writes sizes with a unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(300 * MB)).toBe('300 MB');
    expect(formatBytes(undefined)).toBe('?');
  });

  it('writes durations in days, hours and minutes', () => {
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(3 * 60 + 5)).toBe('3m');
    expect(formatDuration(2 * 3600 + 60)).toBe('2h 1m');
    expect(formatDuration(86400 + 2 * 3600 + 3 * 60)).toBe('1d 2h 3m');
  });
});

describe('formatShardingStatus', () => {
  const cluster: ShardingStatus = {
    kind: 'mongos',
    version: '7.0.2',
    configServer: 'cfg/c1:27019,c2:27019',
    routers: { active: 2, total: 3 },
    balancer: { mode: 'full', running: false, chunkSize: 128, window: { start: '23:00', stop: '06:00' } },
    migrations: { done: 12, failed: 1, failedRounds: 0 },
    shards: [
      { name: 'sh1', host: 'sh1/a:27018,b:27018', replSet: 'sh1', members: ['a:27018', 'b:27018'], state: 1, tags: ['EU'], chunks: 10, dataSize: 900 * MB, documents: 9000, primaryOf: ['shop'], raw: {} },
      { name: 'sh2', host: 'sh2/c:27018', replSet: 'sh2', members: ['c:27018'], state: 1, draining: true, tags: [], chunks: 2, dataSize: 100 * MB, documents: 1000, primaryOf: [], raw: {} },
    ],
    collections: [
      {
        ns: 'shop.orders',
        key: '{ customerId: "hashed" }',
        unique: false,
        balancing: true,
        chunks: { sh1: 8, sh2: 2 },
        totalChunks: 10,
        jumbo: 1,
        data: { sh1: { size: 800 * MB, count: 8000 }, sh2: { size: 100 * MB, count: 1000 } },
        balancerCompliant: false,
        violation: 'chunksImbalance',
        zones: [{ zone: 'EU', min: '{ customerId: MinKey }', max: '{ customerId: 0 }' }],
        raw: {},
      },
      { ns: 'shop.logs', key: '{ _id: 1 }', unique: true, balancing: false, chunks: { sh1: 2 }, totalChunks: 2, jumbo: 0, zones: [], raw: {} },
    ],
    zones: ['EU'],
    errors: ['balancer status of the collections (balancerCollectionStatus, clusterManager role): not authorized'],
    at: 0,
  };
  const event = (time: string, what: string, error?: boolean): ShardingEvent => ({ key: time, time, what, ns: 'shop.orders', shard: 'sh1', summary: 'sh1 → sh2', error, raw: {} });

  it('lists shards, sharded collections, the balancer, events with failures first, and what could not be read', () => {
    const events = [event('2026-01-02T00:00:00Z', 'moveChunk.commit'), event('2026-01-01T00:00:00Z', 'moveChunk.error', true)];
    const text = formatShardingStatus(cluster, events);
    expect(text).toContain('Sharded cluster (mongos 7.0.2), config servers cfg/c1:27019,c2:27019, 2 of 3 mongos routers active');
    expect(text).toContain('Balancer: enabled, no round running now, active window 23:00–06:00, chunk size 128 MB.');
    expect(text).toContain('Last 24 hours: 12 migrations done, 1 failed.');
    expect(text).toContain('- sh1 (replica set sh1: a:27018, b:27018): 10 chunks, 900 MB of sharded data, 9,000 documents, zones EU, primary shard of shop');
    expect(text).toContain('- sh2 (replica set sh2: c:27018): DRAINING, 2 chunks');
    expect(text).toContain(
      '- shop.orders: key { customerId: "hashed" }; balancing on; 10 chunks (sh1 8, sh2 2); 1 JUMBO; data sh1 800 MB / 8,000 docs (89%), sh2 100 MB / 1,000 docs (11%); NOT BALANCED (uneven chunks); zones EU [{ customerId: MinKey } → { customerId: 0 })',
    );
    expect(text).toContain('- shop.logs: key { _id: 1 } unique; BALANCING OFF; 2 chunks (sh1 2)');
    const failed = text.indexOf('FAILED moveChunk.error');
    expect(failed).toBeGreaterThan(0);
    expect(failed).toBeLessThan(text.indexOf('moveChunk.commit'));
    expect(text).toContain('failures first (1 failed)');
    expect(text).toMatch(/Could not be read .+:\n- balancer status of the collections/);
  });

  it('says when the balancer is disabled, and when the events could not be read', () => {
    const text = formatShardingStatus({ ...cluster, balancer: { mode: 'off' }, errors: [] }, undefined, 'not authorized (needs the clusterMonitor role)');
    expect(text).toContain('Balancer: DISABLED.');
    expect(text).toContain('- could not be read: not authorized (needs the clusterMonitor role)');
    expect(text).not.toContain('Could not be read');
  });

  it('judges the balance from the data when the balancer status is unknown', () => {
    const coll = { ...cluster.collections![0], balancerCompliant: undefined, violation: undefined };
    const shards = cluster.shards!.map((s) => ({ ...s, draining: undefined }));
    expect(formatShardingStatus({ ...cluster, shards, collections: [coll] })).toContain('UNEVEN (the largest shard holds 89% of the data)');
  });

  it('says what a server that is not a mongos is', () => {
    expect(formatShardingStatus({ kind: 'standalone', me: 'h:1', errors: [], at: 0 })).toBe('h:1 is a standalone server: it is not a sharded cluster.');
    expect(formatShardingStatus({ kind: 'replicaSet', me: 'h:1', errors: [], at: 0 })).toContain('is a replica set member, not a mongos');
    expect(formatShardingStatus({ kind: 'shardMember', me: 'h:1', shardName: 'config', errors: [], at: 0 })).toContain('is a config server of a sharded cluster');
    expect(formatShardingStatus({ kind: 'shardMember', me: 'h:1', shardName: 'sh1', configServer: 'cfg/c:1', errors: [], at: 0 })).toContain(
      'is a member of the shard sh1 of a sharded cluster (config servers cfg/c:1)',
    );
  });
});
