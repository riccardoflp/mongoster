// A small mongosh-like runtime for playground scripts: `db`, `use()`, collection methods returning
// chainable cursors, BSON helpers (ObjectId, ISODate, …) and print(). Scripts run in a separate
// V8 context; a read-only connection refuses every method that writes. `db.getMongo().startSession()`
// gives mongosh's sessions and transactions: the collections of `session.getDatabase()` run every
// operation in the session, and the writes of a transaction are published to redis-oplog only once it
// commits. Sessions still open when the script ends (or fails, or is cancelled) are aborted and ended.
import * as vm from 'vm';
import {
  AggregationCursor,
  BSON,
  Binary,
  ClientSession,
  ClientSessionOptions,
  Code,
  Collection,
  Db,
  Decimal128,
  Document,
  Double,
  FindCursor,
  Int32,
  Long,
  MaxKey,
  MinKey,
  MongoClient,
  ObjectId,
  ReadPreference,
  Timestamp,
  TransactionOptions,
  UUID,
} from 'mongodb';
import { prettyShell, relaxEjson, toShell } from '../shared/query';
import { RESOLVE_FN, ScriptSyntaxError, rewritePlayground } from './rewrite';
import { publishedWrites } from './oplogWrites';
import type { OplogSink } from '../redisOplog';

const { EJSON } = BSON;

/** Documents of a cursor shown as the result; more are reported but not fetched. */
export const RESULT_LIMIT = 200;

export interface RunOptions {
  client: MongoClient;
  database: string;
  /** The connection is read-only: methods that write throw. */
  readOnly: boolean;
  /** Where the writes on a collection are published for redis-oplog; undefined: not published. */
  oplog?(database: string, collection: string): OplogSink | undefined;
  print(line: string): void;
  /** The run was cancelled: open transactions are aborted and sessions ended right away. */
  signal?: AbortSignal;
}

export interface RunResult {
  /** Relaxed EJSON of the value of the last expression (documents for a cursor). */
  value: unknown;
  kind: 'documents' | 'value' | 'none';
  /** A cursor had more documents than `RESULT_LIMIT`. */
  more?: boolean;
  /** Database selected at the end (after `use()`). */
  database: string;
}

/** An error of the script, with its line when known. */
export class PlaygroundError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

const READ_COMMANDS = new Set([
  'find', 'aggregate', 'count', 'distinct', 'listCollections', 'listIndexes', 'listDatabases', 'dbStats', 'collStats',
  'serverStatus', 'buildInfo', 'buildinfo', 'ping', 'hello', 'isMaster', 'ismaster', 'explain', 'connectionStatus',
  'hostInfo', 'getParameter', 'currentOp', 'top', 'getLog', 'replSetGetStatus', 'getCmdLineOpts', 'validate', 'dataSize',
  'listCommands', 'whatsmyuri', 'features', 'getMore', 'profile',
]);

const WRITE_STAGES = ['$out', '$merge'];

function refuse(what: string): never {
  throw new Error(`${what} is not allowed: the connection is read-only.`);
}

/** Wraps a driver cursor: chain methods return the wrapper, terminal methods return promises. */
export class ShellCursor {
  private mapper?: (doc: Document) => unknown;

  constructor(
    private readonly cursor: FindCursor | AggregationCursor,
    private readonly countFilter?: { coll: Collection; filter: Document; session?: ClientSession },
  ) {}

  private chain(method: string, ...args: unknown[]): this {
    const fn = (this.cursor as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== 'function') throw new Error(`cursor.${method}() is not available on this cursor`);
    fn.apply(this.cursor, args);
    return this;
  }

