// The recent and saved queries of a collection: what is stored, and which queries count as the same.
import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import { QueryHistory, sameQuery } from '../../src/queryHistory';
import type { SavedQuery } from '../../src/shared/messages';

function memento(initial: Record<string, unknown> = {}): Memento & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    keys: () => Object.keys(data),
    get: (key: string, fallback?: unknown) => (key in data ? data[key] : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) delete data[key];
      else data[key] = value;
    },
  } as unknown as Memento & { data: Record<string, unknown> };
}

const find = (filter: string, sort = '', projection = '') => ({ filter, sort, projection });
const stored = (q: SavedQuery) => {
  const { id: _id, at: _at, ...rest } = q;
  return rest;
};

describe('query history: collation and hint', () => {
  it('stores them trimmed, and not at all when they are empty', async () => {
    const history = new QueryHistory(memento(), 'c1/shop/people');
    await history.record({ ...find(' { a: 1 } '), collation: ' { locale: "it" } ', hint: ' a_1 ' });
    await history.record({ ...find('{ b: 1 }'), collation: '  ', hint: '' });
    expect(history.recent.map(stored)).toEqual([
      { filter: '{ b: 1 }', sort: '', projection: '' },
      { filter: '{ a: 1 }', sort: '', projection: '', collation: '{ locale: "it" }', hint: 'a_1' },
    ]);
  });

  it('records a find that has only a collation or a hint, and still skips an empty one', async () => {
    const history = new QueryHistory(memento(), 'c1/shop/people');
    expect(await history.record(find(''))).toBe(false);
    expect(await history.record({ ...find(''), hint: 'a_1' })).toBe(true);
    expect(await history.record({ ...find(''), collation: '{ locale: "it" }' })).toBe(true);
    expect(history.recent).toHaveLength(2);
  });

  it('keeps them out of a pipeline entry', async () => {
    const history = new QueryHistory(memento(), 'c1/shop/people');
    await history.record({ ...find(''), collation: '{ locale: "it" }', hint: 'a_1', pipeline: [{ op: '$match', body: '{ a: 1 }', enabled: true }] });
    expect(stored(history.recent[0])).toEqual({ filter: '', sort: '', projection: '', pipeline: [{ op: '$match', body: '{ a: 1 }', enabled: true }] });
  });

  it('saves them with a named query', async () => {
    const history = new QueryHistory(memento(), 'c1/shop/people');
    await history.save('By name', { ...find('{ a: 1 }'), collation: '{ locale: "it" }' });
    expect(stored(history.saved[0])).toEqual({ name: 'By name', filter: '{ a: 1 }', sort: '', projection: '', collation: '{ locale: "it" }' });
  });

  it('moves the same query on top instead of adding it again, and keeps another collation or hint apart', async () => {
    const history = new QueryHistory(memento(), 'c1/shop/people');
    await history.record({ ...find('{ a: 1 }'), collation: '{ locale: "it", strength: 1 }', hint: '{ a: 1 }' });
    await history.record({ ...find('{a:1}'), collation: '{locale:"it",strength:1}', hint: '{a:1}' });
    expect(history.recent).toHaveLength(1);
    await history.record({ ...find('{ a: 1 }'), collation: '{ locale: "en" }', hint: '{ a: 1 }' });
    await history.record({ ...find('{ a: 1 }'), collation: '{ locale: "it", strength: 1 }', hint: 'a_1' });
    await history.record(find('{ a: 1 }'));
    expect(history.recent).toHaveLength(4);
  });
});

describe('sameQuery: collation and hint', () => {
  it('reads an entry stored without them as one with them empty', () => {
    expect(sameQuery(find('{ a: 1 }'), { ...find('{ a: 1 }'), collation: '', hint: ' ' })).toBe(true);
    expect(sameQuery(find('{ a: 1 }'), { ...find('{ a: 1 }'), hint: 'a_1' })).toBe(false);
    expect(sameQuery(find('{ a: 1 }'), { ...find('{ a: 1 }'), collation: '{ locale: "it" }' })).toBe(false);
  });

  it('compares a hint that is a name as text, and one that is the keys of an index as its value', () => {
    expect(sameQuery({ ...find(''), hint: ' a_1 ' }, { ...find(''), hint: 'a_1' })).toBe(true);
    expect(sameQuery({ ...find(''), hint: 'a_1' }, { ...find(''), hint: 'a_-1' })).toBe(false);
    expect(sameQuery({ ...find(''), hint: '{ a: 1 }' }, { ...find(''), hint: "{ 'a': 1 }" })).toBe(true);
  });
});
