import { describe, expect, it } from 'vitest';
import { AdvisorCollection, AdvisorIndex, UNUSED_AFTER_MS, analyze, redundantWith, startsWith } from '../../src/shared/advisor';
import type { SlowOp } from '../../src/shared/profile';

const NOW = Date.parse('2024-06-01T00:00:00.000Z');
const LONG_AGO = new Date(NOW - UNUSED_AFTER_MS - 1).toISOString();
const RECENT = new Date(NOW - 1000).toISOString();

const ix = (name: string, key: Record<string, unknown>, extra: Partial<AdvisorIndex> = {}): AdvisorIndex => ({ name, key, ops: 5, since: LONG_AGO, ...extra });
const coll = (indexes: AdvisorIndex[], collection = 'users'): AdvisorCollection => ({ database: 'app', collection, indexes: [ix('_id_', { _id: 1 }), ...indexes] });

const slow = (filter: Record<string, unknown>, extra: Partial<SlowOp> = {}): SlowOp => ({
  ts: '2024-05-01T00:00:00.000Z',
  kind: 'find',
  ns: 'app.users',
  millis: 100,
  plan: 'COLLSCAN',
  docsExamined: 1000,
  nreturned: 1,
  query: { filter },
  shape: JSON.stringify(Object.keys(filter)),
  summary: '',
  raw: {},
  ...extra,
});

describe('startsWith', () => {
  it('compares fields in order and their directions', () => {
    expect(startsWith({ a: 1, b: -1, c: 1 }, { a: 1, b: -1 })).toBe(true);
    expect(startsWith({ a: 1, b: -1 }, { b: -1 })).toBe(false);
    expect(startsWith({ a: 1 }, { a: 1, b: 1 })).toBe(false);
    expect(startsWith({ a: 1 }, {})).toBe(false);
  });

  it('accepts all directions reversed, since an index is read both ways', () => {
    expect(startsWith({ a: 1, b: -1 }, { a: -1, b: 1 })).toBe(true);
    expect(startsWith({ a: 1, b: -1 }, { a: -1, b: -1 })).toBe(false);
  });

  it('requires text, geo and hashed parts to be the same', () => {
    expect(startsWith({ a: 'hashed' }, { a: 'hashed' })).toBe(true);
    expect(startsWith({ a: 'hashed' }, { a: 1 })).toBe(false);
    expect(startsWith({ loc: '2dsphere', a: 1 }, { loc: '2dsphere' })).toBe(true);
  });
});

describe('redundantWith', () => {
  it('flags an index that a longer one starts with', () => {
    expect(redundantWith(ix('a_1', { a: 1 }), ix('a_1_b_1', { a: 1, b: 1 }))).toBe(true);
    expect(redundantWith(ix('a_1_b_1', { a: 1, b: 1 }), ix('a_1', { a: 1 }))).toBe(false);
  });

  it('never flags _id, unique and TTL indexes, or an index against itself', () => {
    expect(redundantWith(ix('_id_', { _id: 1 }), ix('_id_1_a_1', { _id: 1, a: 1 }))).toBe(false);
    expect(redundantWith(ix('a_1', { a: 1 }, { unique: true }), ix('a_1_b_1', { a: 1, b: 1 }))).toBe(false);
    expect(redundantWith(ix('a_1', { a: 1 }, { expireAfterSeconds: 60 }), ix('a_1_b_1', { a: 1, b: 1 }))).toBe(false);
    const a = ix('a_1', { a: 1 });
    expect(redundantWith(a, a)).toBe(false);
  });

  it('requires the other index to hold the same documents in the same order', () => {
    const by = ix('a_1_b_1', { a: 1, b: 1 });
    expect(redundantWith(ix('a_1', { a: 1 }, { partialFilterExpression: { x: 1 } }), by)).toBe(false);
    expect(redundantWith(ix('a_1', { a: 1 }), { ...by, sparse: true })).toBe(false);
    expect(redundantWith(ix('a_1', { a: 1 }, { sparse: true }), by)).toBe(true);
    expect(redundantWith(ix('a_1', { a: 1 }, { collation: 'fr' }), by)).toBe(false);
    expect(redundantWith(ix('a_1', { a: 1 }), { ...by, hidden: true })).toBe(false);
    expect(redundantWith(ix('a_1', { a: 1 }), { ...by, building: true })).toBe(false);
  });
});

