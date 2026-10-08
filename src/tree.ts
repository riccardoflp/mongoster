import * as vscode from 'vscode';
import { ConnectionInfo, ConnectionManager } from './connections';

export class ConnectionNode extends vscode.TreeItem {
  readonly kind = 'connection';
  constructor(
    readonly info: ConnectionInfo,
    connected: boolean,
  ) {
    super(info.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `conn:${info.id}`;
    this.contextValue = connected ? 'connection.connected' : 'connection';
    this.iconPath = new vscode.ThemeIcon(
      'server',
      connected ? new vscode.ThemeColor('testing.iconPassed') : undefined,
    );
  }
}

export class DatabaseNode extends vscode.TreeItem {
  readonly kind = 'database';
  constructor(
    readonly connection: ConnectionInfo,
    readonly database: string,
    sizeOnDisk?: number,
  ) {
    super(database, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `db:${connection.id}/${database}`;
    this.contextValue = 'database';
    this.iconPath = new vscode.ThemeIcon('database');
    if (sizeOnDisk !== undefined) this.description = formatBytes(sizeOnDisk);
  }
}

export class CollectionNode extends vscode.TreeItem {
  readonly kind = 'collection';
  constructor(
    readonly connection: ConnectionInfo,
    readonly database: string,
    readonly collection: string,
    readonly isView: boolean,
  ) {
    super(collection, vscode.TreeItemCollapsibleState.None);
    this.id = `coll:${connection.id}/${database}/${collection}`;
    this.contextValue = isView ? 'view' : 'collection';
    this.iconPath = new vscode.ThemeIcon(isView ? 'eye' : 'table');
    this.tooltip = `${database}.${collection}${isView ? ' (view)' : ''}`;
    this.command = {
      command: 'mongoster.openCollection',
      title: 'Open Collection',
      arguments: [this],
    };
  }
}

class MessageNode extends vscode.TreeItem {
  readonly kind = 'message';
  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = message;
  }
}

export type TreeNode = ConnectionNode | DatabaseNode | CollectionNode | MessageNode;

export class MongoTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly connections: ConnectionManager) {
    connections.onDidChange(() => this.refresh());
  }

  refresh(node?: TreeNode): void {
    this.changeEmitter.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!node) {
        return this.connections
          .list()
          .map((c) => new ConnectionNode(c, this.connections.isConnected(c.id)));
      }
      if (node instanceof ConnectionNode) return await this.databases(node.info);
      if (node instanceof DatabaseNode) return await this.collections(node);
      return [];
    } catch (err) {
      return [new MessageNode(errorMessage(err), 'error')];
    }
  }

  private async databases(info: ConnectionInfo): Promise<TreeNode[]> {
    const client = await this.connections.getClient(info.id);
    try {
      const res = await client.db('admin').admin().listDatabases({ authorizedDatabases: true });
      const dbs = res.databases
        .map((d) => new DatabaseNode(info, d.name, d.sizeOnDisk))
        .sort((a, b) => a.database.localeCompare(b.database));
      return dbs.length ? dbs : [new MessageNode('No databases')];
    } catch {
      // Users without listDatabases privileges: fall back to the database named in the URI.
      return [new DatabaseNode(info, client.options.dbName)];
    }
  }

  private async collections(node: DatabaseNode): Promise<TreeNode[]> {
    const client = await this.connections.getClient(node.connection.id);
    const infos = await client
      .db(node.database)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray();
    const colls = infos
      .map((c) => new CollectionNode(node.connection, node.database, c.name, c.type === 'view'))
      .sort(
        (a, b) =>
          Number(a.collection.startsWith('system.')) - Number(b.collection.startsWith('system.')) ||
          a.collection.localeCompare(b.collection),
      );
    return colls.length ? colls : [new MessageNode('No collections')];
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
