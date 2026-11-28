// What follows a collection that was moved by Cut and Paste or by Rename Database: its columns, queries and
// formatting rules in Mongoster's state, and its color and exclusion on its connection.
import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import { moveCollectionState } from '../../src/collectionPanel';
import { colorsAfterMove, exclusionsAfterMove } from '../../src/shared/paste';

const place = (connectionId: string, database: string, collection: string) => ({ connectionId, database, collection });

describe('the state of a moved collection', () => {
  function memento(data: Record<string, unknown>): Memento {
    return {
      keys: () => Object.keys(data),
      get: (key: string, fallback?: unknown) => (key in data ? data[key] : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) delete data[key];
        else data[key] = value;
      },
    } as unknown as Memento;
  }

  it('goes to the other database, or the other connection, and leaves nothing behind', async () => {
    const data: Record<string, unknown> = {
      'mongoster.history.a/shop/orders': ['recent'],
      'mongoster.saved.a/shop/orders': ['saved'],
      'mongoster.expanded.a/shop/orders': ['address'],
      'mongoster.layout.a/shop/orders': { order: ['_id'] },
      'mongoster.formatting.a/shop/orders': [{ id: 'rule' }],
      'mongoster.formattingOff.a/shop/orders': ['database'],
      'mongoster.saved.a/shop/people': ['of another collection'],
      'mongoster.formattingDatabase.a/shop': [{ id: 'of the database' }],
    };
    const state = memento(data);
    await moveCollectionState(state, place('a', 'shop', 'orders'), place('a', 'store', 'orders'));
    expect(data).toEqual({
      'mongoster.history.a/store/orders': ['recent'],
      'mongoster.saved.a/store/orders': ['saved'],
      'mongoster.expanded.a/store/orders': ['address'],
      'mongoster.layout.a/store/orders': { order: ['_id'] },
      'mongoster.formatting.a/store/orders': [{ id: 'rule' }],
      'mongoster.formattingOff.a/store/orders': ['database'],
      'mongoster.saved.a/shop/people': ['of another collection'],
      'mongoster.formattingDatabase.a/shop': [{ id: 'of the database' }],
    });
    await moveCollectionState(state, place('a', 'store', 'orders'), place('b', 'crm', 'sales'));
    expect(Object.keys(data).filter((k) => k.includes('orders') || k.includes('sales')).sort()).toEqual([
      'mongoster.expanded.b/crm/sales',
      'mongoster.formatting.b/crm/sales',
      'mongoster.formattingOff.b/crm/sales',
      'mongoster.history.b/crm/sales',
      'mongoster.layout.b/crm/sales',
      'mongoster.saved.b/crm/sales',
    ]);
  });

  it('leaves what the destination had when the moved collection has nothing of that kind', async () => {
    const data: Record<string, unknown> = { 'mongoster.saved.a/store/orders': ['already there'], 'mongoster.layout.a/shop/orders': { order: ['total'] } };
    await moveCollectionState(memento(data), place('a', 'shop', 'orders'), place('a', 'store', 'orders'));
    expect(data).toEqual({ 'mongoster.saved.a/store/orders': ['already there'], 'mongoster.layout.a/store/orders': { order: ['total'] } });
  });
});

describe('the color and the exclusion of a moved collection', () => {
  const colors = { 'shop.orders': 'red', 'shop.people': 'blue' } as const;
  const exclusions = ['archive', 'shop.orders'];

  it('follow it to another database of the same connection', () => {
    expect(colorsAfterMove(colors, place('a', 'shop', 'orders'), place('a', 'store', 'orders'))).toEqual({ 'shop.people': 'blue', 'store.orders': 'red' });
    expect(exclusionsAfterMove(exclusions, place('a', 'shop', 'orders'), place('a', 'store', 'orders'))).toEqual(['archive', 'store.orders']);
  });

  it('are forgotten on the connection it left for another one', () => {
    expect(colorsAfterMove(colors, place('a', 'shop', 'orders'), place('b', 'shop', 'orders'))).toEqual({ 'shop.people': 'blue' });
    expect(exclusionsAfterMove(exclusions, place('a', 'shop', 'orders'), place('b', 'shop', 'orders'))).toEqual(['archive']);
  });

  it('change nothing, giving the same map and list back, for a collection that had neither', () => {
    for (const to of [place('a', 'store', 'events'), place('b', 'shop', 'events')]) {
      expect(colorsAfterMove(colors, place('a', 'shop', 'events'), to)).toBe(colors);
      expect(exclusionsAfterMove(exclusions, place('a', 'shop', 'events'), to)).toBe(exclusions);
    }
    expect(colorsAfterMove(undefined, place('a', 'shop', 'orders'), place('a', 'store', 'orders'))).toBeUndefined();
    expect(exclusionsAfterMove(undefined, place('a', 'shop', 'orders'), place('b', 'store', 'orders'))).toBeUndefined();
  });
});
