// The MCP tools that show what is being written to the database: watch_changes, a change stream
// opened for a few seconds and resumable from call to call, and write_history, the recent writes read
// back from the oplog (local.oplog.rs) of a replica set.
import { BSON, ChangeStream, ChangeStreamOptions, Document, MongoClient, Timestamp } from 'mongodb';
import type { ConnectionInfo } from '../connections';
import { McpTool, ToolError, boolArg, intArg, stringArg, truncate } from '../shared/mcp';
import { toBson } from '../queries';
import { oplogEntry } from '../replication';
import { isPlainObject, relaxEjson } from '../shared/query';
import { isTransactionEntry } from '../shared/docHistory';
import { MAX_OUTPUT, MAX_TIME_MS, ToolContext, connectionProp, message, plural, shell } from './context';

const { EJSON } = BSON;

/** Characters of one document (or value) in an event or oplog entry: a huge document doesn't eat the output. */
const VALUE_MAX = 1500;
/** Characters of the output kept for the header and the footer (the resume token must always fit). */
const FRAME = 2000;
/** How long one getMore of watch_changes waits for changes before the deadline is checked again. */
const AWAIT_MS = 500;

/** The change stream events that come only with showExpandedEvents (MongoDB 6.0+). */
const EXPANDED_EVENTS = ['create', 'createIndexes', 'dropIndexes', 'modify', 'shardCollection', 'refineCollectionShardKey', 'reshardCollection'];
const CHANGE_EVENTS = ['insert', 'update', 'replace', 'delete', 'drop', 'rename', 'dropDatabase', 'invalidate', ...EXPANDED_EVENTS];
const OPLOG_OPS: Record<string, string> = { insert: 'i', update: 'u', delete: 'd', command: 'c' };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (isPlainObject(v) ? v : {});
const relaxed = (v: unknown) => relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v);

/** A value in mongosh syntax on one line, cut at VALUE_MAX characters. */
export function clipped(v: unknown, max = VALUE_MAX): string {
  const text = shell(v);
  return text.length > max ? `${text.slice(0, max)}… (${(text.length - max).toLocaleString('en-US')} more characters)` : text;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** An ISO date or a time relative to `now` ("90s", "15m", "2h", "1d", "1w" ago), as a Date; a ToolError otherwise. */
export function parseTime(text: string, key: string, now = Date.now()): Date {
  const relative = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(text.trim());
  if (relative) return new Date(now - Number(relative[1]) * UNITS[relative[2].toLowerCase()]);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new ToolError(`${key} must be an ISO date (e.g. 2024-05-01T10:00:00Z) or a time ago like "15m", "2h", "1d".`);
  return new Date(ms);
}

/** The values an update sets and the fields it unsets, from its oplog entry ($v 2 diff, or $set / $unset); undefined for a replacement. */
export function updateChanges(o: Obj): { set: Obj; unset: string[]; truncated: string[] } | undefined {
  const set: Obj = {};
  const unset: string[] = [];
  const truncated: string[] = [];
  const walk = (diff: Obj, prefix: string) => {
    for (const [k, v] of Object.entries(diff)) {
      if (k === 'u' || k === 'i') for (const [f, x] of Object.entries(obj(v))) set[prefix + f] = x;
      else if (k === 'd') unset.push(...Object.keys(obj(v)).map((f) => prefix + f));
      else if (k === 'a') continue;
      else if (k === 'l') truncated.push(`${prefix.slice(0, -1)} to ${Number(v)}`);
      else if (/^u\d+$/.test(k)) set[prefix + k.slice(1)] = v;
      else if (/^s/.test(k)) walk(obj(v), `${prefix}${k.slice(1)}.`);
    }
  };
  if (isPlainObject(o.diff)) walk(o.diff, '');
  else if (isPlainObject(o.$set) || isPlainObject(o.$unset)) {
    Object.assign(set, obj(o.$set));
    unset.push(...Object.keys(obj(o.$unset)));
  } else return undefined;
  return { set, unset, truncated };
}

/** A resume token from the argument: the _data string, { _data: "…" } as text, or an object. */
export function resumeToken(v: unknown): { _data: string } | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let data: unknown = v;
  if (typeof v === 'string') {
    const text = v.trim();
    if (text.startsWith('{')) {
      try {
        data = toBson(text, 'resumeAfter')?._data;
      } catch {
        data = undefined;
      }
    } else data = text;
  } else if (isPlainObject(v)) data = v._data;
  if (typeof data !== 'string' || !/^[0-9a-f]+$/i.test(data)) throw new ToolError('resumeAfter must be the resume token returned by watch_changes: its _data string (hex), or { _data: "…" }.');
  return { _data: data };
}

