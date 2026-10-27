// Publishes Mongoster's writes to Redis for redis-oplog, on the connections where it's set: a Meteor app
// with the package then updates its publications as for its own writes. A small RESP client (PUBLISH
// needs no more) keeps one Redis connection per Mongo connection; the events of a connection go out in
// order, and a Redis error never fails the write: it's only shown, at most every half minute.
import * as net from 'net';
import * as tls from 'tls';
import * as vscode from 'vscode';
import { BSON, Collection, Document } from 'mongodb';
import type { ConnectionManager } from './connections';
import { documentFields, inScope, OplogEvent, oplogMessage, RedisOplogSettings, updatedFields } from './shared/oplog';

const TIMEOUT = 5_000;
const BATCH = 1000;
const WARN_EVERY = 30_000;

export interface OplogTarget {
  connectionId: string;
  database: string;
  collection: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const canonical = (v: unknown) => BSON.EJSON.stringify({ v }, { relaxed: false });

class RedisError extends Error {}

/** Host, port and credentials of redis://[user:password@]host[:port] or rediss:// (TLS). */
export function parseRedisUrl(url: string): { host: string; port: number; tls: boolean; username?: string; password?: string } {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `redis://${url}`);
  } catch {
    throw new Error(`Invalid Redis URL: ${url}`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') throw new Error('The Redis URL must start with redis:// or rediss://');
  if (!parsed.hostname) throw new Error('The Redis URL has no host');
  const port = Number(parsed.port || 6379);
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
    port,
    tls: parsed.protocol === 'rediss:',
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

/** A Redis connection that sends commands and reads their replies in order. */
export class RedisConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending: { resolve(v: unknown): void; reject(e: Error): void }[] = [];
  private closed?: Error;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('The Redis connection closed')));
  }

  static async open(url: string): Promise<RedisConnection> {
    const { host, port, tls: secure, username, password } = parseRedisUrl(url);
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Redis ${host}:${port} didn't answer in ${TIMEOUT / 1000} seconds`));
      }, TIMEOUT);
      s.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    socket.setNoDelay(true);
    const conn = new RedisConnection(socket);
    try {
      if (password) await conn.command(username ? ['AUTH', username, password] : ['AUTH', password]);
      await conn.command(['CLIENT', 'SETNAME', 'mongoster']).catch(() => undefined);
    } catch (err) {
      conn.close();
      throw err;
    }
    return conn;
  }

  get alive(): boolean {
    return !this.closed;
  }

  command(args: string[]): Promise<unknown> {
    return this.pipeline([args]).then((r) => r[0]);
  }

  /** Sends the commands in one write; rejects with the first error reply. */
  async pipeline(commands: string[][]): Promise<unknown[]> {
    if (this.closed) throw this.closed;
    const replies = commands.map(() => new Promise<unknown>((resolve, reject) => this.pending.push({ resolve, reject })));
    this.socket.write(Buffer.concat(commands.map(encode)));
    const values = await Promise.all(replies);
    const error = values.find((v) => v instanceof RedisError);
    if (error) throw error;
    return values;
  }

  close(): void {
    this.fail(new Error('The Redis connection closed'));
    this.socket.destroy();
  }

  private fail(err: Error): void {
    this.closed ??= err;
    for (const p of this.pending.splice(0)) p.reject(err);
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const parsed = parseReply(this.buffer, 0);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.end);
      this.pending.shift()?.resolve(parsed.value);
    }
  }
}