  sort(spec: Document): this {
    return this.chain('sort', spec);
  }
  limit(n: number): this {
    return this.chain('limit', n);
  }
  skip(n: number): this {
    return this.chain('skip', n);
  }
  project(spec: Document): this {
    return this.chain('project', spec);
  }
  projection(spec: Document): this {
    return this.chain('project', spec);
  }
  hint(index: string | Document): this {
    return this.chain('hint', index);
  }
  collation(spec: Document): this {
    return this.chain('collation', spec);
  }
  comment(text: string): this {
    return this.chain('comment', text);
  }
  maxTimeMS(ms: number): this {
    return this.chain('maxTimeMS', ms);
  }
  batchSize(n: number): this {
    return this.chain('batchSize', n);
  }
  allowDiskUse(value = true): this {
    return this.chain('allowDiskUse', value);
  }
  pretty(): this {
    return this;
  }
  map(fn: (doc: Document) => unknown): this {
    const previous = this.mapper;
    this.mapper = previous ? (d) => fn(previous(d) as Document) : fn;
    return this;
  }

  async toArray(): Promise<unknown[]> {
    const docs = await this.cursor.toArray();
    return this.mapper ? docs.map(this.mapper) : docs;
  }
  async forEach(fn: (doc: unknown) => unknown): Promise<void> {
    for await (const doc of this.cursor) await fn(this.mapper ? this.mapper(doc) : doc);
  }
  async hasNext(): Promise<boolean> {
    return this.cursor.hasNext();
  }
  async next(): Promise<unknown> {
    const doc = await this.cursor.next();
    return doc && this.mapper ? this.mapper(doc) : doc;
  }
  async count(): Promise<number> {
    if (!this.countFilter) return (await this.cursor.toArray()).length;
    return this.countFilter.coll.countDocuments(this.countFilter.filter, { session: this.countFilter.session });
  }
  async itcount(): Promise<number> {
    let n = 0;
    for await (const _ of this.cursor) n++;
    return n;
  }
  size(): Promise<number> {
    return this.count();
  }
  async explain(verbosity: string = 'queryPlanner'): Promise<Document> {
    return (this.cursor as FindCursor).explain(verbosity as 'queryPlanner');
  }

  /** First `limit` documents, and whether there were more. */
  async take(limit: number): Promise<{ docs: unknown[]; more: boolean }> {
    const docs: unknown[] = [];
    for await (const doc of this.cursor) {
      if (docs.length === limit) {
        await this.cursor.close();
        return { docs, more: true };
      }
      docs.push(this.mapper ? this.mapper(doc) : doc);
    }
    return { docs, more: false };
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    const it = this.cursor[Symbol.asyncIterator]();
    const mapper = this.mapper;
    return {
      next: async () => {
        const r = await it.next();
        return r.done || !mapper ? r : { done: false, value: mapper(r.value) };
      },
    };
  }
}

/** mongosh's transaction options: readPreference may be { mode, tags } as well as a mode or a ReadPreference. */
function transactionOptions(options?: Document): TransactionOptions | undefined {
  if (!options) return undefined;
  const { readPreference: rp, ...rest } = options;
  const readPreference =
    rp && typeof rp === 'object' && !(rp instanceof ReadPreference) && typeof rp.mode === 'string'
      ? new ReadPreference(rp.mode, rp.tags, { maxStalenessSeconds: rp.maxStalenessSeconds })
      : rp;
  return { ...rest, ...(readPreference && { readPreference }) };
}

/** `db.getMongo()`: the connection, which starts sessions. */
export class ShellMongo {
  constructor(private readonly shell: Shell) {}

  startSession(options?: Document): ShellSession {
    return this.shell.startSession(options);
  }
  getDB(name: string): Record<string, unknown> {
    return this.shell.dbProxy(name);
  }
  async getDBNames(): Promise<string[]> {
    return (await this.shell.client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
  }
  getDBs(): Promise<Document> {
    return this.shell.client.db('admin').admin().listDatabases();
  }
  toString(): string {
    return '[Mongo]';
  }
}

/**
 * A session of `db.getMongo().startSession()`, as in mongosh. The collections of `getDatabase()` pass it
 * to every operation; the redis-oplog events of the writes made in a transaction wait in `pending` and
 * go out, in order, only after a successful commit (a withTransaction retry starts them over).
 */
export class ShellSession {
  private readonly pending: (() => void)[] = [];