/** The strings of an array argument (or a comma-separated string), each one of `allowed`. */
function listArg(args: Record<string, unknown>, key: string, allowed: string[]): string[] {
  const v = args[key];
  if (v === undefined || v === null || v === '') return [];
  const list = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new ToolError(`${key} must be an array of strings.`);
  const values = [...new Set(list.map((x: string) => x.trim()).filter(Boolean))];
  const wrong = values.filter((x) => !allowed.includes(x));
  if (wrong.length) throw new ToolError(`${key}: unknown ${wrong.join(', ')}. Use ${allowed.join(', ')}.`);
  return values;
}

/** The error code of a server error. */
export const codeOf = (err: unknown): number | undefined => (err as { code?: number })?.code;
export const notAuthorized =(err: unknown) => codeOf(err) === 13 || /not authorized|unauthorized/i.test(message(err));

/** Database and collection of the scope; collection needs database. */
function scopeArgs(args: Record<string, unknown>): { database?: string; collection?: string } {
  const database = stringArg(args, 'database');
  const collection = stringArg(args, 'collection');
  if (collection && !database) throw new ToolError('collection needs database.');
  return { database, collection };
}

const scopeText = (info: ConnectionInfo, database?: string, collection?: string) =>
  collection ? `${database}.${collection}` : database ? `the database ${database}` : `every database of ${info.name}`;

/** One change stream event as text: time, operation, namespace, _id, then what changed. */
export function eventText(change: Document): string {
  const op = String(change.operationType ?? '?');
  const ns = change.ns ? [change.ns.db, change.ns.coll].filter(Boolean).join('.') : '';
  const seconds = change.clusterTime instanceof Timestamp ? change.clusterTime.getHighBitsUnsigned() : undefined;
  const time = change.wallTime instanceof Date ? change.wallTime.toISOString() : seconds ? new Date(seconds * 1000).toISOString() : '?';
  const id = change.documentKey?._id;
  const lines = [`${time} ${op} ${ns}${id === undefined ? '' : ` _id: ${clipped(id, 200)}`}`];
  const ud = change.updateDescription as Document | undefined;
  if (ud) {
    if (ud.updatedFields && Object.keys(ud.updatedFields).length) lines.push(`  set: ${clipped(ud.updatedFields)}`);
    if (ud.removedFields?.length) lines.push(`  unset: ${(ud.removedFields as string[]).join(', ')}`);
    if (ud.truncatedArrays?.length) lines.push(`  truncated: ${(ud.truncatedArrays as Document[]).map((t) => `${t.field} to ${Number(t.newSize)}`).join(', ')}`);
  }
  if (change.to) lines.push(`  to: ${[change.to.db, change.to.coll].filter(Boolean).join('.')}`);
  if (change.operationDescription) lines.push(`  description: ${clipped(change.operationDescription)}`);
  if (change.fullDocumentBeforeChange) lines.push(`  before: ${clipped(change.fullDocumentBeforeChange)}`);
  if (change.fullDocument) lines.push(`  ${op === 'update' ? 'after' : 'document'}: ${clipped(change.fullDocument)}`);
  else if (op === 'update' && change.fullDocument === null) lines.push('  after: (the document no longer exists)');
  return lines.join('\n');
}

