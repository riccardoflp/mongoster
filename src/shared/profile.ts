// Slow operations from the database profiler (system.profile) or the server log ("Slow query" lines):
// one shape per query (values replaced by ?), grouped with their totals, and the index that could help.
import { suggestIndex } from './explain';
import { isEjsonWrapper, isPlainObject, toShell } from './query';

export type SlowOpSource = 'profiler' | 'log';

export interface SlowOp {
  /** ISO date. */
  ts: string;
  /** find, aggregate, count, distinct, findAndModify, update, delete, insert, getMore of a find…, or the command name. */
  kind: string;
  /** A getMore: the next batch of the cursor of `kind`. */
  getMore?: boolean;
  ns: string;
  millis: number;
  docsExamined?: number;
  keysExamined?: number;
  nreturned?: number;
  plan?: string;
  /** An in-memory sort. */
  sortStage?: boolean;
  app?: string;
  client?: string;
  user?: string;
  /** The query parts of the command (relaxed EJSON). */
  query: OpQuery;
  /** The query with its values replaced by ?, on one line: what groups the operations. */
  shape: string;
  summary: string;
  /** The whole profiler document or log attributes, relaxed EJSON. */
  raw: unknown;
}

export interface OpQuery {
  filter?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  /** Update operators or pipeline of an update / findAndModify. */
  update?: unknown;
}

export interface SlowOpGroup {
  key: string;
  kind: string;
  ns: string;
  shape: string;
  count: number;
  getMores: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
  docsExamined: number;
  keysExamined: number;
  nreturned: number;
  plans: string[];
  collscan: boolean;
  sortStage: boolean;
  last: string;
  apps: string[];
  /** The slowest operation of the group. */
  slowest: SlowOp;
  /** An index that could serve the filter and sort, when the plan suggests one is missing. */
  suggestion: Record<string, 1 | -1> | null;
}

/** Command fields that are not part of the query. */
const NOISE = new Set([
  'lsid',
  '$clusterTime',
  '$db',
  '$readPreference',
  'txnNumber',
  'autocommit',
  'startTransaction',
  'readConcern',
  'writeConcern',
  'apiVersion',
  'apiStrict',
  'apiDeprecationErrors',
  '$audit',
  '$client',
  'mayBypassWriteBlocking',
  'cursor',
  'batchSize',
  'comment',
  'maxTimeMS',
  'allowDiskUse',
  'ordered',
  'bypassDocumentValidation',
  'shardVersion',
  'databaseVersion',
]);

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (isEjsonWrapper(v)) return Number(Object.values(v)[0]);
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

const obj = (v: unknown): Record<string, unknown> | undefined => (isPlainObject(v) && !isEjsonWrapper(v) ? v : undefined);

/** Writes reported both per statement and as their command: the statements are kept. */
const BATCH_WRITES = new Set(['update', 'delete']);

/** The kind of a command and its query parts. */
export function readCommand(command: unknown, op?: string): { kind: string; query: OpQuery } {
  const c = obj(command) ?? {};
  // Statements of an update or delete (profiler op "update"/"remove", log type "update"/"remove").
  if (op === 'update') return { kind: 'update', query: { filter: obj(c.q), update: c.u } };
  if (op === 'remove') return { kind: 'delete', query: { filter: obj(c.q) } };
  const first = Object.keys(c).find((k) => !NOISE.has(k)) ?? '';
  switch (first) {
    case 'find':
      return { kind: 'find', query: { filter: obj(c.filter), sort: obj(c.sort), projection: obj(c.projection) } };
    case 'aggregate':
      return { kind: 'aggregate', query: { pipeline: Array.isArray(c.pipeline) ? c.pipeline.filter(isPlainObject) : [] } };
    case 'count':
      return { kind: 'count', query: { filter: obj(c.query) } };
    case 'distinct':
      return { kind: 'distinct', query: { filter: obj(c.query) } };
    case 'findAndModify':
    case 'findandmodify':
      return { kind: 'findAndModify', query: { filter: obj(c.query), sort: obj(c.sort), update: c.update } };
    case 'insert':
      return { kind: 'insert', query: {} };
    default:
      return { kind: first || op || 'command', query: {} };
  }
}