  constructor(
    private readonly shell: Shell,
    readonly session: ClientSession,
  ) {}

  getDatabase(name: string): Record<string, unknown> {
    if (typeof name !== 'string' || !name) throw new Error('getDatabase(): the database name is a string');
    return this.shell.dbProxy(name, this);
  }
  getMongo(): ShellMongo {
    return this.shell.mongo;
  }
  startTransaction(options?: Document): void {
    this.session.startTransaction(transactionOptions(options));
    this.pending.length = 0;
  }
  async commitTransaction(): Promise<Document> {
    await this.session.commitTransaction();
    this.publish();
    return { ok: 1 };
  }
  async abortTransaction(): Promise<Document> {
    this.pending.length = 0;
    await this.session.abortTransaction();
    return { ok: 1 };
  }
  /**
   * Runs `fn(session)` in a transaction and commits it, with the driver's retries: the whole callback
   * again on a TransientTransactionError, the commit again on an UnknownTransactionCommitResult.
   */
  async withTransaction(fn: (session: ShellSession) => unknown, options?: Document): Promise<unknown> {
    if (typeof fn !== 'function') throw new Error('withTransaction(): the first argument is a function');
    try {
      const result = await this.session.withTransaction(async () => {
        // Each attempt starts a new transaction: the writes of an aborted one were never made.
        this.pending.length = 0;
        return fn(this);
      }, transactionOptions(options));
      // Committed (or ended by the callback itself, which already published or dropped the events).
      this.publish();
      return result;
    } finally {
      this.pending.length = 0;
    }
  }
  async endSession(): Promise<void> {
    this.pending.length = 0;
    if (this.session.inTransaction()) await this.session.abortTransaction();
    await this.session.endSession();
  }
  hasEnded(): boolean {
    return this.session.hasEnded;
  }
  inTransaction(): boolean {
    return this.session.inTransaction();
  }
  getSessionId(): Document | undefined {
    return this.session.id;
  }
  getClusterTime(): Document | undefined {
    return this.session.clusterTime;
  }
  getOperationTime(): Timestamp | undefined {
    return this.session.operationTime;
  }
  toString(): string {
    return `session ${this.session.id?.id instanceof Binary ? this.session.id.id.toUUID().toHexString() : ''}`.trim();
  }

  /** What the result shows for the session. */
  describe(): Document {
    return { id: this.session.id?.id, inTransaction: this.inTransaction(), hasEnded: this.hasEnded() };
  }

  /** The sink of a write made now: in a transaction its events wait for the commit. */
  sink(sink: OplogSink): OplogSink {
    return this.session.inTransaction() ? sink.deferred(this.pending) : sink;
  }

  private publish(): void {
    for (const p of this.pending.splice(0)) p();
  }
}

class Shell {
  db: Record<string, unknown>;
  database: string;
  readonly mongo: ShellMongo;
  private readonly sessions: ShellSession[] = [];
  /** Set once the run is cancelled: no new sessions. */
  private cancelled = false;

  constructor(private readonly opts: RunOptions) {
    this.database = opts.database;
    this.db = this.dbProxy(opts.database);
    this.mongo = new ShellMongo(this);
  }

  get client(): MongoClient {
    return this.opts.client;
  }

  use(name: string): string {
    if (typeof name !== 'string' || !name) throw new Error('use(): the database name is a string');
    this.database = name;
    this.db = this.dbProxy(name);
    return `switched to db ${name}`;
  }

  /** mongosh's startSession(): readConcern / writeConcern / readPreference are the transactions' defaults. */
  startSession(options: Document = {}): ShellSession {
    if (this.cancelled) throw new Error('The run was cancelled.');
    const { readConcern, writeConcern, readPreference, defaultTransactionOptions, ...rest } = options;
    const defaults = transactionOptions({
      ...defaultTransactionOptions,
      ...(readConcern && { readConcern }),
      ...(writeConcern && { writeConcern }),
      ...(readPreference && { readPreference }),
    });
    const session = new ShellSession(this, this.opts.client.startSession({ ...(rest as ClientSessionOptions), defaultTransactionOptions: defaults }));
    this.sessions.push(session);
    return session;
  }