describe('analyze', () => {
  it('suggests an index for a slow collection scan', () => {
    const { advice } = analyze([coll([])], [slow({ status: 'a' }), slow({ status: 'b' }, { millis: 50 })], NOW);
    expect(advice).toHaveLength(1);
    const a = advice[0];
    expect(a.kind).toBe('create');
    if (a.kind !== 'create') return;
    expect(a).toMatchObject({ database: 'app', collection: 'users', keys: { status: 1 }, count: 2, totalMs: 150 });
    expect(a.queries).toHaveLength(1);
    expect(a.queries[0].example.millis).toBe(100);
  });

  it('suggests nothing when an existing index serves the query, or the collection is unknown', () => {
    expect(analyze([coll([ix('status_1_x_1', { status: 1, x: 1 })])], [slow({ status: 'a' })], NOW).advice.filter((a) => a.kind === 'create')).toEqual([]);
    expect(analyze([coll([])], [slow({ status: 'a' }, { ns: 'app.unknown' })], NOW).advice).toEqual([]);
  });

  it('still suggests an index when the only one is partial, sparse or hidden', () => {
    for (const extra of [{ partialFilterExpression: { x: 1 } }, { sparse: true }] as Partial<AdvisorIndex>[]) {
      const { advice } = analyze([coll([ix('status_1', { status: 1 }, extra)])], [slow({ status: 'a' })], NOW);
      expect(advice.some((a) => a.kind === 'create')).toBe(true);
    }
  });

  it('merges a suggestion into a longer one that serves it', () => {
    const { advice } = analyze(
      [coll([])],
      [slow({ status: 'a' }, { shape: 's1', millis: 10 }), slow({ status: 'a', age: { $gt: 1 } }, { shape: 's2', millis: 20 })],
      NOW,
    );
    const creates = advice.filter((a) => a.kind === 'create');
    expect(creates).toHaveLength(1);
    const c = creates[0];
    if (c.kind !== 'create') return;
    expect(c.keys).toEqual({ status: 1, age: 1 });
    expect(c.queries.map((q) => q.shape)).toEqual(['s2', 's1']);
    expect(c.totalMs).toBe(30);
  });

  it('counts a cursor and its next batches as one operation', () => {
    const { advice } = analyze([coll([])], [slow({ a: 1 }), slow({ a: 1 }, { getMore: true, millis: 5 })], NOW);
    const c = advice[0];
    if (c.kind !== 'create') throw new Error('expected a create');
    expect(c.count).toBe(1);
    expect(c.queries[0].avgMs).toBe(105);
  });

  it('flags the newer of two identical indexes as redundant', () => {
    const { advice } = analyze([coll([ix('a_1', { a: 1 }), ix('a_1_dup', { a: 1 })])], [], NOW);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({ kind: 'redundant', index: { name: 'a_1_dup' }, by: { name: 'a_1' } });
  });

  it('flags unused indexes only when their statistics cover long enough', () => {
    const { advice, tooRecent } = analyze(
      [
        coll([
          ix('old', { a: 1 }, { ops: 0, size: 10 }),
          ix('bigOld', { b: 1 }, { ops: 0, size: 100 }),
          ix('new', { c: 1 }, { ops: 0, since: RECENT }),
          ix('noStats', { d: 1 }, { ops: undefined }),
          ix('used', { e: 1 }),
          ix('unique', { f: 1 }, { ops: 0, unique: true }),
          ix('ttl', { g: 1 }, { ops: 0, expireAfterSeconds: 10 }),
          ix('hid', { h: 1 }, { hidden: true }),
          ix('built', { i: 1 }, { ops: 0, building: true }),
        ]),
      ],
      [],
      NOW,
    );
    expect(tooRecent).toBe(1);
    expect(advice.map((a) => [a.kind, 'index' in a ? a.index.name : ''])).toEqual([
      ['unused', 'bigOld'],
      ['unused', 'old'],
      ['hidden', 'hid'],
    ]);
  });

  it('puts the indexes to create first, the biggest wins first', () => {
    const { advice } = analyze(
      [coll([ix('a_1', { a: 1 }), ix('a_1_x', { a: 1 })]), coll([], 'orders')],
      [slow({ x: 1 }, { millis: 10 }), slow({ y: 1 }, { ns: 'app.orders', millis: 500 })],
      NOW,
    );
    expect(advice.map((a) => a.kind)).toEqual(['create', 'create', 'redundant']);
    expect(advice[0]).toMatchObject({ collection: 'orders', keys: { y: 1 } });
    expect(new Set(advice.map((a) => a.id)).size).toBe(advice.length);
  });
});
