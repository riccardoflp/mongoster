import { describe, expect, it } from 'vitest';
import {
  SlowOp,
  canOpen,
  fromLogLine,
  fromProfileDoc,
  groupOps,
  indexableQuery,
  isNoise,
  readCommand,
  shapeOf,
  splitNs,
} from '../../src/shared/profile';

describe('shapeOf', () => {
  it('replaces values with ? and keeps the structure', () => {
    expect(shapeOf({ status: 'active', age: { $gte: 18 } })).toBe('{ status: ?, age: { $gte: ? } }');
  });

  it('gives lists of values the same shape whatever their length', () => {
    expect(shapeOf({ a: { $in: [1, 2, 3] } })).toBe(shapeOf({ a: { $in: [7] } }));
    expect(shapeOf({ a: { $in: [1, 2, 3] } })).toBe('{ a: { $in: [?] } }');
    expect(shapeOf([])).toBe('[]');
  });

  it('keeps field paths, and the numbers of sort and projection specs', () => {
    expect(shapeOf([{ $group: { _id: '$a', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $project: { a: 1, b: 0 } }])).toBe(
      '[{ $group: { _id: "$a", n: { $sum: ? } } }, { $sort: { n: -1 } }, { $project: { a: 1, b: 0 } }]',
    );
  });

  it('shows EJSON values as ? and regexes as /?/', () => {
    expect(shapeOf({ _id: { $oid: '0123456789abcdef01234567' }, n: { $regularExpression: { pattern: 'x', options: 'i' } } })).toBe(
      '{ _id: ?, n: /?/ }',
    );
  });

  it('quotes keys that are not identifiers', () => {
    expect(shapeOf({ 'a.b': 1 })).toBe('{ "a.b": ? }');
  });

  it('is the same for queries that differ only in their values', () => {
    expect(shapeOf({ a: 1, b: { $lt: 'x' } })).toBe(shapeOf({ a: 99, b: { $lt: 'zzz' } }));
    expect(shapeOf({ a: 1, b: 2 })).not.toBe(shapeOf({ b: 2, a: 1 }));
  });
});

describe('readCommand', () => {
  it('reads find, skipping the fields that are not the query', () => {
    expect(
      readCommand({ lsid: { id: 1 }, $db: 'app', find: 'users', filter: { a: 1 }, sort: { b: -1 }, projection: { c: 1 }, batchSize: 10 }),
    ).toEqual({ kind: 'find', query: { filter: { a: 1 }, sort: { b: -1 }, projection: { c: 1 } } });
  });

  it('reads aggregate, count, distinct, findAndModify and insert', () => {
    expect(readCommand({ aggregate: 'c', pipeline: [{ $match: { a: 1 } }, 3] })).toEqual({ kind: 'aggregate', query: { pipeline: [{ $match: { a: 1 } }] } });
    expect(readCommand({ count: 'c', query: { a: 1 } })).toEqual({ kind: 'count', query: { filter: { a: 1 } } });
    expect(readCommand({ distinct: 'c', key: 'x', query: { a: 1 } })).toEqual({ kind: 'distinct', query: { filter: { a: 1 } } });
    expect(readCommand({ findandmodify: 'c', query: { a: 1 }, update: { $set: { b: 1 } } })).toEqual({
      kind: 'findAndModify',
      query: { filter: { a: 1 }, sort: undefined, update: { $set: { b: 1 } } },
    });
    expect(readCommand({ insert: 'c', documents: [{}] })).toEqual({ kind: 'insert', query: {} });
  });

  it('reads the statements of updates and deletes', () => {
    expect(readCommand({ q: { a: 1 }, u: { $inc: { n: 1 } } }, 'update')).toEqual({ kind: 'update', query: { filter: { a: 1 }, update: { $inc: { n: 1 } } } });
    expect(readCommand({ q: { a: 1 }, limit: 1 }, 'remove')).toEqual({ kind: 'delete', query: { filter: { a: 1 } } });
  });

  it('names other commands after their first field', () => {
    expect(readCommand({ $db: 'admin', serverStatus: 1 }).kind).toBe('serverStatus');
    expect(readCommand({}, 'command').kind).toBe('command');
    expect(readCommand(undefined).kind).toBe('command');
  });
});

describe('fromProfileDoc', () => {
  it('reads a system.profile document', () => {
    const op = fromProfileDoc({
      op: 'query',
      ns: 'app.users',
      command: { find: 'users', filter: { status: 'a', age: { $gt: 30 } }, sort: { name: 1 }, $db: 'app' },
      keysExamined: 0,
      docsExamined: { $numberLong: '5000' },
      nreturned: 12,
      hasSortStage: true,
      planSummary: 'COLLSCAN',
      millis: 120,
      ts: { $date: '2024-05-01T10:00:00.000Z' },
      appName: 'my-app',
      client: '127.0.0.1',
      allUsers: [{ user: 'bob', db: 'admin' }],
    });
    expect(op).toMatchObject({
      kind: 'find',
      ns: 'app.users',
      millis: 120,
      docsExamined: 5000,
      keysExamined: 0,
      nreturned: 12,
      plan: 'COLLSCAN',
      sortStage: true,
      app: 'my-app',
      client: '127.0.0.1',
      user: 'bob@admin',
      ts: '2024-05-01T10:00:00.000Z',
      shape: '{ status: ?, age: { $gt: ? } } · sort { name: 1 }',
    });
    expect(op.getMore).toBeUndefined();
    expect(op.summary).not.toContain('$db');
    expect(op.summary).toContain('find: "users"');
  });

  it('reads a date given as a number of milliseconds', () => {
    expect(fromProfileDoc({ ts: { $date: { $numberLong: '0' } }, ns: 'a.b', millis: 1, command: {} }).ts).toBe('1970-01-01T00:00:00.000Z');
  });

  it('describes a getMore by the command that opened the cursor', () => {
    const op = fromProfileDoc({
      op: 'getmore',
      ns: 'app.users',
      command: { getMore: { $numberLong: '123' }, collection: 'users' },
      originatingCommand: { find: 'users', filter: { a: 1 } },
      millis: 5,
      ts: { $date: '2024-05-01T10:00:00.000Z' },
    });
    expect(op.getMore).toBe(true);
    expect(op.kind).toBe('find');
    expect(op.shape).toBe('{ a: ? }');
  });

  it('gives an empty find the shape {}', () => {
    expect(fromProfileDoc({ ns: 'a.b', millis: 1, command: { find: 'b' } }).shape).toBe('{}');
  });
});

describe('fromLogLine', () => {
  const line = (attr: Record<string, unknown>, msg = 'Slow query') =>
    JSON.stringify({ t: { $date: '2024-05-01T10:00:00.000+00:00' }, s: 'I', c: 'COMMAND', msg, attr });

  it('reads a slow query line', () => {
    const op = fromLogLine(
      line({
        type: 'command',
        ns: 'app.orders',
        appName: 'shell',
        command: { aggregate: 'orders', pipeline: [{ $match: { status: 'x' } }, { $sort: { at: -1 } }], cursor: {}, $db: 'app' },
        planSummary: 'IXSCAN { status: 1 }',
        docsExamined: 10,
        keysExamined: 10,
        nreturned: 2,
        durationMillis: 250,
        remote: '127.0.0.1:5000',
      }),
    );
    expect(op).toMatchObject({
      kind: 'aggregate',
      ns: 'app.orders',
      millis: 250,
      plan: 'IXSCAN { status: 1 }',
      client: '127.0.0.1:5000',
      app: 'shell',
      ts: '2024-05-01T10:00:00.000+00:00',
      shape: '[{ $match: { status: ? } }, { $sort: { at: -1 } }]',
    });
  });

  it('reads the statements of an update', () => {
    const op = fromLogLine(line({ type: 'update', ns: 'app.c', command: { q: { a: 1 }, u: { $set: { b: 2 } } }, durationMillis: 3 }));
    expect(op?.kind).toBe('update');
    expect(op?.shape).toBe('{ a: ? } · update { $set: { b: ? } }');
  });

  it('leaves out the command of a batched update or delete, and lines that are not slow queries', () => {
    expect(fromLogLine(line({ ns: 'app.$cmd', command: { update: 'c', updates: [] }, durationMillis: 3 }))).toBeUndefined();
    expect(fromLogLine(line({ ns: 'app.$cmd', command: { delete: 'c', deletes: [] }, durationMillis: 3 }))).toBeUndefined();
    expect(fromLogLine(line({ ns: 'app.c' }, 'Connection accepted'))).toBeUndefined();
    expect(fromLogLine('not json')).toBeUndefined();
    expect(fromLogLine(JSON.stringify({ msg: 'Slow query' }))).toBeUndefined();
  });
});

const op = (o: Partial<SlowOp> & { millis: number }): SlowOp => ({
  ts: '2024-01-01T00:00:00.000Z',
  kind: 'find',
  ns: 'app.users',
  query: { filter: { status: 'a' } },
  shape: '{ status: ? }',
  summary: '',
  raw: {},
  ...o,
});

describe('groupOps', () => {
  it('groups by namespace, kind and shape, with totals, slowest in total first', () => {
    const groups = groupOps([
      op({ millis: 10, docsExamined: 100, nreturned: 1, plan: 'COLLSCAN', app: 'a', ts: '2024-01-02T00:00:00.000Z' }),
      op({ millis: 30, docsExamined: 100, nreturned: 1, plan: 'COLLSCAN', app: 'b' }),
      op({ millis: 5, ns: 'app.other' }),
      op({ millis: 1, kind: 'count' }),
    ]);
    expect(groups.map((g) => [g.ns, g.kind, g.count, g.totalMs])).toEqual([
      ['app.users', 'find', 2, 40],
      ['app.other', 'find', 1, 5],
      ['app.users', 'count', 1, 1],
    ]);
    const g = groups[0];
    expect(g).toMatchObject({ maxMs: 30, avgMs: 20, docsExamined: 200, nreturned: 2, plans: ['COLLSCAN'], collscan: true, apps: ['a', 'b'], last: '2024-01-02T00:00:00.000Z' });
    expect(g.slowest.millis).toBe(30);
    expect(g.suggestion).toEqual({ status: 1 });
  });

  it('suggests an index only when the plan shows one is missing', () => {
    const indexed = groupOps([op({ millis: 50, docsExamined: 1, nreturned: 1, plan: 'IXSCAN { status: 1 }' })]);
    expect(indexed[0].suggestion).toBeNull();
    // Many documents examined per document returned.
    const wasteful = groupOps([op({ millis: 50, docsExamined: 500, nreturned: 5, plan: 'IXSCAN { x: 1 }' })]);
    expect(wasteful[0].suggestion).toEqual({ status: 1 });
    const sorted = groupOps([op({ millis: 50, query: { filter: {}, sort: { at: -1 } }, sortStage: true })]);
    expect(sorted[0].suggestion).toEqual({ at: -1 });
  });

  it('takes the slowest first batch as the example, not a getMore', () => {
    const groups = groupOps([
      op({ millis: 100, getMore: true }),
      op({ millis: 10 }),
      op({ millis: 20 }),
      op({ millis: 500, getMore: true }),
    ]);
    expect(groups[0].getMores).toBe(2);
    expect(groups[0].slowest.millis).toBe(20);
    expect(groups[0].slowest.getMore).toBeUndefined();
  });

  it('suggests an index for an aggregate from its leading $match and $sort', () => {
    const groups = groupOps([
      op({
        kind: 'aggregate',
        millis: 10,
        plan: 'COLLSCAN',
        query: { pipeline: [{ $match: { a: 1, n: { $gt: 2 } } }, { $sort: { b: -1 } }] },
        shape: 'x',
      }),
    ]);
    expect(groups[0].suggestion).toEqual({ a: 1, b: -1, n: 1 });
  });
});

describe('indexableQuery', () => {
  it('takes a leading $match and the $sort right after it', () => {
    expect(indexableQuery('aggregate', { pipeline: [{ $match: { a: 1 } }, { $sort: { b: 1 } }] })).toEqual({ filter: { a: 1 }, sort: { b: 1 } });
    expect(indexableQuery('aggregate', { pipeline: [{ $match: { a: 1 } }, { $group: {} }, { $sort: { b: 1 } }] })).toEqual({ filter: { a: 1 }, sort: undefined });
    expect(indexableQuery('aggregate', { pipeline: [{ $sort: { b: 1 } }] })).toEqual({ sort: { b: 1 } });
    expect(indexableQuery('aggregate', { pipeline: [{ $group: {} }, { $match: { a: 1 } }] })).toEqual({});
    expect(indexableQuery('find', { filter: { a: 1 }, sort: { b: 1 } })).toEqual({ filter: { a: 1 }, sort: { b: 1 } });
  });
});

describe('isNoise, splitNs, canOpen', () => {
  it('flags the profiler, internal databases and monitoring commands', () => {
    expect(isNoise(op({ millis: 1, ns: 'app.system.profile' }))).toBe(true);
    expect(isNoise(op({ millis: 1, ns: 'local.oplog.rs' }))).toBe(true);
    expect(isNoise(op({ millis: 1, ns: 'config.system.sessions' }))).toBe(true);
    expect(isNoise(op({ millis: 1, kind: 'hello' }))).toBe(true);
    expect(isNoise(op({ millis: 1 }))).toBe(false);
    expect(isNoise(op({ millis: 1, ns: 'localdb.users' }))).toBe(false);
  });

  it('splits a namespace at its first dot', () => {
    expect(splitNs('app.logs.2024')).toEqual({ database: 'app', collection: 'logs.2024' });
    expect(splitNs('app')).toEqual({ database: 'app', collection: '' });
  });

  it('opens only queries the collection tab can show', () => {
    expect(canOpen('find')).toBe(true);
    expect(canOpen('delete')).toBe(true);
    expect(canOpen('insert')).toBe(false);
    expect(canOpen('getMore')).toBe(false);
  });
});