  /**
   * Ends the sessions still open: a transaction in progress is aborted (never committed). The output
   * says so; after a cancel, later calls do nothing.
   */
  async closeSessions(reason: 'end' | 'error' | 'cancel'): Promise<void> {
    if (this.cancelled) return;
    if (reason === 'cancel') this.cancelled = true;
    const open = this.sessions.splice(0).filter((s) => !s.hasEnded());
    if (!open.length) return;
    const transactions = open.filter((s) => s.inTransaction()).length;
    const sessions = open.length - transactions;
    if (transactions) {
      const what = transactions === 1 ? 'The transaction still open was' : `The ${transactions} transactions still open were`;
      const why = reason === 'end' ? 'at the end of the script' : reason === 'error' ? 'after the error' : 'because the run was cancelled';
      this.opts.print(`Note: ${what} aborted ${why}: nothing of ${transactions === 1 ? 'it' : 'them'} was committed (session.commitTransaction() commits).`);
    }
    if (sessions) this.opts.print(`Note: ${sessions === 1 ? 'a session left open was' : `${sessions} sessions left open were`} ended.`);
    await Promise.all(open.map((s) => s.endSession().catch(() => undefined)));
  }

  private guard(what: string): void {
    if (this.opts.readOnly) refuse(what);
  }

  /** The `db` of a database; with a session, the one of `session.getDatabase()`. */
  dbProxy(name: string, session?: ShellSession): Record<string, unknown> {
    const shell = this;
    const db = this.opts.client.db(name);
    const s = session?.session;
    const so = (o?: Document): Document | undefined => (s ? { ...o, session: s } : o);
    const methods: Record<string, unknown> = {
      getName: () => name,
      getCollection: (coll: string) => shell.collection(db, coll, session),
      getSiblingDB: (other: string) => shell.dbProxy(other, session),
      getMongo: () => shell.mongo,
      getCollectionNames: async () =>
        (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(),
      getCollectionInfos: (filter: Document = {}) => db.listCollections(filter).toArray(),
      runCommand: (cmd: Document | string) => shell.command(db, cmd, s),
      adminCommand: (cmd: Document | string) => shell.command(db.admin() as unknown as Db, cmd, s),
      stats: (scale?: number) => db.command({ dbStats: 1, ...(scale && { scale }) }),
      serverStatus: () => db.admin().serverStatus(),
      version: async () => (await db.admin().buildInfo()).version,
      hostInfo: () => db.admin().command({ hostInfo: 1 }),
      currentOp: (filter: Document = {}) => db.admin().command({ currentOp: 1, ...filter }),
      aggregate: (pipeline: Document[], options?: Document) => {
        shell.checkPipeline(pipeline);
        return new ShellCursor(db.aggregate(pipeline, so(options)));
      },
      createCollection: (coll: string, options?: Document) => {
        shell.guard('createCollection()');
        return db.createCollection(coll, options).then(() => ({ ok: 1 }));
      },
      createView: (view: string, source: string, pipeline: Document[], options?: Document) => {
        shell.guard('createView()');
        return db.createCollection(view, { ...options, viewOn: source, pipeline }).then(() => ({ ok: 1 }));
      },
      dropDatabase: () => {
        shell.guard('dropDatabase()');
        return db.dropDatabase().then((dropped) => ({ ok: dropped ? 1 : 0, dropped: name }));
      },
      ...(session && { getSession: () => session }),
      toString: () => name,
    };
    return new Proxy(methods, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        return shell.collection(db, prop, session);
      },
    });
  }

