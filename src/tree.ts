import * as vscode from 'vscode';
import { ConnectionInfo, ConnectionManager } from './connections';
import { bucketNames } from './shared/gridfs';

export class FolderNode extends vscode.TreeItem {
  readonly kind = 'folder';
  constructor(readonly folder: string) {
    super(folder, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folder}`;
    this.contextValue = 'folder';
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

export class ConnectionNode extends vscode.TreeItem {
  readonly kind = 'connection';
  constructor(
    readonly info: ConnectionInfo,
    connected: boolean,
  ) {
    super(info.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `conn:${info.id}`;
    this.contextValue = `connection${connected ? '.connected' : ''}${info.readOnly ? '.readonly' : ''}`;
    // The connection's color wins over the green "connected" tint; the description then says it.
    const color = info.color ? `charts.${info.color}` : connected ? 'testing.iconPassed' : undefined;
    this.iconPath = new vscode.ThemeIcon(info.readOnly ? 'lock' : 'server', color ? new vscode.ThemeColor(color) : undefined);
    this.description = [info.readOnly && 'read-only', info.ssh && 'SSH', connected && (info.color || info.readOnly) && 'connected'].filter(Boolean).join(' · ');
    this.tooltip = [
      `${info.name}${connected ? ' (connected)' : ''}`,
      info.readOnly && 'Read-only: Mongoster refuses writes through this connection',
      info.ssh && `Through the SSH tunnel ${info.ssh}`,
      info.tls && 'TLS certificates or options set',
    ]
      .filter(Boolean)
      .join('\n');
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
    this.contextValue = connection.readOnly ? 'database.readonly' : 'database';
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
    this.contextValue = `${isView ? 'view' : 'collection'}${connection.readOnly ? '.readonly' : ''}`;
    this.iconPath = new vscode.ThemeIcon(isView ? 'eye' : 'table');
    this.tooltip = `${database}.${collection}${isView ? ' (view)' : ''}`;
    this.command = {
      command: 'mongoster.openCollection',
      title: 'Open Collection',
      arguments: [this],
    };
  }
}

/** A GridFS bucket: its X.files and X.chunks collections. */
export class BucketNode extends vscode.TreeItem {
  readonly kind = 'bucket';
  constructor(
    readonly connection: ConnectionInfo,
    readonly database: string,
    readonly bucket: string,
  ) {
    super(bucket, vscode.TreeItemCollapsibleState.None);
    this.id = `bucket:${connection.id}/${database}/${bucket}`;
    this.description = 'GridFS';
    this.contextValue = `bucket${connection.readOnly ? '.readonly' : ''}`;
    this.iconPath = new vscode.ThemeIcon('files');
    this.tooltip = `GridFS bucket ${database}.${bucket} (${bucket}.files and ${bucket}.chunks)`;
    this.command = { command: 'mongoster.openGridFS', title: 'Open GridFS Bucket', arguments: [this] };
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

export type TreeNode = FolderNode | ConnectionNode | DatabaseNode | BucketNode | CollectionNode | MessageNode;

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
      const connectionNode = (c: ConnectionInfo) => new ConnectionNode(c, this.connections.isConnected(c.id));
      if (!node) {
        return [
          ...this.connections.folders().map((f) => new FolderNode(f)),
          ...this.connections.list().filter((c) => !c.folder).map(connectionNode),
        ];
      }
      if (node instanceof FolderNode) return this.connections.list().filter((c) => c.folder === node.folder).map(connectionNode);
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
    // GridFS buckets first; their collections stay listed too.
    const buckets = bucketNames(infos.map((c) => c.name)).map((b) => new BucketNode(node.connection, node.database, b));
    return colls.length ? [...buckets, ...colls] : [new MessageNode('No collections')];
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
