import * as vscode from 'vscode';
import { MongoClient } from 'mongodb';
import { ConnectionOptions, HostKeyCheck, openClient, SshTunnel } from './transport';
import type { RedisOplogSettings } from './shared/oplog';

export const CONNECTION_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type ConnectionColor = (typeof CONNECTION_COLORS)[number];

export interface ConnectionInfo {
  id: string;
  name: string;
  /** Folder grouping the connection in the tree. */
  folder?: string;
  /** Marks the connection (tree icon, stripe on its collection tabs), e.g. red for production. */
  color?: ConnectionColor;
  /** Mongoster refuses every write through this connection. */
  readOnly?: boolean;
  /** Writes through this connection aren't kept in the undo history. */
  noHistory?: boolean;
  /** "user@host:port" of the SSH server the connection goes through (the options are secret). */
  ssh?: string;
  /** TLS certificates or options are set. */
  tls?: boolean;
  /** Writes through this connection are published to Redis for redis-oplog (the Redis URL is secret). */
  redisOplog?: RedisOplogSettings;
}

const STATE_KEY = 'mongoster.connections';
const secretKey = (id: string) => `mongoster.uri.${id}`;
const optionsKey = (id: string) => `mongoster.options.${id}`;
const redisKey = (id: string) => `mongoster.redis.${id}`;
const KNOWN_HOSTS_KEY = 'mongoster.knownHosts';

const CLIENT_OPTIONS = { appName: 'mongoster', serverSelectionTimeoutMS: 10_000 };

/** Persists connections (names in globalState, URIs in SecretStorage) and caches live MongoClients. */
export class ConnectionManager implements vscode.Disposable {
  private readonly clients = new Map<string, Promise<MongoClient>>();
  private readonly tunnels = new Map<string, SshTunnel>();
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