  private command(db: Db, cmd: Document | string, session?: ClientSession): Promise<Document> {
    const doc = typeof cmd === 'string' ? { [cmd]: 1 } : cmd;
    const name = Object.keys(doc)[0];
    if (this.opts.readOnly) {
      if (!READ_COMMANDS.has(name)) refuse(`The command ${name}`);
      if (name === 'aggregate') this.checkPipeline(doc.pipeline);
    }
    return db.command(doc, session && { session });
  }

  private checkPipeline(pipeline: unknown): void {
    if (!this.opts.readOnly || !Array.isArray(pipeline)) return;
    for (const stage of pipeline) {
      const op = stage && typeof stage === 'object' ? Object.keys(stage)[0] : '';
      if (WRITE_STAGES.includes(op)) refuse(`A pipeline with ${op}`);
    }
  }

  private collection(db: Db, name: string, session?: ShellSession): Record<string, unknown> {
    const shell = this;
    const coll = db.collection(name);
    const s = session?.session;
    // With a session, every operation runs in it.
    const so = (o?: Document): Document | undefined => (s ? { ...o, session: s } : o);
    const sink = this.opts.oplog?.(db.databaseName, name);
    // Chosen at each write: in a transaction, the events wait for the commit.
    const writes = () => (sink ? publishedWrites(coll, session ? session.sink(sink) : sink) : coll);
    const write =
      <A extends unknown[]>(method: string, fn: (...args: A) => unknown) =>
      (...args: A) => {
        shell.guard(`${method}()`);
        return fn(...args);
      };
    const methods: Record<string, unknown> = {
      getName: () => name,
      getFullName: () => `${db.databaseName}.${name}`,
      find: (filter: Document = {}, projection?: Document, options?: Document) =>
        new ShellCursor(coll.find(filter, so({ ...options, ...(projection && { projection }) })), { coll, filter, session: s }),
      findOne: (filter: Document = {}, projection?: Document, options?: Document) =>
        coll.findOne(filter, so({ ...options, ...(projection && { projection }) })),
      aggregate: (...args: unknown[]) => {
        // mongosh also accepts the stages as separate arguments.
        const [pipeline, options] = Array.isArray(args[0]) ? [args[0] as Document[], args[1] as Document] : [args as Document[], undefined];
        shell.checkPipeline(pipeline);
        return new ShellCursor(coll.aggregate(pipeline, so(options)));
      },
      countDocuments: (filter: Document = {}, options?: Document) => coll.countDocuments(filter, so(options)),
      count: (filter: Document = {}, options?: Document) => coll.countDocuments(filter, so(options)),
      estimatedDocumentCount: () => coll.estimatedDocumentCount(so()),
      distinct: (key: string, filter: Document = {}) => coll.distinct(key, filter, so() ?? {}),
      getIndexes: () => coll.listIndexes().toArray(),
      stats: async () => (await coll.aggregate([{ $collStats: { storageStats: {}, count: {} } }]).toArray())[0],
      explain: () => ({
        find: (filter: Document = {}) => coll.find(filter).explain('executionStats'),
        aggregate: (pipeline: Document[]) => coll.aggregate(pipeline).explain('executionStats'),
      }),
      insertOne: write('insertOne', (doc: Document, options?: Document) => writes().insertOne(doc, so(options))),
      insertMany: write('insertMany', (docs: Document[], options?: Document) => writes().insertMany(docs, so(options))),
      insert: write('insert', (docs: Document | Document[]) =>
        Array.isArray(docs) ? writes().insertMany(docs, so()) : writes().insertOne(docs, so()),
      ),
      updateOne: write('updateOne', (f: Document, u: Document, o?: Document) => writes().updateOne(f, u, so(o))),
      updateMany: write('updateMany', (f: Document, u: Document, o?: Document) => writes().updateMany(f, u, so(o))),
      replaceOne: write('replaceOne', (f: Document, r: Document, o?: Document) => writes().replaceOne(f, r, so(o))),
      deleteOne: write('deleteOne', (f: Document, o?: Document) => writes().deleteOne(f, so(o))),
      deleteMany: write('deleteMany', (f: Document, o?: Document) => writes().deleteMany(f, so(o))),
      findOneAndUpdate: write('findOneAndUpdate', (f: Document, u: Document, o?: Document) => writes().findOneAndUpdate(f, u, so(o) ?? {})),
      findOneAndReplace: write('findOneAndReplace', (f: Document, r: Document, o?: Document) => writes().findOneAndReplace(f, r, so(o) ?? {})),
      findOneAndDelete: write('findOneAndDelete', (f: Document, o?: Document) => writes().findOneAndDelete(f, so(o) ?? {})),
      bulkWrite: write('bulkWrite', (ops: Document[], o?: Document) => writes().bulkWrite(ops as never, so(o))),
      createIndex: write('createIndex', (keys: Document, o?: Document) => coll.createIndex(keys, o)),
      createIndexes: write('createIndexes', (specs: Document[]) =>
        coll.createIndexes(specs.map((key) => ('key' in key ? key : { key })) as never),
      ),
      dropIndex: write('dropIndex', (index: string | Document) =>
        typeof index === 'string' ? coll.dropIndex(index) : db.command({ dropIndexes: name, index }),
      ),
      dropIndexes: write('dropIndexes', () => coll.dropIndexes()),
      getSearchIndexes: (index?: string) => (index ? coll.listSearchIndexes(index) : coll.listSearchIndexes()).toArray(),
      // As mongosh: (name, definition), (name, type, definition) or ({ name, type, definition }).
      createSearchIndex: write('createSearchIndex', (...args: unknown[]) => {
        const [first, second, third] = args;
        const description: Document =
          typeof first === 'string' ? (typeof second === 'string' ? { name: first, type: second, definition: third } : { name: first, definition: second }) : (first as Document);
        return coll.createSearchIndex(description as never);
      }),
      updateSearchIndex: write('updateSearchIndex', (index: string, definition: Document) => coll.updateSearchIndex(index, definition)),
      dropSearchIndex: write('dropSearchIndex', (index: string) => coll.dropSearchIndex(index)),
      drop: write('drop', () => coll.drop()),
      renameCollection: write('renameCollection', (to: string, dropTarget?: boolean) =>
        coll.rename(to, { dropTarget }).then(() => ({ ok: 1 })),
      ),
      toString: () => `${db.databaseName}.${name}`,
    };
    return new Proxy(methods, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        // db.system.views, db.logs.archive, … : dotted collection names.
        return shell.collection(db, `${name}.${prop}`, session);
      },
    });
  }
}

