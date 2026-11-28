// Copy and Paste of the connections view: what can be copied together, the name of a copy, where each pasted
// collection goes and what happens to the ones that exist, and the copy of a connection with its secrets.
import { describe, expect, it } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { ConnectionManager } from '../../src/connections';
import { CopiedNode, ExistingKind, clipboardOf, copyName, pasteAction, planPaste } from '../../src/shared/paste';

const connection = (connectionId: string): CopiedNode => ({ kind: 'connection', connectionId });
const database = (connectionId: string, name: string): CopiedNode => ({ kind: 'database', connectionId, database: name });
const collection = (connectionId: string, db: string, name: string, isView = false): CopiedNode => ({ kind: 'collection', connectionId, database: db, collection: name, isView });

describe('what Copy takes from the tree', () => {
  it('takes connections, the databases of one connection, or the collections and views of one database', () => {
    expect(clipboardOf([connection('a'), connection('b'), connection('a')])).toEqual({ kind: 'connection', connectionIds: ['a', 'b'] });
    expect(clipboardOf([database('a', 'shop'), database('a', 'crm')])).toEqual({ kind: 'database', connectionId: 'a', databases: ['shop', 'crm'] });
    expect(clipboardOf([collection('a', 'shop', 'orders'), collection('a', 'shop', 'recent', true)])).toEqual({
      kind: 'collection',
      connectionId: 'a',
      database: 'shop',
      collections: [
        { name: 'orders', isView: false },
        { name: 'recent', isView: true },
      ],
    });
  });

  it('takes a bucket as its two collections, once, also when one of them is selected with it', () => {
    const bucket: CopiedNode = { kind: 'bucket', connectionId: 'a', database: 'shop', bucket: 'photos' };
    expect(clipboardOf([collection('a', 'shop', 'photos.files'), bucket, collection('a', 'shop', 'orders')])).toEqual({
      kind: 'collection',
      connectionId: 'a',
      database: 'shop',
      collections: [
        { name: 'photos.files', isView: false, bucket: 'photos' },
        { name: 'photos.chunks', isView: false, bucket: 'photos' },
        { name: 'orders', isView: false },
      ],
    });
    // Alone, a bucket's collection is a collection like any other.
    expect(clipboardOf([collection('a', 'shop', 'photos.files')])).toMatchObject({ collections: [{ name: 'photos.files', isView: false }] });
  });

  it('refuses nothing, mixed kinds, other nodes, and databases or collections from different places', () => {
    expect(clipboardOf([])).toBe('Select a connection, a database or a collection to copy it.');
    expect(clipboardOf([connection('a'), database('a', 'shop')])).toBe('Copy only connections, only databases or only collections at a time.');
    expect(clipboardOf([connection('a'), { kind: 'other' }])).toBe('Only connections, databases, collections, views and buckets can be copied.');
    expect(clipboardOf([database('a', 'shop'), database('b', 'shop')])).toBe('Copy the databases of one connection at a time.');
    expect(clipboardOf([collection('a', 'shop', 'orders'), collection('a', 'crm', 'people')])).toBe('Copy the collections of one database at a time.');
  });
});

describe('the name of a copy', () => {
  it('adds "copy" to a connection and "_copy" to a database or collection, then a number', () => {
    expect(copyName('Production', ['Production'], 'label')).toBe('Production copy');
    expect(copyName('Production', ['Production', 'Production copy', 'Production copy 2'], 'label')).toBe('Production copy 3');
    expect(copyName('orders', ['orders'], 'identifier')).toBe('orders_copy');
    expect(copyName('orders', ['orders', 'orders_copy'], 'identifier')).toBe('orders_copy2');
  });
});

