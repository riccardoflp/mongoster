// MCP tools for performance diagnostics: how a query runs (explain), the slow operations grouped by query
// shape (profiler or server log), the operations running now (currentOp), the index advisor, and the storage
// and index statistics of a collection. They only read: the profiler level is never changed, no operation killed.
import { BSON, Db, Document, MongoClient, MongoServerError } from 'mongodb';
import { McpTool, ToolError, boolArg, intArg, stringArg, truncate } from '../shared/mcp';
import { ExplainSummary, PlanNode, suggestIndex, summarizeExplain } from '../shared/explain';
import { SlowOp, SlowOpGroup, fromLogLine, fromProfileDoc, groupOps, indexableQuery, isNoise, splitNs } from '../shared/profile';
import { Advice, AdvisorCollection, AdvisorIndex, UNUSED_AFTER_MS, analyze } from '../shared/advisor';
import { relaxEjson, toShell } from '../shared/query';
import {
  MAX_OUTPUT,
  MAX_TIME_MS,
  ToolContext,
  collectionProp,
  connectionProp,
  databaseProp,
  filterProp,
  message,
  pipelineProp,
  plural,
  projectionProp,
  shell,
  sortProp,
} from './context';

const { EJSON } = BSON;

/** Profiler documents read per database, the most recent ones. */
const PROFILE_LIMIT = 5000;
/** Collections read at the same time by the advisor. */
const PARALLEL = 8;
/** Command fields that only add noise to the one-line command of an operation. */
const NOISE = new Set(['lsid', '$clusterTime', '$db', '$readPreference', 'txnNumber', 'autocommit', 'startTransaction', 'readConcern', 'writeConcern', 'apiVersion', '$audit', '$client', 'mayBypassWriteBlocking']);

/** A BSON value as relaxed EJSON plain values (what the shared modules work on). */
const relaxed = (v: unknown): unknown => relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v);
const count = (v: number | undefined): string => (v === undefined ? '?' : v.toLocaleString('en-US'));
/** plural() for words whose plural isn't word + s. */
const pluralOf = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const ms = (v: number): string => `${Math.round(v).toLocaleString('en-US')} ms`;
const createIndexCommand = (collection: string, keys: Record<string, unknown>): string => `db.getCollection(${JSON.stringify(collection)}).createIndex(${toShell(keys)})`;

/** "1.5 MB", "812 B". */
export function bytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = n > 0 ? Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024))) : 0;
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** A duration in microseconds: "12.3 s", "450 ms", "80 µs". */
export function duration(micros: number | undefined): string {
  if (micros === undefined) return '?';
  if (micros >= 1e6) return `${(micros / 1e6).toFixed(1)} s`;
  if (micros >= 1e3) return `${Math.round(micros / 1e3)} ms`;
  return `${Math.round(micros)} µs`;
}

/** Whether `ns` is in the namespace filter: a database ("shop") or a collection ("shop.orders"). */
export function inNamespace(ns: string, filter: string | undefined): boolean {
  if (!filter) return true;
  return filter.includes('.') ? ns === filter : splitNs(ns).database === filter;
}

const isUnauthorized = (err: unknown): boolean =>
  (err instanceof MongoServerError && (err.code === 13 || err.codeName === 'Unauthorized')) || /not authorized|requires authentication/i.test(message(err));

/** The error as the model can act on it: which role is missing when the user isn't authorized. */
function refused(err: unknown, action: string, role: string): ToolError {
  return new ToolError(isUnauthorized(err) ? `Not authorized to ${action}: the user needs the ${role} role (${message(err)}).` : `Could not ${action}: ${message(err)}`);
}

// ---- explain

