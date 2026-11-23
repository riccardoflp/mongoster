// The colors of single collections (D16): the pure rules, the tree's icons, the decorations of the editor tabs and
// the connection files that carry them.
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  bucketCollection,
  collectionColorChoices,
  colorOf,
  dropCollectionColors,
  namespaceOf,
  readCollectionColors,
  renameCollectionColor,
  setCollectionColor,
} from '../../src/shared/collectionColors';
import { parseConnections, serializeConnections, type PortableConnection } from '../../src/shared/connectionsFile';
import { ConnectionDecorations } from '../../src/connectionColors';
import { BucketNode, CollectionNode } from '../../src/tree';
import type { ConnectionInfo, ConnectionManager } from '../../src/connections';

const prod: ConnectionInfo = {
  id: 'p1',
  name: 'prod',
  color: 'red',
  collectionColors: { 'shop.payments': 'green', 'shop.logs': 'none', 'shop.fs.files': 'blue' },
};

describe('the color of a collection', () => {
  it("takes the collection's own color, none for none, otherwise the connection's", () => {
    expect(colorOf(prod, 'shop', 'payments')).toBe('green');
    expect(colorOf(prod, 'shop', 'logs')).toBeUndefined();
    expect(colorOf(prod, 'shop', 'orders')).toBe('red');
    expect(colorOf(prod, 'other', 'payments')).toBe('red');
    expect(colorOf({ id: 'l', name: 'local' } as ConnectionInfo, 'shop', 'orders')).toBeUndefined();
    expect(colorOf(undefined, 'shop', 'orders')).toBeUndefined();
  });

  it('keys a collection by its namespace, and a bucket by its .files collection', () => {
    expect(namespaceOf('shop', 'a.b')).toBe('shop.a.b');
    expect(colorOf(prod, 'shop', bucketCollection('fs'))).toBe('blue');
  });

  it('sets a color, and removes it to follow the connection again', () => {
    expect(setCollectionColor(undefined, 'shop.orders', 'yellow')).toEqual({ 'shop.orders': 'yellow' });
    expect(setCollectionColor({ 'shop.orders': 'yellow' }, 'shop.orders', 'none')).toEqual({ 'shop.orders': 'none' });
    expect(setCollectionColor({ 'shop.orders': 'yellow', 'shop.a': 'red' }, 'shop.orders', undefined)).toEqual({ 'shop.a': 'red' });
    expect(setCollectionColor({ 'shop.orders': 'yellow' }, 'shop.orders', undefined)).toBeUndefined();
  });

  it('moves the color of a renamed collection, and leaves the map alone without one', () => {
    expect(renameCollectionColor(prod.collectionColors, 'shop.payments', 'shop.charges')).toEqual({
      'shop.charges': 'green',
      'shop.logs': 'none',
      'shop.fs.files': 'blue',
    });
    expect(renameCollectionColor(prod.collectionColors, 'shop.orders', 'shop.sales')).toBe(prod.collectionColors);
    expect(renameCollectionColor(undefined, 'shop.orders', 'shop.sales')).toBeUndefined();
  });

  it('forgets the colors of a dropped collection, bucket or database', () => {
    expect(dropCollectionColors(prod.collectionColors, 'shop', 'payments')).toEqual({ 'shop.logs': 'none', 'shop.fs.files': 'blue' });
    expect(dropCollectionColors({ 'shop.fs.files': 'blue', 'shop.fs.chunks': 'red', 'shop.fs': 'green' }, 'shop', 'fs', true)).toEqual({ 'shop.fs': 'green' });
    expect(dropCollectionColors({ ...prod.collectionColors, 'shopping.a': 'red' }, 'shop')).toEqual({ 'shopping.a': 'red' });
    expect(dropCollectionColors({ 'shop.a': 'red' }, 'shop', 'a')).toBeUndefined();
    expect(dropCollectionColors(prod.collectionColors, 'shop', 'orders')).toBe(prod.collectionColors);
  });

  it('reads only valid entries from a file', () => {
    expect(readCollectionColors({ 'shop.a': 'red', 'shop.b': 'none', 'shop.c': 'pink', nodot: 'red', '.x': 'red', 'shop.d': 3 })).toEqual({
      'shop.a': 'red',
      'shop.b': 'none',
    });
    expect(readCollectionColors(['shop.a'])).toBeUndefined();
    expect(readCollectionColors('red')).toBeUndefined();
    expect(readCollectionColors({})).toBeUndefined();
  });
});

