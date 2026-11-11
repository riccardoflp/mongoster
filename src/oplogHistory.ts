// Reading the writes to one document from the oplog (local.oplog.rs) of a replica set, newest first and
// a page at a time: time windows growing from the newest entry back are read until enough writes are
// found, the page's time is up or the oplog's first entry is reached, so a big oplog isn't read whole.
// The filter is write_history's (src/mcp/changes.ts), with the drops and renames of the collection.
// No vscode: tested against a real replica set.
import { BSON, Document, MongoClient, Timestamp } from 'mongodb';
import { codeOf, notAuthorized, writesFilter } from './mcp/changes';
import { DocHistory, DocOp, buildHistory, documentOps, idKey } from './shared/docHistory';

const { EJSON } = BSON;

/** Writes to the document read by one page at most. */
export const PAGE_OPERATIONS = 100;
/** Time one page may take reading the oplog. */
export const PAGE_MS = 8000;
/** Seconds of oplog read by the first query of a page; each next one reads 4 times more. */
const FIRST_SPAN = 3600;
/** promoteValues: false and bsonRegExp keep every value exactly as stored. */
const READ = { promoteValues: false, bsonRegExp: true } as const;

export type OplogProblem = 'standalone' | 'sharded' | 'auth' | 'view';

/** Why the history can't be read, for the user. */
export class OplogHistoryError extends Error {
  constructor(
    message: string,
    readonly kind: OplogProblem,
  ) {
    super(message);
  }
}

const canonical = (v: unknown) => EJSON.serialize({ v }, { relaxed: false }).v as unknown;
const canonicalDoc = (doc: Document) => EJSON.serialize(doc, { relaxed: false }) as Record<string, unknown>;
const isoOf = (e: Document | undefined) => (e?.wall instanceof Date ? e.wall.toISOString() : e?.ts instanceof Timestamp ? new Date(e.ts.t * 1000).toISOString() : undefined);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const authError = () =>
  new OplogHistoryError(
    "Not authorized to read the oplog: reading local.oplog.rs needs a role such as clusterMonitor or readAnyDatabase (or read on the local database). Atlas shared tiers (M0, Flex) don't allow it at all.",
    'auth',
  );

/** The writes to one document read so far, and how far back. */
export class DocumentOplog {
  /** The operations found, in the order read (newest entries first). */
  readonly ops: DocOp[] = [];
  /** Everything from this timestamp on has been read; undefined before the first page. */
  from?: Timestamp;
  /** Read back to the oplog's first entry. */
  complete = false;
  /** The last page stopped at its time limit inside a query. */
  timedOut = false;
  first?: Document;
  last?: Document;
  private readonly key: string;

  constructor(
    private readonly client: MongoClient,
    readonly database: string,
    readonly collection: string,
    /** The _id, as stored (BSON). */
    readonly id: unknown,
    private readonly limits = { operations: PAGE_OPERATIONS, ms: PAGE_MS },
  ) {
    this.key = idKey(canonical(id));
  }

  get ns(): string {
    return `${this.database}.${this.collection}`;
  }

  /** The oplog's first and last entries, ISO. */
  get firstTime(): string | undefined {
    return isoOf(this.first);
  }

  get lastTime(): string | undefined {
    return isoOf(this.last);
  }

  /** The time the oplog was read back to, ISO. */
  get fromTime(): string | undefined {
    return this.from ? new Date(this.from.t * 1000).toISOString() : undefined;
  }