/** Values replaced by ?: field paths ("$field") and numbers of sort/projection specs stay, they are the shape. */
export function shapeOf(v: unknown, keepNumbers = false): string {
  if (v === null || v === undefined) return '?';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    // Lists of values ($in, …) have the same shape whatever their length.
    const parts = [...new Set(v.map((x) => shapeOf(x, keepNumbers)))];
    return parts.length === 1 && parts[0] === '?' ? '[?]' : `[${parts.join(', ')}]`;
  }
  if (isEjsonWrapper(v)) return '$regularExpression' in v ? '/?/' : '?';
  if (isPlainObject(v)) {
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    return `{ ${entries
      .map(([k, x]) => {
        const keep = keepNumbers || k === '$sort' || k === '$project' || k === 'sort' || k === 'projection';
        return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${shapeOf(x, keep)}`;
      })
      .join(', ')} }`;
  }
  if (typeof v === 'string') return v.startsWith('$') ? JSON.stringify(v) : '?';
  if (typeof v === 'number' && keepNumbers) return String(v);
  if (typeof v === 'boolean' && keepNumbers) return String(v);
  return '?';
}

function shapeOfQuery(kind: string, q: OpQuery): string {
  if (kind === 'aggregate') return shapeOf(q.pipeline ?? []);
  const parts: string[] = [];
  if (q.filter) parts.push(shapeOf(q.filter));
  if (q.sort) parts.push(`sort ${shapeOf(q.sort, true)}`);
  if (q.projection) parts.push(`project ${shapeOf(q.projection, true)}`);
  if (q.update !== undefined) parts.push(`update ${shapeOf(q.update)}`);
  return parts.join(' · ') || (kind === 'find' || kind === 'count' || kind === 'distinct' ? '{}' : '');
}

function summarize(command: unknown, max = 300): string {
  const c = obj(command);
  if (!c) return '';
  const text = toShell(Object.fromEntries(Object.entries(c).filter(([k]) => !NOISE.has(k))));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function users(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((u) => (isPlainObject(u) ? `${u.user}@${u.db}` : '')).filter(Boolean).join(', ') || undefined;
}

function dateOf(v: unknown): string {
  if (isEjsonWrapper(v) && '$date' in v) {
    const d = v.$date;
    return typeof d === 'string' ? d : new Date(num(d) ?? 0).toISOString();
  }
  return typeof v === 'string' ? v : new Date(0).toISOString();
}

function build(fields: Omit<SlowOp, 'kind' | 'query' | 'shape' | 'summary' | 'getMore'>, command: unknown, op: string | undefined, originating: unknown): SlowOp {
  const c = obj(command) ?? {};
  const getMore = 'getMore' in c;
  const { kind, query } = readCommand(getMore && originating ? originating : command, op);
  return {
    ...fields,
    kind,
    getMore: getMore || undefined,
    query,
    shape: shapeOfQuery(kind, query),
    summary: summarize(getMore && originating ? originating : command),
  };
}

/** A document of system.profile (relaxed EJSON). */
export function fromProfileDoc(doc: Record<string, unknown>): SlowOp {
  return build(
    {
      ts: dateOf(doc.ts),
      ns: String(doc.ns ?? ''),
      millis: num(doc.millis) ?? 0,
      docsExamined: num(doc.docsExamined),
      keysExamined: num(doc.keysExamined),
      nreturned: num(doc.nreturned),
      plan: typeof doc.planSummary === 'string' ? doc.planSummary : undefined,
      sortStage: doc.hasSortStage === true || undefined,
      app: typeof doc.appName === 'string' ? doc.appName : undefined,
      client: typeof doc.client === 'string' ? doc.client : undefined,
      user: users(doc.allUsers),
      raw: doc,
    },
    doc.command ?? doc.query,
    String(doc.op ?? ''),
    doc.originatingCommand,
  );
}

/**
 * A line of the server log (structured JSON, MongoDB 4.4+), or undefined when it is not a slow operation.
 * The commands of batched updates and deletes are left out: their statements have lines of their own.
 */
export function fromLogLine(line: string): SlowOp | undefined {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const attr = obj(entry.attr);
  if (entry.msg !== 'Slow query' || !attr) return undefined;
  const ns = String(attr.ns ?? '');
  const command = obj(attr.command) ?? {};
  if (ns.endsWith('.$cmd') && Object.keys(command).some((k) => BATCH_WRITES.has(k))) return undefined;
  const remote = typeof attr.remote === 'string' ? attr.remote : undefined;
  return build(
    {
      ts: dateOf(entry.t),
      ns,
      millis: num(attr.durationMillis) ?? 0,
      docsExamined: num(attr.docsExamined),
      keysExamined: num(attr.keysExamined),
      nreturned: num(attr.nreturned),
      plan: typeof attr.planSummary === 'string' ? attr.planSummary : undefined,
      sortStage: attr.hasSortStage === true || undefined,
      app: typeof attr.appName === 'string' ? attr.appName : undefined,
      client: remote,
      raw: attr,
    },
    command,
    attr.type === 'update' || attr.type === 'remove' ? String(attr.type) : undefined,
    attr.originatingCommand,
  );
}

/** Commands of monitoring tools (this monitor included) and drivers, not worth showing. */
const MONITORING = new Set(['profile', 'getLog', 'hello', 'isMaster', 'ismaster', 'ping', 'currentOp', 'serverStatus', 'dbStats', 'collStats', 'listDatabases', 'buildInfo', 'getParameter', 'endSessions', 'saslStart', 'saslContinue', 'killCursors']);

/** Operations of the profiler, the server's internals and monitoring, which are not worth showing. */
export function isNoise(op: SlowOp): boolean {
  return /\.system\.profile$/.test(op.ns) || /^(local|config)\./.test(op.ns) || MONITORING.has(op.kind);
}

/** Filter and sort that an index could serve (for an aggregate: a leading $match, and a $sort right after it). */
export function indexableQuery(kind: string, q: OpQuery): { filter?: unknown; sort?: unknown } {
  if (kind === 'aggregate') {
    const [first, second] = q.pipeline ?? [];
    if (first && '$match' in first) return { filter: first.$match, sort: second && '$sort' in second ? second.$sort : undefined };
    if (first && '$sort' in first) return { sort: first.$sort };
    return {};
  }
  return { filter: q.filter, sort: q.sort };
}

/** Totals per shape, slowest in total first. */
export function groupOps(ops: SlowOp[]): SlowOpGroup[] {
  const groups = new Map<string, SlowOpGroup>();
  for (const op of ops) {
    const key = `${op.ns}\u0000${op.kind}\u0000${op.shape}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        kind: op.kind,
        ns: op.ns,
        shape: op.shape,
        count: 0,
        getMores: 0,
        totalMs: 0,
        maxMs: -1,
        avgMs: 0,
        docsExamined: 0,
        keysExamined: 0,
        nreturned: 0,
        plans: [],
        collscan: false,
        sortStage: false,
        last: op.ts,
        apps: [],
        slowest: op,
        suggestion: null,
      };
      groups.set(key, g);
    }
    g.count++;
    if (op.getMore) g.getMores++;
    g.totalMs += op.millis;
    g.maxMs = Math.max(g.maxMs, op.millis);
    // The example of the group: the slowest first batch (a getMore's command is the cursor's, not the query).
    if (!!op.getMore !== !!g.slowest.getMore ? !op.getMore : op.millis > g.slowest.millis) g.slowest = op;
    g.docsExamined += op.docsExamined ?? 0;
    g.keysExamined += op.keysExamined ?? 0;
    g.nreturned += op.nreturned ?? 0;
    if (op.plan && !g.plans.includes(op.plan)) g.plans.push(op.plan);
    g.collscan ||= !!op.plan?.includes('COLLSCAN');
    g.sortStage ||= !!op.sortStage;
    if (op.ts > g.last) g.last = op.ts;
    if (op.app && !g.apps.includes(op.app)) g.apps.push(op.app);
  }
  for (const g of groups.values()) {
    g.avgMs = g.totalMs / g.count;
    const scanned = g.docsExamined / Math.max(g.nreturned, 1);
    if (g.collscan || g.sortStage || scanned >= 10) {
      const { filter, sort } = indexableQuery(g.kind, g.slowest.query);
      g.suggestion = suggestIndex(filter, sort);
    }
  }
  return [...groups.values()].sort((a, b) => b.totalMs - a.totalMs || b.count - a.count);
}

/** "db.collection" → database and collection (collection names may contain dots). */
export function splitNs(ns: string): { database: string; collection: string } {
  const i = ns.indexOf('.');
  return i < 0 ? { database: ns, collection: '' } : { database: ns.slice(0, i), collection: ns.slice(i + 1) };
}

/** Operations the collection tab can show: a filter (with sort and projection) or a pipeline. */
export function canOpen(kind: string): boolean {
  return ['find', 'aggregate', 'count', 'distinct', 'findAndModify', 'update', 'delete'].includes(kind);
}