describe('the choices of Set Color… on a collection', () => {
  it("offers the six colors, None and Connection's Color described with the connection's", () => {
    const choices = collectionColorChoices('red', undefined);
    expect(choices.map((c) => c.label)).toEqual(['🔴 Red', '🟠 Orange', '🟡 Yellow', '🟢 Green', '🔵 Blue', '🟣 Purple', '⚪ None', "Connection's Color"]);
    expect(choices.map((c) => c.color)).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'none', undefined]);
    expect(choices[7].description).toBe('red · current');
    expect(choices.filter((c) => c.description).length).toBe(1);
  });

  it('marks the current choice, and a connection without a color', () => {
    const choices = collectionColorChoices(undefined, 'none');
    expect(choices[6].description).toBe('current');
    expect(choices[7].description).toBe('none');
    expect(collectionColorChoices('blue', 'green')[3].description).toBe('current');
  });
});

describe('the tree', () => {
  it("colors the icon of a collection, a view and a bucket with their own color, or the connection's", () => {
    expect((new CollectionNode(prod, 'shop', 'payments', false).iconPath as vscode.ThemeIcon).color?.id).toBe('charts.green');
    expect((new CollectionNode(prod, 'shop', 'orders', true).iconPath as vscode.ThemeIcon).color?.id).toBe('charts.red');
    expect((new CollectionNode(prod, 'shop', 'logs', false).iconPath as vscode.ThemeIcon).color).toBeUndefined();
    expect((new BucketNode(prod, 'shop', 'fs').iconPath as vscode.ThemeIcon).color?.id).toBe('charts.blue');
    expect((new BucketNode(prod, 'shop', 'images').iconPath as vscode.ThemeIcon).color?.id).toBe('charts.red');
  });
});

describe('the decorations of the editor tabs', () => {
  function manager(list: ConnectionInfo[]) {
    const changed = new vscode.EventEmitter<void>();
    return { list: () => list, get: (id: string) => list.find((c) => c.id === id), onDidChange: changed.event, fire: () => changed.fire() };
  }
  const doc = (scheme: string, path: string) => vscode.Uri.from({ scheme, authority: 'p1', path });

  it("colors the documents and definitions of a collection with its color, the rest with the connection's", () => {
    const decorations = new ConnectionDecorations(manager([prod]) as unknown as ConnectionManager, ['mongoster', 'mongoster-def']);
    expect(decorations.provideFileDecoration(doc('mongoster', '/shop/payments/1.json'))?.color?.id).toBe('charts.green');
    expect(decorations.provideFileDecoration(doc('mongoster-def', '/shop/payments/indexes.json'))?.color?.id).toBe('charts.green');
    expect(decorations.provideFileDecoration(doc('mongoster', '/shop/logs/1.json'))).toBeUndefined();
    expect(decorations.provideFileDecoration(doc('mongoster', '/shop/orders/1.json'))?.color?.id).toBe('charts.red');
    expect(decorations.provideFileDecoration(doc('mongoster', `/shop/${encodeURIComponent('fs.files')}/1.json`))?.color?.id).toBe('charts.blue');
  });

  it("tells the decorations changed when a collection's color changed", () => {
    const list = [{ ...prod }];
    const connections = manager(list);
    const decorations = new ConnectionDecorations(connections as unknown as ConnectionManager, ['mongoster']);
    let fired = 0;
    decorations.onDidChangeFileDecorations(() => fired++);
    list[0].collectionColors = { 'shop.orders': 'purple' };
    connections.fire();
    expect(fired).toBe(1);
  });
});

describe('the colors of collections in connection files', () => {
  const colored: PortableConnection = { name: 'prod', uri: 'mongodb://h/shop', color: 'red', collectionColors: { 'shop.payments': 'green', 'shop.logs': 'none' }, notes: [] };

  it("travel in Mongoster's format", async () => {
    const out = await serializeConnections([colored], 'mongoster', { secrets: 'remove' });
    expect(JSON.parse(out.text).connections[0].collectionColors).toEqual(colored.collectionColors);
    expect((await parseConnections(out.text)).connections).toEqual([colored]);
  });

  it('are read without the invalid entries, and a file without them reads as before', async () => {
    const file = (extra: object) => JSON.stringify({ type: 'Mongoster Connections', version: 1, connections: [{ name: 'a', uri: 'mongodb://h/db', ...extra }] });
    expect((await parseConnections(file({ collectionColors: { 'db.x': 'blue', 'db.y': 'pink' } }))).connections[0].collectionColors).toEqual({ 'db.x': 'blue' });
    expect((await parseConnections(file({}))).connections[0]).not.toHaveProperty('collectionColors');
  });

  it("are left out of Compass's format and of a list, which say so", async () => {
    const compass = await serializeConnections([colored], 'compass', { secrets: 'remove' });
    expect(compass.notes).toContain("colors of collections were left out (Compass doesn't have them)");
    expect(compass.text).not.toContain('payments');
    const list = await serializeConnections([{ ...colored, color: undefined }], 'list', { secrets: 'remove' });
    expect(list.notes).toContain('folders, colors, read-only and redis-oplog were left out');
  });
});
