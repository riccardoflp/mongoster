// Excluding connections, databases and collections from searches: the pure rules, the tree (its nodes, menus and
// filter), the decorations that dim them, the global search's plan, the MCP lists, the connection files, and the
// type-ahead of the desktop app's tree.
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import pkg from '../../package.json';
import type { ConnectionInfo, ConnectionManager } from '../../src/connections';
import { ConnectionDecorations, connectionUri } from '../../src/connectionColors';
import { mcpTools, type ToolHost } from '../../src/mcpTools';
import type { WorkspaceHost } from '../../src/mcp/workspace';
import { parseConnections, serializeConnections, type PortableConnection } from '../../src/shared/connectionsFile';
import {
  bucketExclusionKey,
  dropExclusions,
  exclusionKey,
  isExcluded,
  leaveOutExcluded,
  ownExclusion,
  readExclusions,
  renameExclusion,
  setExclusions,
} from '../../src/shared/exclusions';
import { TYPE_AHEAD_RESET_MS, typeAheadTarget, typedText } from '../../src/shared/typeAhead';
import { BucketNode, CollectionNode, ConnectionNode, DatabaseNode, MongoTreeProvider, type TreeNode } from '../../src/tree';

const prod: ConnectionInfo = { id: 'p1', name: 'prod', color: 'red', exclusions: ['archive', 'shop.logs', 'shop.fs.files'] };

describe('the rules of exclusion', () => {
  it('excludes a database with its collections, and a collection alone', () => {
    expect(isExcluded(prod, 'archive')).toBe(true);
    expect(isExcluded(prod, 'archive', 'old')).toBe(true);
    expect(ownExclusion(prod, 'archive', 'old')).toBe(false);
    expect(isExcluded(prod, 'shop', 'logs')).toBe(true);
    expect(isExcluded(prod, 'shop')).toBe(false);
    expect(isExcluded(prod, 'shop', 'orders')).toBe(false);
    expect(isExcluded(undefined, 'shop', 'orders')).toBe(false);
  });

  it('keys a database by its name, a collection by its namespace and a bucket by its .files collection', () => {
    expect(exclusionKey('shop')).toBe('shop');
    expect(exclusionKey('shop', 'a.b')).toBe('shop.a.b');
    expect(bucketExclusionKey('shop', 'fs')).toBe('shop.fs.files');
  });

  it('adds and removes entries, sorted and without repeats, and forgets an empty list', () => {
    expect(setExclusions(undefined, ['shop.b', 'shop.a', 'shop.b'], true)).toEqual(['shop.a', 'shop.b']);
    expect(setExclusions(['shop.a'], ['shop.a'], false)).toBeUndefined();
    expect(setExclusions(['shop.a'], [], true)).toEqual(['shop.a']);
  });

  it('moves the entry of a renamed collection, and leaves the list alone without one', () => {
    expect(renameExclusion(['shop.logs'], 'shop.logs', 'shop.events')).toEqual(['shop.events']);
    const list = ['shop.logs'];
    expect(renameExclusion(list, 'shop.orders', 'shop.sales')).toBe(list);
    expect(renameExclusion(undefined, 'shop.orders', 'shop.sales')).toBeUndefined();
  });

  it('forgets the entries of a dropped collection, bucket or database', () => {
    const list = ['shop', 'shop.logs', 'shop.fs.files', 'shop.fs.chunks', 'shopping.x'];
    expect(dropExclusions(list, 'shop', 'logs')).toEqual(['shop', 'shop.fs.files', 'shop.fs.chunks', 'shopping.x']);
    expect(dropExclusions(list, 'shop', 'fs', true)).toEqual(['shop', 'shop.logs', 'shopping.x']);
    expect(dropExclusions(list, 'shop')).toEqual(['shopping.x']);
    expect(dropExclusions(list, 'other')).toBe(list);
  });

  it('reads only valid entries from a file', () => {
    expect(readExclusions(['shop', 'shop.logs', '.x', 3, ''])).toEqual(['shop', 'shop.logs']);
    expect(readExclusions('shop')).toBeUndefined();
    expect(readExclusions([])).toBeUndefined();
  });

  it('leaves the excluded out of a search over a deployment or a database', () => {
    expect(leaveOutExcluded(prod, ['archive', 'shop', 'test'])).toEqual(['shop', 'test']);
    expect(leaveOutExcluded(prod, ['logs', 'orders', 'fs.files'], 'shop')).toEqual(['orders']);
    // A search started on an excluded database reads it; only its collections' own entries count.
    expect(leaveOutExcluded(prod, ['old', 'new'], 'archive')).toEqual(['old', 'new']);
  });
});

