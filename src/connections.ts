import * as vscode from 'vscode';
import { MongoClient } from 'mongodb';

export interface ConnectionInfo {
  id: string;
  name: string;
}

const STATE_KEY = 'mongoster.connections';
const secretKey = (id: string) => `mongoster.uri.${id}`;

const CLIENT_OPTIONS = { appName: 'mongoster', serverSelectionTimeoutMS: 10_000 };

/** Persists connections (names in globalState, URIs in SecretStorage) and caches live MongoClients. */
export class ConnectionManager implements vscode.Disposable {
  private readonly clients = new Map<string, Promise<MongoClient>>();
  private readonly connected = new Set<string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionInfo[] {
    return this.context.globalState.get<ConnectionInfo[]>(STATE_KEY, []);
  }

  get(id: string): ConnectionInfo | undefined {
    return this.list().find((c) => c.id === id);
  }

  isConnected(id: string): boolean {
    return this.connected.has(id);
  }

  async add(name: string, uri: string): Promise<ConnectionInfo> {
    const info: ConnectionInfo = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name };
    await this.context.secrets.store(secretKey(info.id), uri);
    await this.context.globalState.update(STATE_KEY, [...this.list(), info]);
    this.changeEmitter.fire();
    return info;
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.context.secrets.delete(secretKey(id));
    await this.context.globalState.update(
      STATE_KEY,
      this.list().filter((c) => c.id !== id),
    );
    this.changeEmitter.fire();
  }

  getClient(id: string): Promise<MongoClient> {
    let client = this.clients.get(id);
    if (!client) {
      client = this.connect(id);
      this.clients.set(id, client);
      client.catch(() => this.clients.delete(id));
    }
    return client;
  }

  private async connect(id: string): Promise<MongoClient> {
    const uri = await this.context.secrets.get(secretKey(id));
    if (!uri) throw new Error('Connection string not found. Remove and re-add this connection.');
    const client = await new MongoClient(uri, CLIENT_OPTIONS).connect();
    this.connected.add(id);
    this.changeEmitter.fire();
    return client;
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (this.connected.delete(id)) this.changeEmitter.fire();
    await client?.then((c) => c.close()).catch(() => undefined);
  }

  static async test(uri: string): Promise<void> {
    const client = new MongoClient(uri, { ...CLIENT_OPTIONS, serverSelectionTimeoutMS: 5_000 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  dispose(): void {
    for (const id of [...this.clients.keys()]) void this.disconnect(id);
    this.changeEmitter.dispose();
  }
}