/** Shell text of a value for print(): strings as they are, everything else as mongosh syntax. */
function display(v: unknown, pretty: boolean): string {
  if (typeof v === 'string') return v;
  if (v instanceof ShellCursor) return '[cursor]';
  if (v instanceof ShellMongo) return v.toString();
  if (v instanceof ShellSession) v = v.describe();
  try {
    const relaxed = relaxEjson(EJSON.serialize(v, { relaxed: false }));
    return pretty ? prettyShell(relaxed) : toShell(relaxed);
  } catch {
    return String(v);
  }
}

function helpers(shell: Shell, print: (line: string) => void): Record<string, unknown> {
  const out =
    (pretty: boolean) =>
    (...args: unknown[]) =>
      print(args.map((a) => display(a, pretty)).join(' '));
  return {
    use: (name: string) => shell.use(name),
    print: out(false),
    printjson: out(true),
    console: { log: out(false), info: out(false), warn: out(false), error: out(false), dir: out(true) },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    ObjectId: (hex?: string | number) => new ObjectId(hex),
    ISODate: (s?: string | number) => (s === undefined ? new Date() : new Date(s)),
    NumberLong: (v: string | number) => Long.fromString(String(v)),
    NumberInt: (v: string | number) => new Int32(Number(v)),
    Int32: (v: number) => new Int32(v),
    Double: (v: number) => new Double(v),
    NumberDecimal: (v: string | number) => Decimal128.fromString(String(v)),
    Decimal128: (v: string | number) => Decimal128.fromString(String(v)),
    UUID: (s?: string) => new UUID(s),
    BinData: (subtype: number, base64: string) => new Binary(Buffer.from(base64, 'base64'), subtype),
    Timestamp: (t: number | { t: number; i: number }, i?: number) =>
      typeof t === 'object' ? new Timestamp({ t: t.t, i: t.i }) : new Timestamp({ t, i: i ?? 0 }),
    MinKey: () => new MinKey(),
    MaxKey: () => new MaxKey(),
    Code: (code: string) => new Code(code),
    EJSON,
    [RESOLVE_FN]: async (v: unknown) => (v instanceof ShellCursor ? v : await v),
  };
}

