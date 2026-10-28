import { describe, expect, it } from 'vitest';
import { suggestIndex, summarizeExplain } from '../../src/shared/explain';

describe('summarizeExplain', () => {
  it('reports a collection scan with its execution stats', () => {
    const raw = {
      queryPlanner: {
        winningPlan: { stage: 'COLLSCAN', filter: { status: { $eq: 'a' } }, direction: 'forward' },
        rejectedPlans: [],
      },
      executionStats: {
        nReturned: 3,
        executionTimeMillis: 7,
        totalKeysExamined: 0,
        totalDocsExamined: 1000,
        executionStages: { stage: 'COLLSCAN', nReturned: 3, docsExamined: 1000, executionTimeMillisEstimate: 5, filter: { status: { $eq: 'a' } } },
      },
    };
    const s = summarizeExplain(raw);
    expect(s.collscan).toBe(true);
    expect(s.inMemorySort).toBe(false);
    expect(s.indexes).toEqual([]);
    expect(s.nReturned).toBe(3);
    expect(s.totalDocsExamined).toBe(1000);
    expect(s.totalKeysExamined).toBe(0);
    expect(s.executionTimeMillis).toBe(7);
    expect(s.rejectedPlans).toBe(0);
    // The classic execution stages are used: they carry per-stage stats.
    expect(s.plan).toMatchObject({ stage: 'COLLSCAN', docsExamined: 1000, timeMs: 5, children: [] });
    expect(s.plan?.details).toEqual({ filter: { status: { $eq: 'a' } } });
    expect(s.pipeline).toEqual([]);
  });

  it('collects the indexes of nested stages and an in-memory sort', () => {
    const exec = {
      stage: 'SORT',
      sortPattern: { b: -1 },
      nReturned: 2,
      inputStage: {
        stage: 'FETCH',
        inputStage: {
          stage: 'OR',
          inputStages: [
            { stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 }, keysExamined: 4 },
            { stage: 'IXSCAN', indexName: 'c_1', keyPattern: { c: 1 }, keysExamined: 6 },
          ],
        },
      },
    };
    const s = summarizeExplain({
      queryPlanner: { winningPlan: exec, rejectedPlans: [{}, {}] },
      executionStats: { executionStages: exec },
    });
    expect(s.indexes.sort()).toEqual(['a_1', 'c_1']);
    expect(s.collscan).toBe(false);
    expect(s.inMemorySort).toBe(true);
    expect(s.rejectedPlans).toBe(2);
    expect(s.plan?.stage).toBe('SORT');
    expect(s.plan?.details).toEqual({ sortPattern: { b: -1 } });
    const or = s.plan!.children[0].children[0];
    expect(or.stage).toBe('OR');
    expect(or.children.map((c) => c.keysExamined)).toEqual([4, 6]);
  });

  it('uses the logical plan when the execution stages are slot-based (SBE)', () => {
    const s = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          queryPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'x_1' } },
          slotBasedPlan: { slots: '…' },
        },
      },
      executionStats: { nReturned: 1, executionStages: { stage: 'nlj', nReturned: 1 } },
    });
    expect(s.plan?.stage).toBe('FETCH');
    expect(s.indexes).toEqual(['x_1']);
    expect(s.nReturned).toBe(1);
  });

  it('finds the query layer of an aggregate and lists the stages after it', () => {
    const raw = {
      stages: [
        {
          $cursor: {
            queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: 'status_1' } },
            executionStats: { nReturned: 10, totalKeysExamined: 10, totalDocsExamined: 10 },
          },
          nReturned: 10,
        },
        { $group: { _id: '$a' }, nReturned: 4, executionTimeMillisEstimate: 2 },
        { $sort: { sortKey: { _id: 1 } }, nReturned: 4 },
      ],
    };
    const s = summarizeExplain(raw);
    expect(s.indexes).toEqual(['status_1']);
    expect(s.nReturned).toBe(10);
    expect(s.pipeline).toEqual([
      { stage: '$group', nReturned: 4, timeMs: 2 },
      { stage: '$sort', nReturned: 4, timeMs: undefined },
    ]);
  });

  it('finds the plan of a sharded explain', () => {
    const s = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SINGLE_SHARD',
          shards: [{ shardName: 'rs0', winningPlan: { stage: 'COLLSCAN' } }],
        },
      },
    });
    expect(s.plan?.stage).toBe('SINGLE_SHARD');
    // The shard's own plan is walked too: its collection scan is reported.
    expect(s.plan?.children).toMatchObject([{ stage: 'SHARD', details: { shardName: 'rs0' }, children: [{ stage: 'COLLSCAN' }] }]);
    expect(s.collscan).toBe(true);
  });

  it('reports the index each shard used, with the shards execution stats', () => {
    const s = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { shardName: 'sh1', winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'a_1' } }, rejectedPlans: [{}] },
            { shardName: 'sh2', winningPlan: { stage: 'COLLSCAN' }, rejectedPlans: [] },
          ],
        },
      },
      executionStats: {
        nReturned: 5,
        totalDocsExamined: 40,
        executionStages: {
          stage: 'SHARD_MERGE',
          nReturned: 5,
          shards: [
            {
              shardName: 'sh1',
              nReturned: 2,
              totalKeysExamined: 2,
              totalDocsExamined: 2,
              executionStages: { stage: 'FETCH', nReturned: 2, inputStage: { stage: 'IXSCAN', indexName: 'a_1', keysExamined: 2 } },
            },
            // Slot-based stages: the shard's logical plan is shown instead.
            { shardName: 'sh2', nReturned: 3, totalDocsExamined: 38, executionStages: { stage: 'filter' } },
          ],
        },
      },
    });
    expect(s.indexes).toEqual(['a_1']);
    expect(s.collscan).toBe(true);
    expect(s.rejectedPlans).toBe(1);
    expect(s.plan?.children).toMatchObject([
      { stage: 'SHARD', details: { shardName: 'sh1' }, nReturned: 2, children: [{ stage: 'FETCH', children: [{ stage: 'IXSCAN', keysExamined: 2 }] }] },
      { stage: 'SHARD', details: { shardName: 'sh2' }, docsExamined: 38, children: [{ stage: 'COLLSCAN' }] },
    ]);
  });

  it('copes with nothing recognizable', () => {
    for (const raw of [null, undefined, 42, 'x', {}, { ok: 1 }]) {
      const s = summarizeExplain(raw);
      expect(s.plan).toBeNull();
      expect(s.indexes).toEqual([]);
      expect(s.collscan).toBe(false);
      expect(s.rejectedPlans).toBe(0);
      expect(s.pipeline).toEqual([]);
    }
  });
});

