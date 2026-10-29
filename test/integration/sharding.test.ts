// The sharding section on servers that aren't a sharded cluster: the standalone mongod and the replica set.
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { shardingStatus } from '../../src/sharding';

let client: MongoClient;
beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
});
afterAll(async () => {
  await client?.close();
});

describe('sharding status', () => {
  it('says that a standalone server is not a sharded cluster', async () => {
    const status = await shardingStatus(client);
    expect(status.kind).toBe('standalone');
    expect(status.shards).toBeUndefined();
    expect(status.collections).toBeUndefined();
    expect(status.errors).toEqual([]);
  });

  it('says that a replica set is not a sharded cluster either', async () => {
    const rs = await MongoClient.connect(inject('replSetUri'));
    try {
      const status = await shardingStatus(rs, false);
      expect(status.kind).toBe('replicaSet');
      expect(status.me).toMatch(/:\d+$/);
      expect(status.shards).toBeUndefined();
    } finally {
      await rs.close();
    }
  });
});