/** Runs a playground script; the last expression's value (a cursor's first documents) is the result. */
export async function runPlayground(source: string, opts: RunOptions): Promise<RunResult> {
  let code: string;
  try {
    code = rewritePlayground(source);
  } catch (err) {
    if (err instanceof ScriptSyntaxError) throw new PlaygroundError(`SyntaxError: ${err.message}`, err.line);
    throw err;
  }
  const shell = new Shell(opts);
  const globals = helpers(shell, opts.print);
  const context = vm.createContext(globals);
  // `db` changes with use(): a getter keeps it current.
  Object.defineProperty(context, 'db', { get: () => shell.db, enumerable: true });
  // Cancelling aborts the open transactions and ends the sessions at once (the note is in the output).
  const cancel = () => void shell.closeSessions('cancel');
  opts.signal?.addEventListener('abort', cancel, { once: true });
  try {
    let value: unknown;
    try {
      value = await new vm.Script(code, { filename: 'playground.mongodb.js' }).runInContext(context);
    } catch (err) {
      await shell.closeSessions('error');
      throw toPlaygroundError(err);
    }
    try {
      return await result(value, shell.database);
    } finally {
      // After reading the result: a cursor may belong to a session.
      await shell.closeSessions('end');
    }
  } finally {
    opts.signal?.removeEventListener('abort', cancel);
  }
}

async function result(value: unknown, database: string): Promise<RunResult> {
  if (value === undefined) return { value: undefined, kind: 'none', database };
  if (value instanceof ShellCursor) {
    const { docs, more } = await value.take(RESULT_LIMIT);
    return { value: serialize(docs), kind: 'documents', more, database };
  }
  const serialized = serialize(value);
  const isDocuments = Array.isArray(serialized) && serialized.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d));
  return { value: serialized, kind: isDocuments ? 'documents' : 'value', database };
}

function serialize(v: unknown): unknown {
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (v instanceof ShellMongo) return v.toString();
  if (v instanceof ShellSession) v = v.describe();
  try {
    return relaxEjson(EJSON.serialize(v, { relaxed: false }));
  } catch {
    return String(v);
  }
}

/** The script's line from the stack of an error thrown while running it. */
function toPlaygroundError(err: unknown): PlaygroundError {
  if (err instanceof PlaygroundError) return err;
  // Errors thrown by the script come from its own context: not instances of this realm's Error.
  const e = (err !== null && typeof err === 'object' && 'message' in err ? err : new Error(String(err))) as Error;
  const line = /playground\.mongodb\.js:(\d+)/.exec(e.stack ?? '')?.[1];
  const name = e.name && e.name !== 'Error' && !e.message.startsWith(e.name) ? `${e.name}: ` : '';
  // A standalone server refuses the transaction's first operation.
  const hint = /only allowed on a replica set member or mongos|Transactions? (are|is) not supported/i.test(e.message)
    ? ' — transactions need a replica set or a sharded cluster (a single-node replica set is enough).'
    : '';
  return new PlaygroundError(`${name}${e.message}${hint}`, line ? Number(line) : undefined);
}
