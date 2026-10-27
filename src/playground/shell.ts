// A small mongosh-like runtime for playground scripts: `db`, `use()`, collection methods returning
// chainable cursors, BSON helpers (ObjectId, ISODate, …) and print(). Scripts run in a separate
// V8 context; a read-only connection refuses every method that writes.
import * as vm from 'vm';
import {
  AggregationCursor,
  BSON,
  Binary,
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
  Timestamp,
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
    private readonly countFilter?: { coll: Collection; filter: Document },
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
    return this.countFilter.coll.countDocuments(this.countFilter.filter);
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

class Shell {
  db: Record<string, unknown>;
  database: string;

  constructor(private readonly opts: RunOptions) {
    this.database = opts.database;
    this.db = this.dbProxy(opts.database);
  }

  use(name: string): string {
    if (typeof name !== 'string' || !name) throw new Error('use(): the database name is a string');
    this.database = name;
    this.db = this.dbProxy(name);
    return `switched to db ${name}`;
  }

  private guard(what: string): void {
    if (this.opts.readOnly) refuse(what);
  }

  private dbProxy(name: string): Record<string, unknown> {
    const shell = this;
    const db = this.opts.client.db(name);
    const methods: Record<string, unknown> = {
      getName: () => name,
      getCollection: (coll: string) => shell.collection(db, coll),
      getSiblingDB: (other: string) => shell.dbProxy(other),
      getMongo: () => ({ getDBNames: async () => (await db.admin().listDatabases()).databases.map((d) => d.name) }),
      getCollectionNames: async () =>
        (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(),
      getCollectionInfos: (filter: Document = {}) => db.listCollections(filter).toArray(),
      runCommand: (cmd: Document | string) => shell.command(db, cmd),
      adminCommand: (cmd: Document | string) => shell.command(db.admin() as unknown as Db, cmd),
      stats: (scale?: number) => db.command({ dbStats: 1, ...(scale && { scale }) }),
      serverStatus: () => db.admin().serverStatus(),
      version: async () => (await db.admin().buildInfo()).version,
      hostInfo: () => db.admin().command({ hostInfo: 1 }),
      currentOp: (filter: Document = {}) => db.admin().command({ currentOp: 1, ...filter }),
      aggregate: (pipeline: Document[], options?: Document) => {
        shell.checkPipeline(pipeline);
        return new ShellCursor(db.aggregate(pipeline, options));
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
      toString: () => name,
    };
    return new Proxy(methods, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        return shell.collection(db, prop);
      },
    });
  }

  private command(db: Db, cmd: Document | string): Promise<Document> {
    const doc = typeof cmd === 'string' ? { [cmd]: 1 } : cmd;
    const name = Object.keys(doc)[0];
    if (this.opts.readOnly) {
      if (!READ_COMMANDS.has(name)) refuse(`The command ${name}`);
      if (name === 'aggregate') this.checkPipeline(doc.pipeline);
    }
    return db.command(doc);
  }

  private checkPipeline(pipeline: unknown): void {
    if (!this.opts.readOnly || !Array.isArray(pipeline)) return;
    for (const stage of pipeline) {
      const op = stage && typeof stage === 'object' ? Object.keys(stage)[0] : '';
      if (WRITE_STAGES.includes(op)) refuse(`A pipeline with ${op}`);
    }
  }

  private collection(db: Db, name: string): Record<string, unknown> {
    const shell = this;
    const coll = db.collection(name);
    const sink = this.opts.oplog?.(db.databaseName, name);
    const writes = sink ? publishedWrites(coll, sink) : coll;
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
        new ShellCursor(coll.find(filter, { ...options, ...(projection && { projection }) }), { coll, filter }),
      findOne: (filter: Document = {}, projection?: Document, options?: Document) =>
        coll.findOne(filter, { ...options, ...(projection && { projection }) }),
      aggregate: (...args: unknown[]) => {
        // mongosh also accepts the stages as separate arguments.
        const [pipeline, options] = Array.isArray(args[0]) ? [args[0] as Document[], args[1] as Document] : [args as Document[], undefined];
        shell.checkPipeline(pipeline);
        return new ShellCursor(coll.aggregate(pipeline, options));
      },
      countDocuments: (filter: Document = {}, options?: Document) => coll.countDocuments(filter, options),
      count: (filter: Document = {}, options?: Document) => coll.countDocuments(filter, options),
      estimatedDocumentCount: () => coll.estimatedDocumentCount(),
      distinct: (key: string, filter: Document = {}) => coll.distinct(key, filter),
      getIndexes: () => coll.listIndexes().toArray(),
      stats: async () => (await coll.aggregate([{ $collStats: { storageStats: {}, count: {} } }]).toArray())[0],
      explain: () => ({
        find: (filter: Document = {}) => coll.find(filter).explain('executionStats'),
        aggregate: (pipeline: Document[]) => coll.aggregate(pipeline).explain('executionStats'),
      }),
      insertOne: write('insertOne', (doc: Document, options?: Document) => writes.insertOne(doc, options)),
      insertMany: write('insertMany', (docs: Document[], options?: Document) => writes.insertMany(docs, options)),
      insert: write('insert', (docs: Document | Document[]) =>
        Array.isArray(docs) ? writes.insertMany(docs) : writes.insertOne(docs),
      ),
      updateOne: write('updateOne', (f: Document, u: Document, o?: Document) => writes.updateOne(f, u, o)),
      updateMany: write('updateMany', (f: Document, u: Document, o?: Document) => writes.updateMany(f, u, o)),
      replaceOne: write('replaceOne', (f: Document, r: Document, o?: Document) => writes.replaceOne(f, r, o)),
      deleteOne: write('deleteOne', (f: Document, o?: Document) => writes.deleteOne(f, o)),
      deleteMany: write('deleteMany', (f: Document, o?: Document) => writes.deleteMany(f, o)),
      findOneAndUpdate: write('findOneAndUpdate', (f: Document, u: Document, o?: Document) => writes.findOneAndUpdate(f, u, o ?? {})),
      findOneAndReplace: write('findOneAndReplace', (f: Document, r: Document, o?: Document) => writes.findOneAndReplace(f, r, o ?? {})),
      findOneAndDelete: write('findOneAndDelete', (f: Document, o?: Document) => writes.findOneAndDelete(f, o ?? {})),
      bulkWrite: write('bulkWrite', (ops: Document[], o?: Document) => writes.bulkWrite(ops as never, o)),
      createIndex: write('createIndex', (keys: Document, o?: Document) => coll.createIndex(keys, o)),
      createIndexes: write('createIndexes', (specs: Document[]) =>
        coll.createIndexes(specs.map((key) => ('key' in key ? key : { key })) as never),
      ),
      dropIndex: write('dropIndex', (index: string | Document) =>
        typeof index === 'string' ? coll.dropIndex(index) : db.command({ dropIndexes: name, index }),
      ),
      dropIndexes: write('dropIndexes', () => coll.dropIndexes()),
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
        return shell.collection(db, `${name}.${prop}`);
      },
    });
  }
}

/** Shell text of a value for print(): strings as they are, everything else as mongosh syntax. */
function display(v: unknown, pretty: boolean): string {
  if (typeof v === 'string') return v;
  if (v instanceof ShellCursor) return '[cursor]';
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
  let value: unknown;
  try {
    value = await new vm.Script(code, { filename: 'playground.mongodb.js' }).runInContext(context);
  } catch (err) {
    throw toPlaygroundError(err);
  }
  const database = shell.database;
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
  return new PlaygroundError(`${name}${e.message}`, line ? Number(line) : undefined);
}