  async add(name: string, uri: string, folder?: string, options?: ConnectionOptions): Promise<ConnectionInfo> {
    const info: ConnectionInfo = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      ...(folder && { folder }),
      ...describe(options),
    };
    await this.context.secrets.store(secretKey(info.id), uri);
    if (options?.ssh || options?.tls) await this.context.secrets.store(optionsKey(info.id), JSON.stringify(options));
    await this.context.globalState.update(STATE_KEY, [...this.list(), info]);
    this.changeEmitter.fire();
    return info;
  }

  /** Changes the connection's settings; a new connection string closes the current client. */
  async update(id: string, changes: Partial<Omit<ConnectionInfo, 'id'>>, uri?: string): Promise<ConnectionInfo | undefined> {
    const current = this.get(id);
    if (!current) return undefined;
    const info: ConnectionInfo = { ...current, ...changes };
    for (const key of ['folder', 'color', 'readOnly', 'noHistory', 'ssh', 'tls', 'redisOplog'] as const) if (!info[key]) delete info[key];
    if (uri !== undefined && uri !== (await this.uri(id))) {
      await this.context.secrets.store(secretKey(id), uri);
      await this.disconnect(id);
    }
    await this.context.globalState.update(
      STATE_KEY,
      this.list().map((c) => (c.id === id ? info : c)),
    );
    this.changeEmitter.fire();
    return info;
  }

  /** Renames a folder, or removes it (`to` undefined) moving its connections to the top level. */
  async renameFolder(from: string, to: string | undefined): Promise<void> {
    await this.context.globalState.update(
      STATE_KEY,
      this.list().map((c) => {
        if (c.folder !== from) return c;
        const { folder: _, ...rest } = c;
        return to ? { ...rest, folder: to } : rest;
      }),
    );
    this.changeEmitter.fire();
  }

  folders(): string[] {
    return [...new Set(this.list().flatMap((c) => (c.folder ? [c.folder] : [])))].sort((a, b) => a.localeCompare(b));
  }

  uri(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }

  async options(id: string): Promise<ConnectionOptions | undefined> {
    const text = await this.context.secrets.get(optionsKey(id));
    if (!text) return undefined;
    try {
      return JSON.parse(text) as ConnectionOptions;
    } catch {
      return undefined;
    }
  }

  /** Replaces the TLS / SSH options (and reconnects on next use). */
  async setOptions(id: string, options: ConnectionOptions | undefined): Promise<ConnectionInfo | undefined> {
    if (options?.ssh || options?.tls) await this.context.secrets.store(optionsKey(id), JSON.stringify(options));
    else await this.context.secrets.delete(optionsKey(id));
    await this.disconnect(id);
    const { ssh, tls } = describe(options);
    return this.update(id, { ssh, tls });
  }

  redisUrl(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(redisKey(id));
  }

  /** Turns the publishing to Redis for redis-oplog on (with the Redis URL) or off (`redis` undefined). */
  async setRedisOplog(id: string, redis: { url: string; settings: RedisOplogSettings } | undefined): Promise<ConnectionInfo | undefined> {
    if (redis) await this.context.secrets.store(redisKey(id), redis.url);
    else await this.context.secrets.delete(redisKey(id));
    return this.update(id, { redisOplog: redis?.settings });
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.context.secrets.delete(secretKey(id));
    await this.context.secrets.delete(optionsKey(id));
    await this.context.secrets.delete(redisKey(id));
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
    const { client, tunnel } = await openClient(uri, await this.options(id), CLIENT_OPTIONS, this.checkHostKey);
    if (tunnel) {
      this.tunnels.set(id, tunnel);
      // The SSH connection dropped: the next use reconnects.
      tunnel.onClose(() => {
        if (this.tunnels.get(id) === tunnel) void this.disconnect(id);
      });
    }
    this.connected.add(id);
    this.changeEmitter.fire();
    return client;
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    const tunnel = this.tunnels.get(id);
    this.clients.delete(id);
    this.tunnels.delete(id);
    if (this.connected.delete(id)) this.changeEmitter.fire();
    await client?.then((c) => c.close()).catch(() => undefined);
    tunnel?.close();
  }

  /** Connects once and returns the server version. */
  static async test(uri: string, options?: ConnectionOptions, checkHostKey?: HostKeyCheck): Promise<string> {
    const { client, tunnel } = await openClient(uri, options, { ...CLIENT_OPTIONS, serverSelectionTimeoutMS: 5_000 }, checkHostKey ?? (async () => false));
    try {
      const info = await client.db('admin').command({ buildInfo: 1 });
      return String(info.version ?? '');
    } finally {
      await client.close().catch(() => undefined);
      tunnel?.close();
    }
  }

  /**
   * Trust on first use: an unknown SSH host key is shown for confirmation and remembered; a different key
   * than the remembered one is a warning (it may be an attack) that needs an explicit confirmation.
   */
  readonly checkHostKey: HostKeyCheck = async (host, fingerprint) => {
    const known = this.context.globalState.get<Record<string, string>>(KNOWN_HOSTS_KEY, {});
    if (known[host] === fingerprint) return true;
    const answer = known[host]
      ? await vscode.window.showWarningMessage(
          `The SSH host key of ${host} has changed!`,
          {
            modal: true,
            detail: `Remembered: ${known[host]}\nNow: ${fingerprint}\n\nThe server may have been reinstalled, or someone may be intercepting the connection. Trust the new key only if you know why it changed.`,
          },
          'Trust New Key',
        )
      : await vscode.window.showWarningMessage(
          `Trust the SSH server ${host}?`,
          { modal: true, detail: `Its host key fingerprint is\n${fingerprint}\n\nCompare it with the one of the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) before trusting it. It is remembered for the next connections.` },
          'Trust',
        );
    if (answer !== 'Trust' && answer !== 'Trust New Key') return false;
    await this.context.globalState.update(KNOWN_HOSTS_KEY, { ...known, [host]: fingerprint });
    return true;
  };

  dispose(): void {
    for (const id of [...this.clients.keys()]) void this.disconnect(id);
    this.changeEmitter.dispose();
  }
}

/** The non-secret summary of the options, kept on the connection for the tree. */
function describe(options: ConnectionOptions | undefined): Pick<ConnectionInfo, 'ssh' | 'tls'> {
  const ssh = options?.ssh;
  return {
    ssh: ssh ? `${ssh.username}@${ssh.host}${ssh.port && ssh.port !== 22 ? `:${ssh.port}` : ''}` : undefined,
    tls: options?.tls ? true : undefined,
  };
}