describe('suggestIndex (ESR)', () => {
  it('puts equality fields, then sort fields, then range fields', () => {
    expect(
      suggestIndex({ age: { $gte: 18 }, status: 'active', country: { $in: ['it', 'fr'] } }, { createdAt: -1 }),
    ).toEqual({ status: 1, country: 1, createdAt: -1, age: 1 });
    expect(Object.keys(suggestIndex({ age: { $gt: 1 }, status: 'a' }, { name: 1 })!)).toEqual(['status', 'name', 'age']);
  });

  it('treats a regex, $ne, $exists and $not as ranges and $eq / $elemMatch as equality', () => {
    expect(
      Object.keys(
        suggestIndex(
          {
            name: { $regularExpression: { pattern: '^a', options: '' } },
            a: { $ne: 1 },
            b: { $exists: true },
            c: { $eq: 2 },
            tags: { $elemMatch: { k: 'x' } },
          },
          undefined,
        )!,
      ),
    ).toEqual(['c', 'tags', 'name', 'a', 'b']);
  });

  it('ignores top-level operators such as $or and $expr', () => {
    expect(suggestIndex({ $or: [{ a: 1 }, { b: 2 }], c: 1 }, null)).toEqual({ c: 1 });
    expect(suggestIndex({ $expr: { $gt: ['$a', '$b'] } }, null)).toBeNull();
  });

  it('keeps a field that is both equality and sort once, as equality', () => {
    expect(suggestIndex({ a: 1 }, { a: -1, b: 1 })).toEqual({ a: 1, b: 1 });
  });

  it('treats EJSON values (ObjectId, dates) as equality', () => {
    expect(suggestIndex({ _id: { $oid: '0123456789abcdef01234567' }, d: { $date: '2024-01-01T00:00:00Z' } }, null)).toEqual({ _id: 1, d: 1 });
  });

  it('returns null when nothing can use an index', () => {
    expect(suggestIndex({}, {})).toBeNull();
    expect(suggestIndex(undefined, undefined)).toBeNull();
  });

  it('suggests a sort-only index', () => {
    expect(suggestIndex({}, { ts: -1 })).toEqual({ ts: -1 });
  });
});