describe('the tree', () => {
  it('dims an excluded collection, view or bucket and offers Include in Searches', () => {
    const logs = new CollectionNode(prod, 'shop', 'logs', false);
    expect(logs.contextValue).toBe('collection.excluded');
    expect(logs.description).toBe('excluded');
    expect((logs.iconPath as vscode.ThemeIcon).color?.id).toBe('disabledForeground');
    expect(logs.resourceUri?.toString()).toBe(connectionUri('p1', 'shop', 'logs').toString());
    expect(new BucketNode(prod, 'shop', 'fs').contextValue).toBe('bucket.excluded');
    expect(new BucketNode(prod, 'shop', 'fs').description).toBe('excluded · GridFS');
    const orders = new CollectionNode(prod, 'shop', 'orders', true);
    expect(orders.contextValue).toBe('view');
    expect(orders.resourceUri).toBeUndefined();
    expect((orders.iconPath as vscode.ThemeIcon).color?.id).toBe('charts.red');
  });

  it('dims the collections of an excluded database without offering to include them one by one', () => {
    const db = new DatabaseNode(prod, 'archive');
    expect(db.contextValue).toBe('database.excluded');
    expect(db.description).toBe('excluded');
    const old = new CollectionNode(prod, 'archive', 'old', false);
    expect(old.contextValue).toBe('collection');
    expect(old.description).toBe('excluded with its database');
    expect((old.iconPath as vscode.ThemeIcon).color?.id).toBe('disabledForeground');
  });

  it('dims an excluded connection and says so', () => {
    const node = new ConnectionNode({ ...prod, excluded: true }, true, 0, 1);
    expect(node.contextValue).toBe('connection.connected.excluded');
    expect(node.description).toBe('excluded · connected');
    expect((node.iconPath as vscode.ThemeIcon).color?.id).toBe('disabledForeground');
    // The filter opens a connected connection, but not an excluded one.
    expect(node.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(new ConnectionNode(prod, true, 0, 1).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it('offers Exclude From Searches and Include in Searches, and keeps the other entries, on excluded nodes', async () => {
    const { evaluate } = await import('../../src/standalone/vscode/contributions');
    const entries = pkg.contributes.menus['view/item/context'];
    const offered = (viewItem: string) =>
      entries.filter((e) => evaluate(e.when, { view: 'mongoster.connections', viewItem })).map((e) => e.command);
    for (const viewItem of ['connection', 'connection.connected.readonly', 'database', 'collection', 'view.readonly', 'bucket']) {
      expect(offered(viewItem)).toContain('mongoster.exclude');
      expect(offered(viewItem)).not.toContain('mongoster.include');
      // The other entries of an excluded node are those of the same node not excluded.
      const excluded = offered(`${viewItem}.excluded`);
      expect(excluded).toContain('mongoster.include');
      expect(excluded).not.toContain('mongoster.exclude');
      expect(excluded.filter((c) => c !== 'mongoster.include')).toEqual(offered(viewItem).filter((c) => c !== 'mongoster.exclude'));
    }
    expect(offered('folder')).not.toContain('mongoster.exclude');
  });
});

/** A connection manager whose server has the databases and collections of `server`. */
function fakeConnections(list: ConnectionInfo[], server: Record<string, string[]>) {
  const changed = new vscode.EventEmitter<void>();
  const client = {
    db: (name: string) => ({
      admin: () => ({ listDatabases: async () => ({ databases: Object.keys(server).map((d) => ({ name: d, sizeOnDisk: 0, empty: false })) }) }),
      listCollections: () => ({ toArray: async () => (server[name] ?? []).map((c) => ({ name: c, type: 'collection' })) }),
    }),
    options: { dbName: 'test' },
  };
  return {
    list: () => list,
    get: (id: string) => list.find((c) => c.id === id),
    folders: () => [],
    isConnected: () => true,
    getClient: async () => client,
    onDidChange: changed.event,
    fire: () => changed.fire(),
  };
}

describe("the tree's filter", () => {
  const server = { archive: ['orders_2019'], shop: ['logs', 'orders', 'fs.files', 'fs.chunks'], test: ['orders'] };
  const labels = (nodes: TreeNode[]) => nodes.map((n) => String(n.label));

  it('leaves out the excluded databases and collections', async () => {
    const tree = new MongoTreeProvider(fakeConnections([prod], server) as unknown as ConnectionManager);
    tree.setFilter('o');
    const [connection] = await tree.getChildren();
    const databases = await tree.getChildren(connection);
    expect(labels(databases)).toEqual(['shop', 'test']);
    expect(labels(await tree.getChildren(databases[0]))).toEqual(['fs.chunks', 'orders']);
  });

  it('shows everything, dimmed, without a filter', async () => {
    const tree = new MongoTreeProvider(fakeConnections([prod], server) as unknown as ConnectionManager);
    const [connection] = await tree.getChildren();
    const databases = await tree.getChildren(connection);
    expect(labels(databases)).toEqual(['archive', 'shop', 'test']);
    expect(labels(await tree.getChildren(databases[1]))).toEqual(['fs', 'fs.chunks', 'fs.files', 'logs', 'orders']);
  });
});

describe('the decorations', () => {
  it('dim the names of what is excluded, and leave the rest below a connection alone', () => {
    const list: ConnectionInfo[] = [prod, { id: 'x1', name: 'old', excluded: true }];
    const decorations = new ConnectionDecorations(fakeConnections(list, {}) as unknown as ConnectionManager, ['mongoster']);
    expect(decorations.provideFileDecoration(connectionUri('x1'))?.color?.id).toBe('disabledForeground');
    expect(decorations.provideFileDecoration(connectionUri('p1'))?.color?.id).toBe('charts.red');
    expect(decorations.provideFileDecoration(connectionUri('p1', 'shop', 'logs'))?.color?.id).toBe('disabledForeground');
    expect(decorations.provideFileDecoration(connectionUri('p1', 'archive', 'old'))?.color?.id).toBe('disabledForeground');
    expect(decorations.provideFileDecoration(connectionUri('p1', 'shop', 'orders'))).toBeUndefined();
    expect(decorations.provideFileDecoration(connectionUri('p1', 'shop', 'fs.files'))?.color?.id).toBe('disabledForeground');
  });

  it('tell the decorations changed when what is excluded changed', () => {
    const list: ConnectionInfo[] = [{ ...prod }];
    const connections = fakeConnections(list, {});
    const decorations = new ConnectionDecorations(connections as unknown as ConnectionManager, ['mongoster']);
    let fired = 0;
    decorations.onDidChangeFileDecorations(() => fired++);
    list[0].excluded = true;
    connections.fire();
    list[0].exclusions = ['shop'];
    connections.fire();
    expect(fired).toBe(2);
  });
});

describe('the lists of the MCP server', () => {
  const server = { archive: ['old'], shop: ['logs', 'orders'] };
  const tools = (list: ConnectionInfo[]) => {
    const connections = fakeConnections(list, server);
    const host: ToolHost = {
      connections: { list: connections.list, getClient: connections.getClient as unknown as ToolHost['connections']['getClient'], isConnected: () => false },
      openSearch: () => undefined,
      readDocuments: () => true,
      workspace: {} as WorkspaceHost,
    };
    return Object.fromEntries(mcpTools(host).map((t) => [t.name, t]));
  };

  it('leave out the excluded connections, databases and collections', async () => {
    const t = tools([prod, { id: 'x1', name: 'old', excluded: true }]);
    expect(JSON.parse(await t.list_connections.run({})).map((c: { name: string }) => c.name)).toEqual(['prod']);
    expect(JSON.parse(await t.list_databases.run({ connection: 'prod' })).map((d: { name: string }) => d.name)).toEqual(['shop']);
    expect(JSON.parse(await t.list_collections.run({ connection: 'prod', database: 'shop' })).map((c: { name: string }) => c.name)).toEqual(['orders']);
  });

  it('still answer for what is asked for by name, and say when everything is excluded', async () => {
    const t = tools([{ ...prod, excluded: true }]);
    expect(await t.list_connections.run({})).toBe('The user excluded every connection saved in Mongoster from searches.');
    expect(JSON.parse(await t.list_databases.run({ connection: 'prod' })).map((d: { name: string }) => d.name)).toEqual(['shop']);
    expect(await t.list_collections.run({ connection: 'prod', database: 'archive' })).toEqual(expect.stringContaining('"old"'));
  });
});

describe('the exclusions in connection files', () => {
  const excluded: PortableConnection = { name: 'prod', uri: 'mongodb://h/shop', excluded: true, exclusions: ['archive', 'shop.logs'], notes: [] };

  it("travel in Mongoster's format, and a file without them reads as before", async () => {
    const out = await serializeConnections([excluded], 'mongoster', { secrets: 'remove' });
    expect(JSON.parse(out.text).connections[0]).toMatchObject({ excluded: true, exclusions: ['archive', 'shop.logs'] });
    expect((await parseConnections(out.text)).connections).toEqual([excluded]);
    const plain = JSON.stringify({ type: 'Mongoster Connections', version: 1, connections: [{ name: 'a', uri: 'mongodb://h/db' }] });
    const [read] = (await parseConnections(plain)).connections;
    expect(read).not.toHaveProperty('excluded');
    expect(read).not.toHaveProperty('exclusions');
  });

  it("are left out of Compass's format and of a list, which say so", async () => {
    expect((await serializeConnections([excluded], 'compass', { secrets: 'remove' })).notes).toContain("exclusions from searches were left out (Compass doesn't have them)");
    expect((await serializeConnections([excluded], 'list', { secrets: 'remove' })).notes).toContain('exclusions from searches were left out');
  });
});

describe("the type-ahead of the desktop app's tree", () => {
  const labels = ['local', 'Orders', 'orders_2019', 'products', 'Shop', 'sessions'];

  it('moves to the next name starting with the letter, round to the first, ignoring case', () => {
    expect(typeAheadTarget(labels, -1, 'o')).toBe(1);
    expect(typeAheadTarget(labels, 1, 'o')).toBe(2);
    expect(typeAheadTarget(labels, 2, 'o')).toBe(1);
    expect(typeAheadTarget(labels, 0, 'S')).toBe(4);
    expect(typeAheadTarget(labels, 0, 'x')).toBe(-1);
  });

  it('goes to the next one when the same letter is typed again, and refines the name with other letters', () => {
    expect(typeAheadTarget(labels, 4, 'ss')).toBe(5);
    expect(typeAheadTarget(labels, 1, 'or')).toBe(1);
    expect(typeAheadTarget(labels, 1, 'orders_')).toBe(2);
    expect(typeAheadTarget(labels, 3, 'se')).toBe(5);
  });

  it('starts a new name after a pause', () => {
    expect(typedText('o', 'r', 100)).toBe('or');
    expect(typedText('o', 'p', TYPE_AHEAD_RESET_MS + 1)).toBe('p');
  });
});