/** The tools of the change streams and oplog group. */
export function changesTools(ctx: ToolContext): McpTool[] {
  const { connection, client } = ctx;

  const isMongos = async (c: MongoClient) => (await c.db('admin').command({ hello: 1 })).msg === 'isdbgrid';

  return [
    {
      name: 'watch_changes',
      title: 'Watch changes',
      description:
        'Opens a change stream on a collection, a database or the whole deployment, waits up to waitSeconds or until maxEvents changes, and returns them (time, operation, namespace, _id, fields set/unset, the document after and, when the collection records pre-images, before) with a resume token. ' +
        'Passing that token back as resumeAfter continues exactly where the previous call stopped, so calling it repeatedly follows the changes without losing any. Use it to see what an application writes while it runs; `since` also returns changes from a little earlier. Needs a replica set or a sharded cluster.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: { type: 'string', description: 'Watch this database only.' },
          collection: { type: 'string', description: 'Watch this collection only (needs database).' },
          waitSeconds: { type: 'integer', minimum: 0, maximum: 25, default: 10, description: 'How long to wait for changes.' },
          maxEvents: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Return as soon as this many changes arrived.' },
          resumeAfter: { type: 'string', description: 'The resume token of a previous call (its _data string): continue right after it.' },
          operationTypes: { type: 'array', items: { type: 'string', enum: CHANGE_EVENTS }, description: 'Only these operations; empty for all.' },
          filter: {
            type: 'string',
            description: 'A $match on the change event in mongosh syntax, e.g. { "documentKey._id": ObjectId("…") } or { "fullDocument.status": "failed" } or { "updateDescription.updatedFields.status": { $exists: true } }.',
          },
          since: { type: 'string', description: 'Also return the changes from this time on (ISO date, or "5m", "1h" ago), if still in the oplog. Not with resumeAfter.' },
          fullDocument: { type: 'boolean', default: true, description: 'Include the whole document after an update (and before, when the collection records pre-images).' },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      documents: true,
      run: async (args) => {
        const info = connection(args);
        const { database, collection } = scopeArgs(args);
        const waitSeconds = intArg(args, 'waitSeconds', 10, 0, 25);
        const maxEvents = intArg(args, 'maxEvents', 50, 1, 200);
        const resumeAfter = resumeToken(args.resumeAfter);
        const sinceText = stringArg(args, 'since');
        if (resumeAfter && sinceText) throw new ToolError('Use resumeAfter or since, not both.');
        const since = sinceText ? parseTime(sinceText, 'since') : undefined;
        const operationTypes = listArg(args, 'operationTypes', CHANGE_EVENTS);
        const full = boolArg(args, 'fullDocument', true);
        let filter: Document | undefined;
        try {
          filter = toBson(stringArg(args, 'filter') ?? '', 'Filter');
        } catch (err) {
          throw new ToolError(message(err));
        }

        const c = await client(info);
        const version = Number.parseInt(String((await c.db('admin').command({ buildInfo: 1 })).version ?? ''), 10);
        let preImages: boolean | undefined;
        let missing = false;
        if (database && collection) {
          const list = await c.db(database).listCollections({ name: collection }, { nameOnly: false }).toArray().catch(() => undefined);
          if (list) {
            missing = !list.length;
            preImages = !!(list[0]?.options as Document | undefined)?.changeStreamPreAndPostImages?.enabled;
          }
        }

        const match: Document[] = [];
        if (operationTypes.length) match.push({ operationType: { $in: operationTypes } });
        if (filter && Object.keys(filter).length) match.push(filter);
        const pipeline = match.length ? [{ $match: match.length === 1 ? match[0] : { $and: match } }] : [];
        const opts: ChangeStreamOptions = { maxAwaitTimeMS: Math.max(100, Math.min(AWAIT_MS, waitSeconds * 1000)), promoteValues: false, bsonRegExp: true };
        if (full) {
          opts.fullDocument = 'updateLookup';
          // Pre-images exist from MongoDB 6.0; without them on the collection, the field is just missing.
          if (version >= 6) opts.fullDocumentBeforeChange = 'whenAvailable';
        }
        if (operationTypes.some((t) => EXPANDED_EVENTS.includes(t))) {
          if (version < 6) throw new ToolError(`${operationTypes.filter((t) => EXPANDED_EVENTS.includes(t)).join(', ')} events need MongoDB 6.0 or later.`);
          opts.showExpandedEvents = true;
        }
        if (resumeAfter) opts.resumeAfter = resumeAfter;
        if (since) opts.startAtOperationTime = new Timestamp({ t: Math.floor(since.getTime() / 1000), i: 0 });

        const stream: ChangeStream = collection ? c.db(database).collection(collection).watch(pipeline, opts) : database ? c.db(database).watch(pipeline, opts) : c.watch(pipeline, opts);
        const events: Document[] = [];
        let stop: 'max' | 'wait' | 'invalidate' = 'wait';
        let token: unknown;
        let started = false;
        try {
          const deadline = Date.now() + waitSeconds * 1000;
          for (;;) {
            const change = (await stream.tryNext()) as Document | null;
            started = true;
            if (change) {
              events.push(change);
              if (change.operationType === 'invalidate') {
                stop = 'invalidate';
                break;
              }
              if (events.length >= maxEvents) {
                stop = 'max';
                break;
              }
            } else if (Date.now() >= deadline) break;
          }
          token = stream.resumeToken;
        } catch (err) {
          throw watchError(err, info, !!resumeAfter && !started, !!since);
        } finally {
          await stream.close().catch(() => undefined);
        }

        // The events that fit in the output; when some don't, the token is the last one shown, so the next call gets the rest.
        const shown: string[] = [];
        let size = 0;
        for (const e of events) {
          const text = eventText(e);
          if (size + text.length + 2 > MAX_OUTPUT - FRAME && shown.length) break;
          shown.push(text);
          size += text.length + 2;
        }
        const cut = events.length - shown.length;
        if (cut) token = events[shown.length - 1]._id;
        const data = obj(relaxed(token))._data;

        const scope = scopeText(info, database, collection);
        const why =
          stop === 'invalidate'
            ? 'the stream was invalidated (the collection or database was dropped or renamed): start a new watch without resumeAfter'
            : cut
              ? `${plural(cut, 'more event')} didn't fit in the output: call again with resumeAfter to get them`
              : stop === 'max'
                ? `stopped at maxEvents (${maxEvents}): more changes may be waiting, call again with resumeAfter`
                : `waited ${waitSeconds} s`;
        const notes = [
          missing && `${database}.${collection} doesn't exist (yet): the stream sees it once created.`,
          collection && full && preImages === false && 'The collection does not record pre-images (changeStreamPreAndPostImages), so updates and deletes have no before-image.',
        ].filter(Boolean);
        const head = `Changes of ${scope}${since ? ` since ${since.toISOString()}` : resumeAfter ? ' after the resume token' : ''}: ${plural(shown.length, 'event')}, ${why}.${notes.length ? `\n${notes.join('\n')}` : ''}`;
        const foot =
          stop === 'invalidate' || typeof data !== 'string'
            ? ''
            : `\n\nResume token: ${data}\n(pass it as resumeAfter to get the changes after these)`;
        return truncate(`${head}${shown.length ? `\n\n${shown.join('\n\n')}` : ''}${foot}`, MAX_OUTPUT);
      },
    },
    {
      name: 'write_history',
      title: 'Write history',
      description:
        "The recent writes from the oplog (local.oplog.rs) of a replica set, newest first: time, operation, namespace, _id, the inserted document, an update's fields set/unset with their values, commands; operations inside transactions are expanded and marked. " +
        'Answers "what changed this document, and when" without having watched it: filter by collection, document _id, operation and time. Only as far back as the oplog window, which the footer shows.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: { type: 'string', description: 'Only writes to this database.' },
          collection: { type: 'string', description: 'Only writes to this collection (needs database).' },
          id: { type: 'string', description: 'Only writes to the document with this _id, in mongosh syntax: ObjectId("…"), "abc", 42, UUID("…").' },
          operations: { type: 'array', items: { type: 'string', enum: Object.keys(OPLOG_OPS) }, description: 'Only these operations; empty for all.' },
          since: { type: 'string', description: 'Only writes from this time on: ISO date, or "15m", "2h", "1d" ago.' },
          until: { type: 'string', description: 'Only writes up to this time: ISO date, or "15m", "2h", "1d" ago.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Operations returned.' },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      documents: true,
      run: async (args) => {
        const info = connection(args);
        const { database, collection } = scopeArgs(args);
        const limit = intArg(args, 'limit', 50, 1, 500);
        const ops = listArg(args, 'operations', Object.keys(OPLOG_OPS));
        const codes = (ops.length ? ops : Object.keys(OPLOG_OPS)).map((o) => OPLOG_OPS[o]);
        const sinceText = stringArg(args, 'since');
        const untilText = stringArg(args, 'until');
        const now = Date.now();
        const since = sinceText ? parseTime(sinceText, 'since', now) : undefined;
        const until = untilText ? parseTime(untilText, 'until', now) : undefined;
        if (since && until && since > until) throw new ToolError('since is after until.');
        const idText = stringArg(args, 'id');
        let id: unknown;
        if (idText) {
          try {
            id = toBson(`{ v: ${idText} }`, 'id')?.v;
          } catch (err) {
            throw new ToolError(`id: ${message(err)}`);
          }
        }

        const c = await client(info);
        const hello = await c.db('admin').command({ hello: 1 });
        if (hello.msg === 'isdbgrid') throw new ToolError(`${info.name} is a sharded cluster (mongos): the oplog is on each shard. Use a connection to a shard's replica set, or watch_changes.`);
        if (!hello.setName) throw new ToolError(`The oplog exists only on replica sets: ${info.name} is a standalone server. (A single-node replica set is enough, e.g. mongod --replSet rs0 and rs.initiate().)`);

        const filter = writesFilter(codes, database, collection, id);
        const ts: Document = {};
        if (since) ts.$gte = new Timestamp({ t: Math.floor(since.getTime() / 1000), i: 0 });
        if (until) ts.$lt = new Timestamp({ t: Math.floor(until.getTime() / 1000) + 1, i: 0 });
        if (Object.keys(ts).length) filter.ts = ts;

        // The same match on the client, on each operation (inner ones of transactions too).
        const idText1 = id === undefined ? undefined : shell(id);
        const keep = (e: Obj): boolean => {
          if (!codes.includes(String(e.op))) return false;
          const ns = String(e.ns ?? '');
          if (e.op === 'c') {
            if (id !== undefined) return false;
            const [name] = Object.keys(obj(e.o));
            const target = obj(e.o)[name];
            if (collection) return ns === `${database}.$cmd` && target === collection;
            if (database) return ns.startsWith(`${database}.`);
            return true;
          }
          if (collection && ns !== `${database}.${collection}`) return false;
          if (database && !ns.startsWith(`${database}.`)) return false;
          if (idText1 !== undefined) {
            const docId = e.op === 'u' ? obj(e.o2)._id : obj(e.o)._id;
            if (docId === undefined || !sameId(docId, id)) return false;
          }
          return true;
        };

        interface Row {
          entry: Obj;
          txn?: { key: string; label: string };
        }
        const rows: Row[] = [];
        const oplog = c.db('local').collection('oplog.rs');
        let timedOut = false;
        const cursor = oplog.find(filter, { sort: { $natural: -1 }, maxTimeMS: MAX_TIME_MS, promoteValues: false, bsonRegExp: true, batchSize: 500 });
        try {
          for await (const raw of cursor) {
            const e = raw as Obj;
            const inner = e.op === 'c' && Array.isArray(obj(e.o).applyOps) ? (obj(e.o).applyOps as unknown[]).map(obj) : undefined;
            if (inner) {
              const lsid = obj(e.lsid);
              const label = [
                isTransactionEntry(e, inner) ? 'transaction' : 'batched write (one command applied as applyOps)',
                lsid.id !== undefined && `lsid ${shell(lsid.id)}`,
                e.txnNumber !== undefined && `txnNumber ${shell(e.txnNumber)}`,
                (e.partialTxn || nonZero(obj(e.prevOpTime).ts)) && 'part of a larger transaction',
              ]
                .filter(Boolean)
                .join(', ');
              const key = String(e.ts);
              for (const x of inner.filter(keep)) rows.push({ entry: { ...x, ts: e.ts, wall: e.wall }, txn: { key, label } });
            } else if (keep(e)) rows.push({ entry: e });
            if (rows.length > limit) break;
          }
        } catch (err) {
          if (notAuthorized(err)) throw oplogAuthError(info);
          if (codeOf(err) === 50 || /time limit|MaxTimeMSExpired/i.test(message(err))) timedOut = true;
          else throw err;
        } finally {
          await cursor.close().catch(() => undefined);
        }
        const more = rows.length > limit;
        const shown = rows.slice(0, limit);

        let first: Document | undefined;
        let last: Document | undefined;
        try {
          [[first], [last]] = await Promise.all([
            oplog.find({}, { sort: { $natural: 1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray(),
            oplog.find({}, { sort: { $natural: -1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray(),
          ]);
        } catch (err) {
          if (notAuthorized(err)) throw oplogAuthError(info);
          throw err;
        }
        if (timedOut && !shown.length) {
          throw new ToolError(`Reading the oplog took more than ${MAX_TIME_MS / 1000} s without finding a match: narrow it with since/until, collection or id.`);
        }

        // Text of the rows; the operations of one transaction under one heading.
        const out: string[] = [];
        let size = 0;
        let lastTxn: string | undefined;
        let fitted = 0;
        for (const r of shown) {
          let text = rowText(r.entry, r.txn ? '  ' : '');
          if (r.txn && r.txn.key !== lastTxn) text = `${timeOf(r.entry)} ${r.txn.label}:\n${text}`;
          if (size + text.length + 1 > MAX_OUTPUT - FRAME && out.length) break;
          lastTxn = r.txn?.key;
          out.push(text);
          size += text.length + 1;
          fitted++;
        }

        const scope = scopeText(info, database, collection);
        const conditions = [idText && `_id ${idText}`, ops.length && ops.join('/'), since && `since ${since.toISOString()}`, until && `until ${until.toISOString()}`].filter(Boolean);
        const head = `Writes to ${scope}${conditions.length ? ` (${conditions.join(', ')})` : ''}, newest first: ${plural(fitted, 'operation')}${more || fitted < shown.length ? ' (there are older ones: lower until, or raise limit)' : ''}.`;
        const firstTime = first && timeOf(first as Obj);
        const lastTime = last && timeOf(last as Obj);
        const foot = [
          firstTime && lastTime ? `Oplog window: ${firstTime} → ${lastTime} (${hours(firstTime, lastTime)}).` : 'The oplog is empty.',
          since && firstTime && since.getTime() < Date.parse(firstTime) && `since is older than the oplog's first entry: the writes before ${firstTime} are no longer there.`,
          timedOut && `Reading the oplog stopped after ${MAX_TIME_MS / 1000} s: older matches may exist (narrow with since/until).`,
        ].filter(Boolean);
        return truncate(`${head}${out.length ? `\n\n${out.join('\n')}` : ''}\n\n${foot.join('\n')}`, MAX_OUTPUT);
      },
    },
  ];
}

/**
 * The oplog filter of the writes (`codes`: i, u, d, c) to a database, a collection or one document of it
 * (by _id, in o._id or o2._id): the entries themselves, or the applyOps of a transaction containing them.
 */
export function writesFilter(codes: string[], database?: string, collection?: string, id?: unknown): Document {
  const nsMatch: unknown = collection ? `${database}.${collection}` : database ? { $regex: `^${database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` } : undefined;
  const op: Document = {};
  if (nsMatch) op.ns = collection && codes.includes('c') ? { $in: [nsMatch, `${database}.$cmd`] } : nsMatch;
  if (id !== undefined) op.$or = [{ 'o._id': id }, { 'o2._id': id }];
  return { $or: [{ op: { $in: codes }, ...op }, { op: 'c', 'o.applyOps': { $elemMatch: { op: { $in: codes }, ...op } } }] };
}

const nonZero = (ts: unknown) => ts instanceof Timestamp && (ts.t !== 0 || ts.i !== 0);

/** Two _id values are equal (compared as their EJSON, numbers by value). */
function sameId(a: unknown, b: unknown): boolean {
  const n = (v: unknown) => (typeof v === 'number' ? v : v && typeof (v as { valueOf(): unknown }).valueOf() === 'number' ? Number(v) : undefined);
  const [x, y] = [n(a), n(b)];
  if (x !== undefined || y !== undefined) return x === y;
  return JSON.stringify(EJSON.serialize({ v: a })) === JSON.stringify(EJSON.serialize({ v: b }));
}

/** The time of an oplog entry as ISO (its wall clock, or its timestamp's seconds). */
function timeOf(e: Obj): string {
  return oplogEntry(relaxed(e) as Obj).time;
}

/** "3.2 h", "45 min", "12 days" between two ISO times. */
function hours(from: string, to: string): string {
  const s = Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
  if (s < 120) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 3 * 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

/** One oplog operation as text: time, operation, namespace, _id, then the document, the change or the command. */
function rowText(e: Obj, indent: string): string {
  const entry = oplogEntry(relaxed(e) as Obj);
  const o = obj(e.o);
  const id = e.op === 'u' ? obj(e.o2)._id : e.op === 'c' ? undefined : o._id;
  const time = indent ? '' : `${entry.time} `;
  const lines = [`${indent}${time}${entry.op} ${entry.ns}${id === undefined ? '' : ` _id: ${clipped(id, 200)}`}`];
  const sub = `${indent}  `;
  if (e.op === 'i') lines.push(`${sub}document: ${clipped(o)}`);
  else if (e.op === 'u') {
    const change = updateChanges(o);
    if (!change) lines.push(`${sub}replaced with: ${clipped(o)}`);
    else {
      if (Object.keys(change.set).length) lines.push(`${sub}set: ${clipped(change.set)}`);
      if (change.unset.length) lines.push(`${sub}unset: ${change.unset.join(', ')}`);
      if (change.truncated.length) lines.push(`${sub}truncated: ${change.truncated.join(', ')}`);
      if (!Object.keys(change.set).length && !change.unset.length && !change.truncated.length) lines.push(`${sub}no change`);
    }
  } else if (e.op === 'c') lines.push(`${sub}${clipped(o)}`);
  return lines.join('\n');
}

function oplogAuthError(info: ConnectionInfo): ToolError {
  return new ToolError(
    `Not authorized to read the oplog of ${info.name}: reading local.oplog.rs needs a role such as clusterMonitor or readAnyDatabase (or read on the local database). Atlas shared tiers (M0, Flex) don't allow it at all; watch_changes may still work.`,
  );
}

/** The error of a change stream as something the model can act on. */
function watchError(err: unknown, info: ConnectionInfo, resumed: boolean, since: boolean): Error {
  const text = message(err);
  const code = codeOf(err);
  // 40573: $changeStream on a standalone server.
  if (code === 40573 || /only supported on replica sets/i.test(text)) {
    return new ToolError(`Change streams need a replica set or a sharded cluster: ${info.name} is a standalone server. (A single-node replica set is enough, e.g. mongod --replSet rs0 and rs.initiate().)`);
  }
  // 286 ChangeStreamHistoryLost, 280 ChangeStreamFatalError: the starting point has left the oplog.
  if (code === 286 || code === 280 || /no longer be in the oplog|history.*lost/i.test(text)) {
    return new ToolError(
      `${resumed ? 'The resume token is' : since ? 'since is' : 'The starting point is'} older than the oplog: those changes are no longer there. Call again without ${resumed ? 'resumeAfter' : 'since'} to watch from now on (write_history shows what the oplog still has). (${text})`,
    );
  }
  if (notAuthorized(err)) {
    return new ToolError(`Not authorized to open a change stream on ${info.name}: it needs the changeStream and find actions on the watched collections (e.g. the read role on the database; readAnyDatabase for the whole deployment). (${text})`);
  }
  // The tokens are opaque: a wrong one fails in many ways (Overflow, KeyString, bad type…) when the stream starts.
  if (resumed && (err as { name?: string })?.name === 'MongoServerError') {
    return new ToolError(`Invalid resume token: the change stream could not start after it. Pass the token exactly as watch_changes returned it. (${text})`);
  }
  return err instanceof Error ? err : new Error(text);
}