describe('where pasted collections go', () => {
  const sources = [
    { name: 'orders', isView: false },
    { name: 'recent', isView: true },
    { name: 'people', isView: false },
  ];

  it('keeps the names in another database, noting what exists there', () => {
    const existing = new Map<string, ExistingKind>([
      ['orders', 'collection'],
      ['recent', 'view'],
    ]);
    expect(planPaste(sources, existing, false)).toEqual([
      { source: 'orders', target: 'orders', isView: false, exists: 'collection' },
      { source: 'recent', target: 'recent', isView: true, exists: 'view' },
      { source: 'people', target: 'people', isView: false },
    ]);
  });

  it('gives free _copy names in the same database', () => {
    const existing = new Map<string, ExistingKind>([
      ['orders', 'collection'],
      ['orders_copy', 'collection'],
      ['recent', 'view'],
      ['people', 'collection'],
    ]);
    expect(planPaste(sources, existing, true).map((i) => [i.target, i.exists])).toEqual([
      ['orders_copy2', undefined],
      ['recent_copy', undefined],
      ['people_copy', undefined],
    ]);
  });

  it('copies a bucket in the same database as another bucket, its two collections together', () => {
    const bucket = [
      { name: 'photos.files', isView: false, bucket: 'photos' },
      { name: 'photos.chunks', isView: false, bucket: 'photos' },
    ];
    const names = (existing: string[]) => planPaste(bucket, new Map(existing.map((n) => [n, 'collection' as ExistingKind])), true).map((i) => i.target);
    expect(names(['photos.files', 'photos.chunks'])).toEqual(['photos_copy.files', 'photos_copy.chunks']);
    // A name is taken when either collection of that bucket is there.
    expect(names(['photos.files', 'photos.chunks', 'photos_copy.chunks'])).toEqual(['photos_copy2.files', 'photos_copy2.chunks']);
    expect(planPaste(bucket, new Map(), false).map((i) => i.target)).toEqual(['photos.files', 'photos.chunks']);
  });

  it('creates what is new, and treats what exists by the mode chosen', () => {
    const item = (isView: boolean, exists?: ExistingKind) => ({ source: 'x', target: 'x', isView, exists });
    expect(pasteAction(item(false), 'skip')).toEqual({ do: 'create' });
    expect(pasteAction(item(false, 'collection'), 'skip')).toEqual({ do: 'skip', why: 'it exists' });
    expect(pasteAction(item(false, 'collection'), 'append')).toEqual({ do: 'append' });
    expect(pasteAction(item(false, 'collection'), 'upsert')).toEqual({ do: 'upsert' });
    expect(pasteAction(item(false, 'view'), 'drop')).toEqual({ do: 'drop' });
  });

  it('never appends to a view or from one: those stay, unless they are dropped', () => {
    const item = (isView: boolean, exists: ExistingKind) => ({ source: 'x', target: 'x', isView, exists });
    expect(pasteAction(item(true, 'view'), 'append')).toEqual({ do: 'skip', why: 'the view exists' });
    expect(pasteAction(item(true, 'collection'), 'upsert')).toEqual({ do: 'skip', why: 'a collection has this name' });
    expect(pasteAction(item(false, 'view'), 'append')).toEqual({ do: 'skip', why: 'a view has this name' });
    expect(pasteAction(item(true, 'view'), 'drop')).toEqual({ do: 'drop' });
  });
});

describe('the copy of a connection', () => {
  function context() {
    const state: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    const ctx = {
      globalState: {
        keys: () => Object.keys(state),
        get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
        update: async (key: string, value: unknown) => {
          if (value === undefined) delete state[key];
          else state[key] = value;
        },
      },
      secrets: {
        get: async (key: string) => secrets[key],
        store: async (key: string, value: string) => void (secrets[key] = value),
        delete: async (key: string) => void delete secrets[key],
      },
    };
    return { ctx: ctx as unknown as ExtensionContext, state, secrets };
  }

  it('has the settings, the secrets and the formatting rules of the connection, under a new id', async () => {
    const { ctx, state, secrets } = context();
    const connections = new ConnectionManager(ctx);
    const source = await connections.add('Production', 'mongodb://user:secret@db.example:27017', 'Work', { ssh: { host: 'bastion', username: 'me' } } as never);
    await connections.setRedisOplog(source.id, { url: 'redis://cache:6379', settings: {} as never });
    await connections.update(source.id, { color: 'red', readOnly: true, exclusions: ['shop.logs'], collectionColors: { 'shop.orders': 'blue' } });
    state[`mongoster.formattingConnection.${source.id}`] = [{ id: 'r1' }];
    state[`mongoster.formattingDatabase.${source.id}/shop`] = [{ id: 'r2' }];
    state[`mongoster.formatting.${source.id}/shop/orders`] = [{ id: 'r3' }];

    const copy = await connections.duplicate(source.id, 'Production copy', 'Local');

    expect(copy).toMatchObject({ name: 'Production copy', folder: 'Local', color: 'red', readOnly: true, exclusions: ['shop.logs'], collectionColors: { 'shop.orders': 'blue' }, ssh: 'me@bastion' });
    expect(copy!.id).not.toBe(source.id);
    expect(connections.list().map((c) => c.name)).toEqual(['Production', 'Production copy']);
    expect(await connections.uri(copy!.id)).toBe('mongodb://user:secret@db.example:27017');
    expect(await connections.options(copy!.id)).toEqual({ ssh: { host: 'bastion', username: 'me' } });
    expect(await connections.redisUrl(copy!.id)).toBe('redis://cache:6379');
    expect(state[`mongoster.formattingConnection.${copy!.id}`]).toEqual([{ id: 'r1' }]);
    expect(state[`mongoster.formattingDatabase.${copy!.id}/shop`]).toEqual([{ id: 'r2' }]);
    expect(state[`mongoster.formatting.${copy!.id}/shop/orders`]).toBeUndefined();
    expect(Object.keys(secrets)).toHaveLength(6);
  });

  it('goes to the top level without a folder, and is nothing for a removed connection', async () => {
    const { ctx } = context();
    const connections = new ConnectionManager(ctx);
    const source = await connections.add('Local', 'mongodb://localhost', 'Work');
    expect((await connections.duplicate(source.id, 'Local copy'))?.folder).toBeUndefined();
    expect(await connections.duplicate('gone', 'x')).toBeUndefined();
  });
});