/** The plan, from the result back to the scans, children indented. */
function planLines(node: PlanNode, depth = 0, out: string[] = []): string[] {
  const counts = [
    node.nReturned !== undefined && `${count(node.nReturned)} out`,
    node.keysExamined !== undefined && `${count(node.keysExamined)} keys`,
    node.docsExamined !== undefined && `${count(node.docsExamined)} docs`,
    node.timeMs !== undefined && `~${node.timeMs} ms`,
  ].filter(Boolean);
  const details = Object.entries(node.details).map(([k, v]) => `${k}: ${shell(v)}`);
  out.push(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${node.stage}${counts.length ? ` (${counts.join(', ')})` : ''}${details.length ? `  ${details.join('  ')}` : ''}`);
  for (const c of node.children) planLines(c, depth + 1, out);
  return out;
}

/** The summary of explain("executionStats") as text: verdict, numbers, suggested index, plan and later stages. */
export function explainText(head: string, collection: string, s: ExplainSummary, suggestion: Record<string, 1 | -1> | null): string {
  const verdict = [
    s.collscan && 'COLLSCAN (every document of the collection is read: no index serves the filter)',
    s.indexes.length && `index ${s.indexes.join(', ')}`,
    !s.collscan && !s.indexes.length && s.plan && s.plan.stage,
    s.inMemorySort && 'in-memory sort (no index gives the order)',
    s.rejectedPlans && plural(s.rejectedPlans, 'rejected plan'),
  ].filter(Boolean);
  const lines = [head, `Plan: ${verdict.join('; ') || 'unknown'}.`];
  const numbers = [
    s.nReturned !== undefined && `returned ${count(s.nReturned)}`,
    s.totalKeysExamined !== undefined && `keys examined ${count(s.totalKeysExamined)}`,
    s.totalDocsExamined !== undefined && `documents examined ${count(s.totalDocsExamined)}`,
    s.executionTimeMillis !== undefined && `time ${ms(s.executionTimeMillis)}`,
  ].filter(Boolean);
  if (numbers.length) lines.push(`${numbers.join(', ')}.`);
  const examined = s.totalDocsExamined ?? 0;
  const returned = s.nReturned ?? 0;
  if (examined > 0 && examined >= Math.max(returned, 1) * 10) {
    lines.push(returned ? `${count(Math.round(examined / returned))} documents examined for each one returned.` : `${count(examined)} documents examined, none returned.`);
  }
  if (suggestion) {
    lines.push(`Suggested index (equality fields, then the sort, then range fields: the ESR rule): ${toShell(suggestion)}`, `  ${createIndexCommand(collection, suggestion)}`);
  }
  if (s.plan) lines.push('', 'Query plan:', ...planLines(s.plan));
  if (s.pipeline.length) {
    lines.push('', 'Pipeline stages after the query:');
    for (const p of s.pipeline) {
      const counts = [p.nReturned !== undefined && `${count(p.nReturned)} out`, p.timeMs !== undefined && `~${p.timeMs} ms`].filter(Boolean);
      lines.push(`- ${p.stage}${counts.length ? ` (${counts.join(', ')})` : ''}`);
    }
  }
  return lines.join('\n');
}

// ---- slow operations

interface ProfilerStatus {
  level?: number;
  slowms?: number;
  error?: unknown;
}

async function profilerStatus(db: Db): Promise<ProfilerStatus> {
  try {
    const s = await db.command({ profile: -1 });
    return { level: Number(s.was), slowms: Number(s.slowms) };
  } catch (error) {
    return { error };
  }
}

async function readProfiler(db: Db, since?: Date): Promise<{ ops: SlowOp[]; limited: boolean }> {
  const docs = await db
    .collection('system.profile')
    .find(since ? { ts: { $gte: since } } : {}, { maxTimeMS: MAX_TIME_MS })
    .sort({ ts: -1 })
    .limit(PROFILE_LIMIT + 1)
    .toArray();
  return { ops: docs.slice(0, PROFILE_LIMIT).map((d) => fromProfileDoc(relaxed(d) as Record<string, unknown>)), limited: docs.length > PROFILE_LIMIT };
}

/** The "Slow query" lines of the server's recent log (the server keeps its last 1,024 lines). */
async function readLog(client: MongoClient, since?: Date): Promise<{ ops: SlowOp[]; limited: boolean }> {
  let res: Document;
  try {
    res = await client.db('admin').command({ getLog: 'global' });
  } catch (err) {
    throw refused(err, 'read the server log (getLog)', 'clusterMonitor');
  }
  const lines = (res.log ?? []) as string[];
  const ops = lines.map(fromLogLine).filter((op): op is SlowOp => !!op && (!since || new Date(op.ts) >= since));
  return { ops: ops.reverse(), limited: Number(res.totalLinesWritten ?? 0) > lines.length };
}

/** A group of slow operations as text, its literal values left out (the shape has ? instead). */
export function groupText(g: SlowOpGroup, i: number): string {
  const { collection } = splitNs(g.ns);
  const runs = g.count - g.getMores;
  const lines = [
    `${i}. ${g.kind} ${g.ns}${g.shape ? `: ${g.shape}` : ''}`,
    `   ${plural(runs || g.count, 'operation')}${g.getMores ? ` + ${pluralOf(g.getMores, 'next batch', 'next batches')}` : ''}, total ${ms(g.totalMs)}, avg ${ms(g.avgMs)}, max ${ms(g.maxMs)}`,
    `   examined ${plural(g.docsExamined, 'document')} and ${plural(g.keysExamined, 'key')} for ${count(g.nreturned)} returned${g.docsExamined >= Math.max(g.nreturned, 1) * 10 ? ` (${count(Math.round(g.docsExamined / Math.max(g.nreturned, 1)))} per document returned)` : ''}`,
  ];
  const plan = [g.plans.length ? `plan ${g.plans.join(' | ')}` : '', g.sortStage ? 'in-memory sort' : ''].filter(Boolean);
  if (plan.length) lines.push(`   ${plan.join(', ')}`);
  if (g.suggestion) lines.push(`   index that could help: ${toShell(g.suggestion)}  →  ${createIndexCommand(collection, g.suggestion)}`);
  // The log writes local times with their offset, the profiler UTC: both as UTC.
  const last = new Date(g.last);
  lines.push(`   last ${Number.isNaN(last.getTime()) ? g.last : last.toISOString()}${g.apps.length ? `, apps: ${g.apps.join(', ')}` : ''}`);
  return lines.join('\n');
}

// ---- running operations

/** The command of an operation on one line, without session noise. */
export function commandLine(command: unknown, max = 300): string {
  if (!command || typeof command !== 'object') return '';
  const text = shell(Object.fromEntries(Object.entries(command as Document).filter(([k]) => !NOISE.has(k))));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** An entry of currentOp as text. */
export function operationText(op: Document): string {
  const micros = op.microsecs_running !== undefined ? Number(op.microsecs_running) : op.secs_running !== undefined ? Number(op.secs_running) * 1e6 : undefined;
  const head = [
    `opid ${String(op.opid)}`,
    op.active ? 'active' : 'idle',
    micros !== undefined && duration(micros),
    op.op ?? op.type,
    op.ns,
    op.planSummary && `plan ${op.planSummary}`,
  ].filter(Boolean);
  const lines = [`- ${head.join(' · ')}`];
  const command = commandLine(op.command ?? op.query);
  if (command) lines.push(`  ${command}`);
  const users = (op.effectiveUsers as { user: string; db: string }[] | undefined)?.map((u) => `${u.user}@${u.db}`).join(', ');
  const client = op.client ?? op.client_s;
  const who = [client ? `client ${client}` : 'internal (no client)', op.desc && `(${op.desc})`, op.appName && `app ${JSON.stringify(op.appName)}`, users && `user ${users}`].filter(Boolean);
  lines.push(`  ${who.join(' ')}`);
  const state = [
    op.waitingForLock && 'WAITING FOR A LOCK',
    op.locks && Object.keys(op.locks).length && `locks ${shell(op.locks)}`,
    op.msg && `${op.msg}${op.progress?.total ? ` (${count(Number(op.progress.done))}/${count(Number(op.progress.total))})` : ''}`,
    op.killPending && 'kill pending',
  ].filter(Boolean);
  if (state.length) lines.push(`  ${state.join(' · ')}`);
  const txn = op.transaction as Document | undefined;
  if (txn) {
    const parts = [
      txn.parameters?.txnNumber !== undefined && `txnNumber ${String(txn.parameters.txnNumber)}`,
      txn.timeOpenMicros !== undefined && `open ${duration(Number(txn.timeOpenMicros))}`,
      txn.timeActiveMicros !== undefined && `active ${duration(Number(txn.timeActiveMicros))}`,
      txn.expiryTime instanceof Date && `expires ${txn.expiryTime.toISOString()}`,
    ].filter(Boolean);
    lines.push(`  transaction ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

const microsOf = (op: Document): number =>
  op.microsecs_running !== undefined ? Number(op.microsecs_running) : op.secs_running !== undefined ? Number(op.secs_running) * 1e6 : 0;

// ---- index advisor

async function parallel<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

/** Uses per index from $indexStats, summed over the hosts (and shards); counted since the most recent of their starts. */
function indexUsage(stats: Document[]): Map<string, { ops: number; since?: string; hosts: number; building: boolean }> {
  const usage = new Map<string, { ops: number; since?: string; hosts: number; building: boolean }>();
  for (const s of stats) {
    const name = String(s.name);
    const u = usage.get(name) ?? { ops: 0, hosts: 0, building: false };
    usage.set(name, u);
    if (s.building) u.building = true;
    if (!s.accesses) continue;
    u.ops += Number(s.accesses.ops);
    u.hosts++;
    const since = s.accesses.since instanceof Date ? s.accesses.since.toISOString() : undefined;
    if (since && (!u.since || since > u.since)) u.since = since;
  }
  return usage;
}

/** One document per shard on a sharded cluster, one elsewhere. */
async function storageStats(db: Db, collection: string): Promise<Document[]> {
  const res = await db.collection(collection).aggregate<Document>([{ $collStats: { storageStats: {} } }], { maxTimeMS: MAX_TIME_MS }).toArray();
  return res.filter((s) => s.storageStats).map((s) => ({ ...(s.storageStats as Document), shard: s.shard }));
}

/** An index as the advice shows it: name, keys, size, uses. */
function indexLabel(ix: AdvisorIndex): string {
  const extra = [ix.size !== undefined && bytes(ix.size), ix.ops !== undefined && `${plural(ix.ops, 'use')}${ix.since ? ` since ${ix.since}` : ''}`].filter(Boolean);
  return `${ix.name} ${toShell(ix.key)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

/** The advisor's advice as text: indexes to create (with the command and the queries they serve), redundant, unused and hidden ones. */
export function adviceText(advice: Advice[], tooRecent: number): string[] {
  const lines: string[] = [];
  const create = advice.filter((a): a is Extract<Advice, { kind: 'create' }> => a.kind === 'create');
  if (create.length) {
    lines.push('', 'Indexes to create (for the slow operations; equality fields, then the sort, then range fields):');
    create.forEach((a, i) => {
      lines.push(
        `${i + 1}. ${a.database}.${a.collection} ${toShell(a.keys)}: serves ${plural(a.queries.length, 'query shape')}, ${plural(a.count, 'operation')}, ${ms(a.totalMs)} in total`,
        `   ${createIndexCommand(a.collection, a.keys)}`,
      );
      for (const q of a.queries) {
        const flags = [q.collscan && 'COLLSCAN', q.sortStage && 'in-memory sort'].filter(Boolean);
        lines.push(
          `   - ${q.kind} ${q.shape || ''}`.trimEnd() +
            `: ${plural(q.count, 'operation')}, avg ${ms(q.avgMs)}, max ${ms(q.maxMs)}, ${plural(q.docsExamined, 'document')} examined for ${count(q.nreturned)} returned${flags.length ? `, ${flags.join(', ')}` : ''}`,
        );
      }
    });
  }
  const redundant = advice.filter((a): a is Extract<Advice, { kind: 'redundant' }> => a.kind === 'redundant');
  if (redundant.length) {
    lines.push('', 'Redundant indexes (another index starts with the same keys and serves the same queries; dropping one saves writes and memory):');
    for (const a of redundant) lines.push(`- ${a.database}.${a.collection} ${indexLabel(a.index)}: served by ${a.by.name} ${toShell(a.by.key)}`);
  }
  const unused = advice.filter((a): a is Extract<Advice, { kind: 'unused' | 'hidden' }> => a.kind === 'unused');
  if (unused.length) {
    lines.push('', 'Unused indexes (no query used them since their statistics started; check periodic jobs and other members before dropping):');
    for (const a of unused) lines.push(`- ${a.database}.${a.collection} ${indexLabel(a.index)}`);
  }
  const hidden = advice.filter((a): a is Extract<Advice, { kind: 'unused' | 'hidden' }> => a.kind === 'hidden');
  if (hidden.length) {
    lines.push('', 'Hidden indexes (kept up to date but not used by queries: unhide or drop them):');
    for (const a of hidden) lines.push(`- ${a.database}.${a.collection} ${indexLabel(a.index)}`);
  }
  if (tooRecent) {
    lines.push(
      '',
      `${pluralOf(tooRecent, 'index', 'indexes')} not used yet, whose statistics started less than ${UNUSED_AFTER_MS / 3600_000} hours ago (a new index or a server restart): too early to call them unused.`,
    );
  }
  return lines;
}

// ---- tools

/** The performance diagnostics tools: explain_query, slow_queries, current_operations, index_advice, collection_stats. */
export function performanceTools(ctx: ToolContext): McpTool[] {
  const { connection, client, required, target, query, pipeline } = ctx;

  /** Slow operations from the profiler of `database` or the server log, as slow_queries and index_advice read them. */
  const slowOps = async (
    mongo: MongoClient,
    source: 'auto' | 'profiler' | 'log',
    database: string | undefined,
    since: Date | undefined,
  ): Promise<{ ops: SlowOp[]; used: 'profiler' | 'log'; status: ProfilerStatus; notes: string[]; limited: boolean }> => {
    const notes: string[] = [];
    let status: ProfilerStatus = {};
    if (source !== 'log' && database) {
      const db = mongo.db(database);
      status = await profilerStatus(db);
      if (source === 'profiler' && status.error) throw refused(status.error, `read the profiler status of ${database}`, 'dbAdmin');
      let entries = false;
      let readError: unknown;
      try {
        entries = !!(await db.collection('system.profile').findOne({}, { projection: { _id: 1 }, maxTimeMS: MAX_TIME_MS }));
      } catch (err) {
        readError = err;
      }
      if (source === 'profiler' && readError) throw refused(readError, `read ${database}.system.profile`, 'dbAdmin');
      if (!readError && (source === 'profiler' || (status.level ?? 0) > 0 || entries)) {
        const { ops, limited } = await readProfiler(db, since).catch((err) => {
          throw refused(err, `read ${database}.system.profile`, 'dbAdmin');
        });
        if (status.level === 0) {
          notes.push(
            entries
              ? `The profiler of ${database} is off now: these are the operations it recorded before. It can be turned on in Mongoster's server monitor (Profiler) or with db.setProfilingLevel(1).`
              : `The profiler of ${database} is off (level 0), so it records nothing: it can be turned on in Mongoster's server monitor (Profiler) or with db.setProfilingLevel(1, { slowms: 100 }) on ${database}. Without it, source "log" reads the slow operations of the server log.`,
          );
        }
        if (limited) notes.push(`Only the ${count(PROFILE_LIMIT)} most recent profiler entries were read.`);
        return { ops: ops.filter((op) => !isNoise(op)), used: 'profiler', status, notes, limited };
      }
      if (status.error || readError) {
        notes.push(`The profiler of ${database} couldn't be read (${message(status.error ?? readError)}; it needs the dbAdmin role): showing the slow operations of the server log.`);
      } else {
        notes.push(
          `The profiler of ${database} is off (level 0) and has recorded nothing: showing the slow operations of the server log. The profiler can be turned on in Mongoster's server monitor (Profiler) or with db.setProfilingLevel(1, { slowms: 100 }) on ${database}.`,
        );
      }
    }
    if (status.slowms === undefined) {
      const admin = await profilerStatus(mongo.db(database ?? 'admin'));
      status = { ...status, slowms: admin.slowms };
    }
    const { ops, limited } = await readLog(mongo, since);
    if (limited) notes.push('The server keeps only its most recent 1,024 log lines in memory: older slow operations are not in them.');
    return { ops: ops.filter((op) => !isNoise(op) && (!database || splitNs(op.ns).database === database)), used: 'log', status, notes, limited };
  };

  return [
    {
      name: 'explain_query',
      title: 'Explain a query',
      description:
        'How MongoDB runs a find (filter, sort, projection, limit) or an aggregation pipeline: explain("executionStats") summarized as text, with the plan (COLLSCAN or the index used, in-memory sort, rejected plans, shards), documents and keys examined vs returned, time, the stages after the query layer, and the index to create when none serves the query (ESR rule). executionStats runs the query to measure it (reads only; $out/$merge are refused). Use it to find out why a query is slow.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: databaseProp,
          collection: collectionProp,
          filter: filterProp,
          sort: sortProp,
          projection: projectionProp,
          limit: { type: 'integer', minimum: 0, description: 'Limit of the find; 0 or absent for none.' },
          pipeline: { ...pipelineProp, description: `${pipelineProp.description} Give either a pipeline or filter/sort/projection/limit.` },
        },
        required: ['connection', 'database', 'collection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const isPipeline = stringArg(args, 'pipeline') !== undefined;
        const limit = intArg(args, 'limit', 0, 0, Number.MAX_SAFE_INTEGER);
        if (isPipeline && (['filter', 'sort', 'projection'].some((k) => stringArg(args, k) !== undefined) || limit)) {
          throw new ToolError('Give either a pipeline or filter/sort/projection/limit, not both: put a $match, $sort, $project or $limit stage in the pipeline instead.');
        }
        const p = isPipeline ? pipeline(args) : undefined;
        const q = isPipeline ? undefined : query(args);
        const { database, collection, coll } = await target(args);
        let raw: Document;
        let indexable: { filter?: unknown; sort?: unknown };
        try {
          if (p) {
            raw = await coll.aggregate(p.pipeline, { allowDiskUse: true, maxTimeMS: MAX_TIME_MS }).explain('executionStats');
            indexable = indexableQuery('aggregate', { pipeline: relaxed(p.pipeline) as Record<string, unknown>[] });
          } else {
            raw = await coll.find(q!.filter, { sort: q!.sort, projection: q!.projection, ...(limit ? { limit } : {}), maxTimeMS: MAX_TIME_MS }).explain('executionStats');
            indexable = { filter: relaxed(q!.filter), sort: q!.sort && relaxed(q!.sort) };
          }
        } catch (err) {
          throw new ToolError(`Explain failed: ${message(err)}`);
        }
        const summary = summarizeExplain(raw);
        const suggestion = summary.collscan || summary.inMemorySort ? suggestIndex(indexable.filter, indexable.sort) : null;
        const what = p
          ? `aggregate (${plural(p.stages.length, 'stage')}: ${p.stages.map((s) => s.op).join(', ')})`
          : `find ${q!.text.filter || '{}'}${q!.text.sort ? ` sort ${q!.text.sort}` : ''}${limit ? ` limit ${limit}` : ''}`;
        return truncate(explainText(`${database}.${collection} ${what}, explain("executionStats"):`, collection, summary, suggestion), MAX_OUTPUT);
      },
    },
    {
      name: 'slow_queries',
      title: 'Slow queries',
      description:
        'The slow operations grouped by query shape (values replaced by ?), slowest in total first: count, total/avg/max ms, documents and keys examined vs returned, plan (COLLSCAN or index), in-memory sort, and the index that could help with its createIndex command. Read from the database profiler (system.profile) or the server log\'s "Slow query" lines; never changes the profiler level. Use it to find what makes a database slow.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: { type: 'string', description: 'Database whose profiler is read; with the log, only its operations are kept.' },
          source: {
            type: 'string',
            enum: ['auto', 'profiler', 'log'],
            default: 'auto',
            description: "auto: the profiler of database when it is on or has entries, otherwise the server log (its last 1,024 lines, operations slower than slowms). profiler needs database.",
          },
          sinceMinutes: { type: 'integer', minimum: 0, default: 60, description: 'Operations of the last minutes; 0 for all.' },
          namespace: { type: 'string', description: 'Only this database ("shop") or collection ("shop.orders").' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Query shapes returned.' },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const source = stringArg(args, 'source') ?? 'auto';
        if (source !== 'auto' && source !== 'profiler' && source !== 'log') throw new ToolError('source must be auto, profiler or log.');
        const namespace = stringArg(args, 'namespace');
        const database = stringArg(args, 'database') ?? (namespace ? splitNs(namespace).database : undefined);
        if (source === 'profiler' && !database) throw new ToolError('database is required with source "profiler": each database has its own profiler.');
        const sinceMinutes = intArg(args, 'sinceMinutes', 60, 0, 10_000_000);
        const limit = intArg(args, 'limit', 20, 1, 200);
        const since = sinceMinutes ? new Date(Date.now() - sinceMinutes * 60_000) : undefined;
        const mongo = await client(info);
        const read = await slowOps(mongo, source, database, since);
        const ops = read.ops.filter((op) => inNamespace(op.ns, namespace));
        const groups = groupOps(ops);
        const from =
          read.used === 'profiler'
            ? `the profiler of ${database} (level ${read.status.level ?? '?'}${read.status.slowms !== undefined ? `, slowms ${read.status.slowms}` : ''})`
            : `the server log (operations slower than ${read.status.slowms ?? 100} ms${database ? `, database ${database}` : ''})`;
        const lines = [
          `Slow operations ${sinceMinutes ? `of the last ${plural(sinceMinutes, 'minute')}` : 'recorded'} from ${from}${namespace ? ` in ${namespace}` : ''}: ${plural(ops.length, 'operation')} in ${plural(groups.length, 'query shape')}${groups.length ? ', slowest in total first' : ''}.`,
          ...read.notes,
        ];
        if (groups.length) lines.push('', ...groups.slice(0, limit).map((g, i) => groupText(g, i + 1)));
        if (groups.length > limit) lines.push('', `… ${plural(groups.length - limit, 'more query shape')}: raise limit or narrow with namespace.`);
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'current_operations',
      title: 'Current operations',
      description:
        'The operations running on the server now (currentOp), longest first: opid, running time, type, namespace, the command on one line, plan, client and app name, user, locks and whether it is waiting for one, transaction (txnNumber, time open). Never kills anything. Use it to see what the server is busy with or what is blocking.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          minSeconds: { type: 'number', minimum: 0, default: 0, description: 'Only operations running for at least this many seconds.' },
          namespace: { type: 'string', description: 'Only this database ("shop") or collection ("shop.orders").' },
          waitingForLock: { type: 'boolean', default: false, description: 'Only the operations waiting for a lock.' },
          includeIdle: { type: 'boolean', default: false, description: 'Also idle connections, cursors and sessions (open transactions).' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const raw = args.minSeconds;
        const minSeconds = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
        if (!Number.isFinite(minSeconds) || minSeconds < 0) throw new ToolError('minSeconds must be a number of seconds, 0 or more.');
        const namespace = stringArg(args, 'namespace');
        const waiting = boolArg(args, 'waitingForLock', false);
        const includeIdle = boolArg(args, 'includeIdle', false);
        const limit = intArg(args, 'limit', 50, 1, 500);
        const admin = (await client(info)).db('admin');
        let res: Document;
        let own = false;
        try {
          res = await admin.command({ currentOp: 1, $all: includeIdle });
        } catch (err) {
          if (!isUnauthorized(err)) throw new ToolError(`currentOp failed: ${message(err)}`);
          // Without the inprog privilege a user can still see its own operations.
          try {
            res = await admin.command({ currentOp: 1, $all: includeIdle, $ownOps: true });
            own = true;
          } catch {
            throw refused(err, 'list the operations (currentOp)', 'clusterMonitor');
          }
        }
        const all = ((res.inprog ?? []) as Document[]).filter((op) => !(op.command && 'currentOp' in op.command));
        const ops = all
          .filter((op) => microsOf(op) >= minSeconds * 1e6 && (!namespace || inNamespace(String(op.ns ?? ''), namespace) || inNamespace(String(op.ns ?? '').replace(/\.\$cmd$/, ''), namespace)))
          .filter((op) => !waiting || op.waitingForLock)
          .sort((a, b) => Number(!!b.active) - Number(!!a.active) || microsOf(b) - microsOf(a));
        const filters = [minSeconds && `running ${minSeconds} s or more`, namespace && `in ${namespace}`, waiting && 'waiting for a lock'].filter(Boolean);
        const lines = [
          `${plural(ops.length, 'operation')}${filters.length ? ` ${filters.join(', ')}` : ''} (of ${count(all.length)} ${includeIdle ? 'including idle ones' : 'active'})${ops.length > limit ? `, the first ${limit}` : ''}.`,
        ];
        if (own) lines.push("Only the user's own operations: seeing all of them needs the clusterMonitor role (inprog).");
        if (ops.length) lines.push('', ...ops.slice(0, limit).map(operationText));
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'index_advice',
      title: 'Index advice',
      description:
        "The index advisor for a database or one collection: the indexes worth creating for the slow operations (from the profiler, or else the server log) with their createIndex command and the query shapes they serve; the redundant indexes and the index that already serves their queries; the unused ones (no use since their statistics started) and hidden ones, with sizes. Use it to find missing or useless indexes. Only reads.",
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, database: databaseProp, collection: { type: 'string', description: 'Only this collection.' } },
        required: ['connection', 'database'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = required(args, 'database');
        const only = stringArg(args, 'collection');
        const mongo = await client(info);
        const db = mongo.db(database);
        const infos = await db.listCollections(only ? { name: only } : {}, { nameOnly: false, authorizedCollections: true }).toArray();
        if (only && !infos.length) throw new ToolError(`${database}.${only} doesn't exist on ${info.name}: use list_collections.`);
        if (only && infos[0].type === 'view') return `${database}.${only} is a view: it has no indexes of its own (the indexes of ${String((infos[0] as Document).options?.viewOn)} serve it).`;
        const list: AdvisorCollection[] = infos.filter((c) => c.type !== 'view' && !c.name.startsWith('system.')).map((c) => ({ database, collection: c.name, indexes: [] }));
        const failed: string[] = [];
        let noUsage = false;
        await parallel(list, async (c) => {
          const coll = db.collection(c.collection);
          try {
            const [indexes, stats, storage, documents] = await Promise.all([
              coll.listIndexes().toArray(),
              coll
                .aggregate<Document>([{ $indexStats: {} }], { maxTimeMS: MAX_TIME_MS })
                .toArray()
                .catch((err) => {
                  if (isUnauthorized(err)) noUsage = true;
                  return [] as Document[];
                }),
              storageStats(db, c.collection).catch(() => [] as Document[]),
              coll.estimatedDocumentCount({ maxTimeMS: MAX_TIME_MS }).catch(() => undefined),
            ]);
            const usage = indexUsage(stats);
            c.documents = documents;
            c.indexes = indexes.map((ix): AdvisorIndex => {
              const u = usage.get(String(ix.name));
              const sizes = storage.map((s) => s.indexSizes?.[ix.name]).filter((n) => n !== undefined);
              return {
                name: String(ix.name),
                key: relaxed(ix.key) as Record<string, unknown>,
                unique: ix.unique || undefined,
                sparse: ix.sparse || undefined,
                hidden: ix.hidden || undefined,
                expireAfterSeconds: ix.expireAfterSeconds,
                partialFilterExpression: ix.partialFilterExpression ? relaxed(ix.partialFilterExpression) : undefined,
                collation: ix.collation?.locale,
                size: sizes.length ? sizes.reduce((n: number, s) => n + Number(s), 0) : undefined,
                ops: u?.hosts ? u.ops : undefined,
                since: u?.since,
                building: u?.building || undefined,
              };
            });
          } catch (err) {
            failed.push(`${database}.${c.collection}: ${message(err)}`);
          }
        });
        const collections = list.filter((c) => c.indexes.length);
        const names = new Set(collections.map((c) => `${c.database}.${c.collection}`));
        let read: Awaited<ReturnType<typeof slowOps>> | undefined;
        let opsError: string | undefined;
        try {
          read = await slowOps(mongo, 'auto', database, undefined);
        } catch (err) {
          opsError = message(err);
        }
        const ops = (read?.ops ?? []).filter((op) => names.has(op.ns));
        const { advice, tooRecent } = analyze(collections, ops);
        const indexes = collections.flatMap((c) => c.indexes);
        const lines = [
          `Index advice for ${only ? `${database}.${only}` : database}: ${plural(collections.length, 'collection')}, ${pluralOf(indexes.length, 'index', 'indexes')}, ${bytes(indexes.reduce((n, ix) => n + (ix.size ?? 0), 0))} of indexes.`,
          opsError
            ? `Slow operations not read: ${opsError}`
            : `Slow operations read: ${plural(ops.length, 'operation')} on these collections from ${read!.used === 'profiler' ? `the profiler of ${database}` : 'the server log'}${ops.length ? ` since ${ops.reduce((min, op) => (op.ts < min ? op.ts : min), ops[0].ts)}` : ''}.`,
          ...(read?.notes ?? []),
          ...(noUsage ? ['Index uses were not read: $indexStats needs the clusterMonitor role, so unused indexes are not reported.'] : []),
          ...failed.map((f) => `Not read: ${f}`),
        ];
        const body = adviceText(advice, tooRecent);
        lines.push(...(body.length ? body : ['', 'No advice: no missing, redundant, unused or hidden index found.']));
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'collection_stats',
      title: 'Collection statistics',
      description:
        'Storage and index statistics of a collection: documents, data size, storage size on disk and compression, free space, average document size, capped, number of indexes and their total size, and per index: keys, size, uses since when ($indexStats, summed over hosts and shards), building, hidden. For a view: what it is defined on. Use it to judge the size and the cost of a collection and its indexes.',
      inputSchema: { type: 'object', properties: { connection: connectionProp, database: databaseProp, collection: collectionProp }, required: ['connection', 'database', 'collection'], additionalProperties: false },
      readOnly: true,
      run: async (args) => {
        const { info, database, collection, coll } = await target(args);
        const db = (await client(info)).db(database);
        const [meta] = await db.listCollections({ name: collection }, { nameOnly: false }).toArray();
        const options = ((meta as Document | undefined)?.options ?? {}) as Document;
        if (meta?.type === 'view') {
          return `${database}.${collection} is a view on ${String(options.viewOn)} with the pipeline ${shell(options.pipeline ?? [])}: it stores no documents and has no indexes of its own; use collection_stats on ${String(options.viewOn)}.`;
        }
        let storage: Document[];
        try {
          storage = await storageStats(db, collection);
        } catch (err) {
          throw refused(err, `read the statistics of ${database}.${collection} ($collStats)`, 'read (collStats action) or clusterMonitor');
        }
        const notes: string[] = [];
        const [indexes, stats] = await Promise.all([
          coll.listIndexes().toArray(),
          coll
            .aggregate<Document>([{ $indexStats: {} }], { maxTimeMS: MAX_TIME_MS })
            .toArray()
            .catch((err) => {
              notes.push(isUnauthorized(err) ? 'Index uses were not read: $indexStats needs the clusterMonitor role.' : `Index uses were not read: ${message(err)}`);
              return [] as Document[];
            }),
        ]);
        // An index being built may be missing from listIndexes: $indexStats has its definition.
        for (const s of stats) if (s.building && s.spec && !indexes.some((ix) => ix.name === s.name)) indexes.push(s.spec as Document);
        const usage = indexUsage(stats);
        const builds = new Set<string>(storage.flatMap((s) => (s.indexBuilds as string[] | undefined) ?? []));
        const sum = (field: string): number | undefined => (storage.some((s) => s[field] !== undefined) ? storage.reduce((n, s) => n + Number(s[field] ?? 0), 0) : undefined);
        const documents = sum('count');
        const size = sum('size');
        const storageSize = sum('storageSize');
        const free = sum('freeStorageSize');
        const indexSize = sum('totalIndexSize');
        const first = storage[0] ?? {};
        const lines = [
          `${database}.${collection}${meta?.type === 'timeseries' ? ' (time series collection)' : ''}${storage.length > 1 ? ` on ${plural(storage.length, 'shard')}` : ''}:`,
          `- documents: ${count(documents)}`,
          `- data size: ${bytes(size)} (uncompressed), average document ${documents ? bytes(Math.round((size ?? 0) / documents)) : '–'}`,
          `- storage size: ${bytes(storageSize)} on disk${size && storageSize ? `, ${(size / storageSize).toFixed(1)}x compression` : ''}${free !== undefined ? `, of which ${bytes(free)} free and reusable` : ''}`,
          `- capped: ${first.capped ? `yes${first.maxSize ? `, max ${bytes(Number(first.maxSize))}` : ''}${first.max ? `, max ${count(Number(first.max))} documents` : ''}` : 'no'}`,
          `- indexes: ${indexes.length}, total size ${bytes(indexSize)}${size && indexSize ? ` (${Math.round((indexSize / size) * 100)}% of the data size)` : ''}`,
          '',
          'Indexes:',
        ];
        for (const ix of indexes) {
          const name = String(ix.name);
          const sizes = storage.map((s) => s.indexSizes?.[name]).filter((n) => n !== undefined);
          const u = usage.get(name);
          const parts = [
            sizes.length ? bytes(sizes.reduce((n: number, s) => n + Number(s), 0)) : 'size ?',
            u?.hosts ? `${plural(u.ops, 'use')}${u.since ? ` since ${u.since}` : ''}${u.hosts > 1 ? ` (sum over ${u.hosts} hosts)` : ''}` : undefined,
            ix.unique && 'unique',
            ix.sparse && 'sparse',
            ix.expireAfterSeconds !== undefined && `TTL ${ix.expireAfterSeconds}s`,
            ix.partialFilterExpression && `partial ${shell(ix.partialFilterExpression)}`,
            ix.hidden && 'hidden',
            (builds.has(name) || u?.building) && 'BUILDING',
          ].filter(Boolean);
          lines.push(`- ${name} ${shell(ix.key)}: ${parts.join(', ')}`);
        }
        if (notes.length) lines.push('', ...notes);
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
  ];
}