  /** Checks there is an oplog to read (a replica set member, not a view, the permission) and reads its first and last entries. */
  async check(): Promise<void> {
    const hello = await this.client.db('admin').command({ hello: 1 });
    if (hello.msg === 'isdbgrid') {
      throw new OplogHistoryError("This is a sharded cluster (mongos): each shard has its own oplog. Connect to the replica set of the shard that holds the document to see its history.", 'sharded');
    }
    if (!hello.setName) {
      throw new OplogHistoryError(
        'A standalone server has no oplog, so there is no history of the writes: it needs a replica set. A single-node one is enough (mongod --replSet rs0, then rs.initiate()).',
        'standalone',
      );
    }
    const list = await this.client.db(this.database).listCollections({ name: this.collection }, { nameOnly: false }).toArray().catch(() => []);
    if ((list[0] as { type?: string } | undefined)?.type === 'view') {
      throw new OplogHistoryError(`${this.collection} is a view: its documents are written in its source collection. Open the history from there.`, 'view');
    }
    const oplog = this.client.db('local').collection('oplog.rs');
    try {
      [[this.first], [this.last]] = await Promise.all([
        oplog.find({}, { sort: { $natural: 1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray(),
        oplog.find({}, { sort: { $natural: -1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray(),
      ]);
    } catch (err) {
      if (notAuthorized(err)) throw authError();
      throw err;
    }
  }

  /** The oplog filter: the document's writes (also inside applyOps), the drops and renames of its collection. */
  private filter(): Document {
    const writes = writesFilter(['i', 'u', 'd'], this.database, this.collection, this.id);
    const commands = {
      op: 'c',
      ns: `${this.database}.$cmd`,
      $or: [{ 'o.drop': this.collection }, { 'o.renameCollection': this.ns }, { 'o.to': this.ns }, { 'o.dropDatabase': { $exists: true } }],
    };
    return { $or: [...(writes.$or as Document[]), commands] };
  }

  /** Reads the next page, older than what was read so far. */
  async readPage(): Promise<void> {
    if (this.complete) return;
    if (!this.last) await this.check();
    const started = Date.now();
    const oplog = this.client.db('local').collection('oplog.rs');
    const filter = this.filter();
    const firstT = this.first?.ts instanceof Timestamp ? this.first.ts.t : 0;
    let hi = this.from;
    let hiT = hi ? hi.t : (this.last?.ts instanceof Timestamp ? this.last.ts.t : Math.floor(Date.now() / 1000)) + 1;
    let span = FIRST_SPAN;
    let found = 0;
    this.timedOut = false;
    for (;;) {
      const loT = Math.max(firstT, hiT - span);
      const lo = new Timestamp({ t: loT, i: 0 });
      const ts: Document = hi ? { $gte: lo, $lt: hi } : { $gte: lo };
      const remaining = this.limits.ms - (Date.now() - started);
      const cursor = oplog.find({ ts, ...filter }, { ...READ, sort: { $natural: -1 }, maxTimeMS: Math.max(500, remaining), batchSize: 200 });
      let oldest: Timestamp | undefined;
      let enough = false;
      try {
        for await (const raw of cursor) {
          const ops = documentOps(canonicalDoc(raw), this.ns, this.key);
          this.ops.push(...ops);
          found += ops.length;
          if (raw.ts instanceof Timestamp) oldest = raw.ts;
          if (found >= this.limits.operations) {
            enough = true;
            break;
          }
        }
      } catch (err) {
        if (notAuthorized(err)) throw authError();
        if (codeOf(err) !== 50 && !/time limit|MaxTimeMSExpired/i.test(errorText(err))) throw err;
        // The entries are read newest first: everything from the oldest one returned on was read.
        this.timedOut = true;
        const reached = oldest ?? hi;
        if (!reached) throw new Error(`Reading the oplog took more than ${this.limits.ms / 1000} s without reaching any entry: the server may be too busy, try again.`);
        this.from = reached;
        return;
      } finally {
        await cursor.close().catch(() => undefined);
      }
      if (enough && oldest) {
        this.from = oldest;
        return;
      }
      this.from = hi = lo;
      hiT = loT;
      if (loT <= firstT) {
        this.complete = true;
        return;
      }
      if (Date.now() - started >= this.limits.ms) return;
      span *= 4;
    }
  }

  /** The document as it is now (null: it doesn't exist), as stored. */
  async current(): Promise<Document | null> {
    return this.client.db(this.database).collection(this.collection).findOne({ _id: this.id } as Document, READ);
  }

  /** The versions rebuilt from the operations read and the document now. */
  history(current: Document | null): DocHistory {
    return buildHistory(this.ops, current ? canonicalDoc(current) : null);
  }
}