function encode(args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(`$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return Buffer.from(parts.join(''));
}

/** One RESP reply from `at`; undefined while incomplete. Error replies are RedisError values. */
function parseReply(buf: Buffer, at: number): { value: unknown; end: number } | undefined {
  const eol = buf.indexOf('\r\n', at);
  if (eol < 0) return undefined;
  const line = buf.toString('utf8', at + 1, eol);
  const next = eol + 2;
  switch (String.fromCharCode(buf[at])) {
    case '+':
      return { value: line, end: next };
    case '-':
      return { value: new RedisError(line), end: next };
    case ':':
      return { value: Number(line), end: next };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, end: next };
      if (buf.length < next + len + 2) return undefined;
      return { value: buf.toString('utf8', next, next + len), end: next + len + 2 };
    }
    case '*': {
      const len = Number(line);
      const items: unknown[] = [];
      let end = next;
      for (let i = 0; i < len; i++) {
        const item = parseReply(buf, end);
        if (!item) return undefined;
        items.push(item.value);
        end = item.end;
      }
      return { value: len < 0 ? null : items, end };
    }
    default:
      // Not RESP: the rest can't be read.
      return { value: new RedisError(`Unexpected reply from Redis: ${buf.toString('utf8', at, Math.min(eol, at + 80))}`), end: buf.length };
  }
}

/** Connects to Redis and checks it answers; returns the message for the connection form. */
export async function testRedis(url: string): Promise<string> {
  const conn = await RedisConnection.open(url);
  try {
    await conn.command(['PING']);
    const { host, port } = parseRedisUrl(url);
    return `Redis ${host}:${port}`;
  } finally {
    conn.close();
  }
}

/** The events of one collection's writes: they are sent in the background, in order. */
export class OplogSink {
  constructor(
    private readonly oplog: RedisOplog,
    readonly target: OplogTarget,
  ) {}

  inserted(ids: unknown[]): void {
    this.publish(ids.filter((id) => id !== undefined && id !== null).map((id) => ({ e: 'i', id })));
  }

  updated(ids: unknown[], fields: string[]): void {
    this.publish(ids.map((id) => ({ e: 'u', id, fields })));
  }

  removed(ids: unknown[]): void {
    this.publish(ids.map((id) => ({ e: 'r', id })));
  }

  publish(events: OplogEvent[]): void {
    if (events.length) this.oplog.enqueue(this.target, events);
  }

  /**
   * The events of a write from the documents it may have touched, as they were before and are now (read
   * the same way, by _id): new ones inserted, missing ones removed, the others updated in the fields that
   * differ.
   */
  changes(before: Document[], after: Document[]): void {
    const was = new Map(before.map((d) => [canonical(d._id), d]));
    const seen = new Set<string>();
    const events: OplogEvent[] = [];
    for (const doc of after) {
      const key = canonical(doc._id);
      if (seen.has(key)) continue;
      seen.add(key);
      const old = was.get(key);
      if (!old) {
        events.push({ e: 'i', id: doc._id });
        continue;
      }
      const fields = documentFields(old, doc).filter((f) => canonical(old[f]) !== canonical(doc[f]));
      if (fields.length) events.push({ e: 'u', id: doc._id, fields });
    }
    for (const [key, old] of was) if (!seen.has(key)) events.push({ e: 'r', id: old._id });
    this.publish(events);
  }

  /** Updates of `ids` by `update`; when its fields aren't known, those of the documents as they are now. */
  async updatedBy(coll: Collection, ids: unknown[], update: unknown): Promise<void> {
    if (!ids.length) return;
    const fields = updatedFields(update);
    if (fields) return this.updated(ids, fields);
    for (let i = 0; i < ids.length; i += BATCH) {
      const docs = await coll.find({ _id: { $in: ids.slice(i, i + BATCH) } } as Document).toArray();
      this.publish(docs.map((doc) => ({ e: 'u', id: doc._id, fields: documentFields(doc) })));
    }
  }

  /**
   * Removals of `ids`, which a delete matched before running. When it deleted fewer (some changed in
   * the meantime) only those gone are announced: a removal makes the app drop the document.
   */
  async removedOf(coll: Collection, ids: unknown[], deleted: number): Promise<void> {
    if (!deleted) return;
    if (deleted >= ids.length) return this.removed(ids);
    const left = new Set<string>();
    for (let i = 0; i < ids.length; i += BATCH) {
      const docs = await coll.find({ _id: { $in: ids.slice(i, i + BATCH) } } as Document, { projection: { _id: 1 } }).toArray();
      for (const doc of docs) left.add(JSON.stringify(doc._id));
    }
    this.removed(ids.filter((id) => !left.has(JSON.stringify(id))));
  }
}

export class RedisOplog implements vscode.Disposable {
  private static current: RedisOplog | undefined;
  private readonly redis = new Map<string, { url: string; conn: Promise<RedisConnection> }>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly warned = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  static init(connections: ConnectionManager): RedisOplog {
    RedisOplog.current = new RedisOplog(connections);
    return RedisOplog.current;
  }

  /** The sink of the writes on `target`; undefined when they aren't published. */
  static sink(target: OplogTarget): OplogSink | undefined {
    const oplog = RedisOplog.current;
    const settings = oplog?.connections.get(target.connectionId)?.redisOplog;
    if (!oplog || !settings || !inScope(settings.scope, target.database, target.collection)) return undefined;
    return new OplogSink(oplog, target);
  }

  private constructor(private readonly connections: ConnectionManager) {
    // A connection removed or without redis-oplog any more closes its Redis connection.
    this.disposables.push(
      connections.onDidChange(() => {
        for (const id of [...this.redis.keys()]) if (!connections.get(id)?.redisOplog) this.close(id);
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    for (const id of [...this.redis.keys()]) this.close(id);
    if (RedisOplog.current === this) RedisOplog.current = undefined;
  }

  enqueue(target: OplogTarget, events: OplogEvent[]): void {
    const id = target.connectionId;
    const run = (this.queues.get(id) ?? Promise.resolve()).then(() => this.publish(target, events)).catch((err) => this.warn(id, err));
    this.queues.set(id, run);
    void run.then(() => {
      if (this.queues.get(id) === run) this.queues.delete(id);
    });
  }

  private async publish(target: OplogTarget, events: OplogEvent[]): Promise<void> {
    const settings: RedisOplogSettings | undefined = this.connections.get(target.connectionId)?.redisOplog;
    if (!settings) return;
    const commands: string[][] = [];
    for (const event of events) {
      const m = oplogMessage(settings, target.collection, event);
      if (m) for (const channel of m.channels) commands.push(['PUBLISH', channel, m.message]);
    }
    for (let i = 0; i < commands.length; i += BATCH) {
      const conn = await this.connection(target.connectionId);
      await conn.pipeline(commands.slice(i, i + BATCH));
    }
  }

  private async connection(id: string): Promise<RedisConnection> {
    const url = await this.connections.redisUrl(id);
    if (!url) throw new Error('The Redis URL is missing: set it again in the connection.');
    const cached = this.redis.get(id);
    if (cached?.url === url) {
      const conn = await cached.conn.catch(() => undefined);
      if (conn?.alive) return conn;
    }
    this.close(id);
    const conn = RedisConnection.open(url);
    this.redis.set(id, { url, conn });
    conn.catch(() => {
      if (this.redis.get(id)?.conn === conn) this.redis.delete(id);
    });
    return conn;
  }

  private close(id: string): void {
    const cached = this.redis.get(id);
    this.redis.delete(id);
    void cached?.conn.then((c) => c.close()).catch(() => undefined);
  }

  private warn(id: string, err: unknown): void {
    const now = Date.now();
    if (now - (this.warned.get(id) ?? 0) < WARN_EVERY) return;
    this.warned.set(id, now);
    const name = this.connections.get(id)?.name ?? 'the connection';
    void vscode.window.showWarningMessage(`The change was saved, but couldn't be published to Redis for redis-oplog (${name}): ${errorText(err)}`);
  }
}
