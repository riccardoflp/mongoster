// Message protocol between the collection webview and the extension host.
// Documents and _id values travel as relaxed EJSON plain values.
import type { SchemaSummary } from './schema';
import type { ChartSpec } from './chart';
import type { OpQuery, SlowOp, SlowOpSource } from './profile';
import type { CompareCounts, CompareOptions, DiffKind, FieldDiff } from './compare';
import type { FieldHint } from './complete';
import type { ColumnLayout } from './columns';
import type { PipelineStage } from './pipeline';
import type { ExplainSummary } from './explain';

export interface QueryRequest {
  type: 'query';
  requestId: number;
  filter: string;
  sort: string;
  projection: string;
  skip: number;
  limit: number;
}

/** Inline edit of one value: `path` may contain array indexes ("items", "2", "sku"). */
export interface UpdateFieldRequest {
  type: 'updateField';
  requestId: number;
  id: unknown;
  path: string[];
  /** The value the user saw (relaxed EJSON); absent when the field was missing. */
  original?: unknown;
  missing: boolean;
  /** New value in mongosh syntax. */
  value: string;
}

export interface AggregateRequest {
  type: 'aggregate';
  requestId: number;
  stages: PipelineStage[];
  /** Run the pipeline up to this stage index (inclusive). */
  upto: number;
  skip: number;
  limit: number;
}

/** A find query or a pipeline (run up to stage `upto`), as the webview describes it. */
export type QuerySource =
  | { kind: 'find'; filter: string; sort: string; projection: string }
  | { kind: 'aggregate'; stages: PipelineStage[]; upto: number };

export interface IndexInfo {
  name: string;
  /** Key pattern, relaxed EJSON. */
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  hidden?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
  collation?: string;
  /** Bytes on disk, when the server reports it. */
  size?: number;
  /** Uses since `since` (server restart or index creation), from $indexStats. */
  ops?: number;
  since?: string;
  building?: boolean;
}

/** A find query, or an aggregation when `pipeline` is set (filter/sort/projection are then empty). */
export interface QueryText {
  filter: string;
  sort: string;
  projection: string;
  pipeline?: PipelineStage[];
}

export interface SavedQuery extends QueryText {
  id: string;
  /** Set for saved (favorite) queries. */
  name?: string;
  /** Last run / save time, epoch ms. */
  at: number;
}

/** "Update many" / "Delete many" on the documents matching `filter`. */
export interface BulkRequest {
  type: 'bulkApply';
  requestId: number;
  op: 'update' | 'delete';
  filter: string;
  /** Update operators or pipeline (mongosh syntax), for `op: 'update'`. */
  update?: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | QueryRequest
  | AggregateRequest
  | { type: 'editDocument'; id: unknown }
  | { type: 'duplicateDocument'; doc: Record<string, unknown> }
  | { type: 'deleteDocument'; id: unknown }
  | { type: 'insertDocument' }
  | { type: 'saveExpanded'; expanded: string[] }
  | { type: 'saveLayout'; layout: ColumnLayout }
  | { type: 'saveQuery'; query: QueryText }
  | { type: 'removeQuery'; id: string }
  | { type: 'clearHistory' }
  | { type: 'copy'; text: string }
  | UpdateFieldRequest
  | { type: 'explain'; requestId: number; source: QuerySource }
  | { type: 'loadIndexes' }
  | { type: 'createIndex'; requestId: number; keys: string; options: string }
  | { type: 'dropIndex'; name: string }
  | { type: 'hideIndex'; name: string; hidden: boolean }
  | { type: 'bulkCount'; requestId: number; filter: string }
  | { type: 'analyzeSchema'; requestId: number; filter: string; size: number }
  /** Field names and frequent values for autocompletion. */
  | { type: 'loadFields' }
  | { type: 'saveView'; stages: PipelineStage[]; upto: number }
  | { type: 'editValidation' }
  /** Opens the change stream tab of the collection. */
  | { type: 'watch' }
  /** Opens generated code in an untitled editor. */
  | { type: 'openCode'; language: string; text: string }
  /** Runs the chart stages after the filter or the pipeline. */
  | { type: 'chart'; requestId: number; source: QuerySource; spec: ChartSpec }
  /** Saves the chart image (a PNG data URL). */
  | { type: 'savePng'; dataUrl: string; name: string }
  | BulkRequest
  | { type: 'export'; source: QuerySource; expanded: string[]; layout: ColumnLayout; page: { skip: number; limit: number }; count: number | null };

export type HostMessage =
  | {
      type: 'init';
      connectionName: string;
      database: string;
      collection: string;
      /** No document changes: a view, or a read-only connection (`locked`). */
      readOnly: boolean;
      view: boolean;
      locked: boolean;
      color?: string;
      expanded: string[];
      layout: ColumnLayout;
    }
  | { type: 'result'; requestId: number; docs: unknown[]; count: number | null; durationMs: number; note?: string }
  | { type: 'error'; requestId: number; message: string; stage?: number }
  | { type: 'refresh' }
  | { type: 'history'; recent: SavedQuery[]; saved: SavedQuery[] }
  | { type: 'fieldResult'; requestId: number; ok: boolean; message?: string }
  | {
      type: 'explainResult';
      requestId: number;
      summary?: ExplainSummary;
      /** Full explain output, relaxed EJSON. */
      raw?: unknown;
      /** ESR index for the query's filter and sort, when the plan could use one. */
      suggestion?: Record<string, 1 | -1> | null;
      error?: string;
    }
  | { type: 'indexes'; indexes: IndexInfo[]; error?: string }
  | { type: 'indexResult'; requestId: number; ok: boolean; message?: string }
  | { type: 'bulkCount'; requestId: number; count?: number; error?: string }
  | { type: 'fields'; fields: FieldHint[] }
  | { type: 'schema'; requestId: number; schema?: SchemaSummary; total?: number; durationMs?: number; error?: string }
  /** Output of the chart stages, relaxed EJSON. */
  | { type: 'chartData'; requestId: number; rows?: unknown[]; durationMs?: number; error?: string }
  /** `ok: false` without a message: the confirmation was cancelled. */
  | { type: 'bulkResult'; requestId: number; ok: boolean; message?: string }
  /** A query to show (from the server monitor), then run or explain. */
  | { type: 'loadQuery'; query: QueryText; explain: boolean };

// ---------------------------------------------------------------------------
// Playground result tab

export type PlaygroundHostMessage =
  | { type: 'running'; title: string; target: string }
  | {
      type: 'result';
      title: string;
      /** "connection › database" */
      target: string;
      durationMs: number;
      kind: 'documents' | 'value' | 'none';
      /** Relaxed EJSON. */
      value?: unknown;
      /** A cursor had more documents than `limit`. */
      more?: boolean;
      limit: number;
      /** Lines written by print(), printjson() and console.log(). */
      output: string[];
      error?: { message: string; line?: number };
    };

export type PlaygroundViewMessage =
  | { type: 'ready' }
  | { type: 'copy'; text: string }
  | { type: 'openJson'; text: string }
  | { type: 'goToLine'; line: number };

// ---------------------------------------------------------------------------
// Server monitor

export interface MonitorOp {
  /** Number, or "shard:number" on a mongos. */
  opid: number | string;
  type: string;
  ns: string;
  /** Running time in microseconds. */
  micros?: number;
  active: boolean;
  client?: string;
  appName?: string;
  desc?: string;
  user?: string;
  plan?: string;
  waitingForLock?: boolean;
  /** Internal operation of the server (no client connection). */
  system: boolean;
  /** The command on one line. */
  summary: string;
  /** The whole currentOp entry, relaxed EJSON. */
  raw: unknown;
}

export interface ServerStats {
  host: string;
  version: string;
  /** Seconds. */
  uptime: number;
  connections: { current: number; available: number; totalCreated: number };
  opcounters: Record<'insert' | 'query' | 'update' | 'delete' | 'getmore' | 'command', number>;
  /** MB. */
  memory?: { resident: number; virtual: number };
  network?: { bytesIn: number; bytesOut: number; numRequests: number };
  /** When it was read, ms since epoch. */
  at: number;
}

export interface DatabaseStats {
  name: string;
  collections?: number;
  views?: number;
  objects?: number;
  dataSize?: number;
  storageSize?: number;
  indexes?: number;
  indexSize?: number;
  error?: string;
}

export interface CollectionStats {
  name: string;
  type: string;
  count?: number;
  size?: number;
  avgObjSize?: number;
  storageSize?: number;
  nindexes?: number;
  totalIndexSize?: number;
  capped?: boolean;
  error?: string;
}

export interface ReplMember {
  id: number;
  /** host:port */
  name: string;
  /** PRIMARY, SECONDARY, ARBITER, RECOVERING, (not reachable/healthy)… */
  state: string;
  health: number;
  /** The server Mongoster is connected to. */
  self: boolean;
  /** Seconds. */
  uptime?: number;
  /** ISO time of the last operation applied. */
  optime?: string;
  /** Seconds behind the primary (or the most recent member when there's no primary). */
  lag?: number;
  /** ISO time. */
  lastHeartbeat?: string;
  pingMs?: number;
  syncSource?: string;
  /** infoMessage or lastHeartbeatMessage. */
  message?: string;
  priority?: number;
  votes?: number;
  hidden?: boolean;
  arbiter?: boolean;
  /** secondaryDelaySecs (slaveDelay before 5.0). */
  delay?: number;
  tags?: Record<string, string>;
  buildIndexes?: boolean;
  /** The member's entries of replSetGetStatus and replSetGetConfig, relaxed EJSON. */
  raw: unknown;
}

export interface OplogStats {
  /** Bytes. */
  size?: number;
  maxSize?: number;
  count?: number;
  /** ISO times of the oldest and newest entries. */
  first?: string;
  last?: string;
  /** Seconds between them: how far behind a member can fall and still catch up. */
  window?: number;
}

export interface ReplStatus {
  kind: 'replicaSet' | 'standalone' | 'mongos';
  setName?: string;
  /** The connected server, host:port. */
  me?: string;
  primary?: string;
  term?: number;
  members?: ReplMember[];
  settings?: { electionTimeoutMillis?: number; heartbeatIntervalMillis?: number; chainingAllowed?: boolean; protocolVersion?: number };
  /** replSetGetStatus / replSetGetConfig failed (e.g. missing the clusterMonitor role). */
  statusError?: string;
  oplog?: OplogStats;
  oplogError?: string;
  at: number;
}

export interface OplogEntry {
  /** Timestamp as "seconds:increment", unique. */
  key: string;
  /** ISO time (wall clock, or the timestamp's seconds). */
  time: string;
  /** insert, update, delete, command, noop, transaction */
  op: string;
  ns: string;
  /** The document's _id on one line. */
  id?: string;
  summary: string;
  raw: unknown;
}

/** Oplog operation filter: '' every operation except no-ops; '*' everything. */
export type OplogOp = '' | '*' | 'i' | 'u' | 'd' | 'c' | 'n';

export type MonitorHostMessage =
  | { type: 'init'; connectionName: string; readOnly: boolean; color?: string; databases: string[] }
  | { type: 'ops'; requestId: number; ops?: MonitorOp[]; error?: string; at: number }
  | { type: 'killResult'; opid: number | string; ok: boolean; message?: string }
  | {
      type: 'profile';
      requestId: number;
      source: SlowOpSource;
      /** The database (profiler), or the one the log is narrowed to ('' for all). */
      database: string;
      level?: number;
      slowms?: number;
      entries?: SlowOp[];
      /** More operations matched than were read. */
      limited?: boolean;
      error?: string;
    }
  | { type: 'profileAction'; ok: boolean; message?: string }
  | { type: 'server'; requestId: number; stats?: ServerStats; error?: string }
  | { type: 'databases'; requestId: number; databases?: DatabaseStats[]; error?: string }
  | { type: 'collections'; requestId: number; database: string; collections?: CollectionStats[]; error?: string }
  | { type: 'replication'; requestId: number; status?: ReplStatus; error?: string }
  | { type: 'oplog'; requestId: number; entries?: OplogEntry[]; limited?: boolean; error?: string }
  | { type: 'replAction'; ok: boolean; message?: string };

export type MonitorViewMessage =
  | { type: 'ready' }
  | { type: 'loadOps'; requestId: number; includeIdle: boolean }
  | { type: 'killOp'; opid: number | string; summary: string }
  /** `sinceMinutes` 0: everything recorded. */
  | { type: 'loadProfile'; requestId: number; source: SlowOpSource; database: string; sinceMinutes: number }
  /** Level -1 changes only the threshold of slow operations (server-wide, also for the log). */
  | { type: 'setProfile'; database: string; level: -1 | 0 | 1 | 2; slowms: number }
  /** Empties system.profile of the database. */
  | { type: 'clearProfile'; database: string }
  /** Opens the operation's query in the collection's tab, optionally explaining it. */
  | { type: 'openQuery'; ns: string; kind: string; query: OpQuery; explain: boolean }
  | { type: 'createIndex'; ns: string; keys: Record<string, 1 | -1> }
  | { type: 'loadServer'; requestId: number }
  | { type: 'loadDatabases'; requestId: number }
  | { type: 'loadCollections'; requestId: number; database: string }
  | { type: 'loadReplication'; requestId: number }
  /** `ns`: a database or a collection ('' for all). */
  | { type: 'loadOplog'; requestId: number; ns: string; op: OplogOp; limit: number }
  | { type: 'stepDown' }
  | { type: 'copy'; text: string };

// ---- change streams

/** One change event, ready to display. */
export interface WatchEvent {
  seq: number;
  /** ISO time of the change (wallTime, or the cluster time). */
  time: string;
  /** insert, update, replace, delete, drop, rename, dropDatabase, invalidate, … */
  op: string;
  /** "db.collection", or "db" for database events. */
  ns: string;
  /** The document's _id: relaxed EJSON, and on one line. */
  id?: unknown;
  key?: string;
  summary: string;
  /** updateDescription of an update. */
  updated?: Record<string, unknown>;
  removed?: string[];
  truncated?: { field: string; newSize: number }[];
  /** Pre-image (when the collection records them). */
  before?: unknown;
  /** The inserted or replacing document, or the current one after an update. */
  after?: unknown;
  raw: unknown;
}

export interface WatchOptions {
  /** $match on the change events, mongosh syntax. */
  match: string;
  /** Look up the current document on updates. */
  fullDocument: boolean;
}

export type WatchState = 'starting' | 'watching' | 'stopped' | 'error';

export type WatchHostMessage =
  | {
      type: 'init';
      connectionName: string;
      color?: string;
      readOnly: boolean;
      database?: string;
      collection?: string;
      /** Whether the collection records pre-images (collection scope only). */
      preImages?: boolean;
    }
  | { type: 'status'; state: WatchState; message?: string }
  | { type: 'events'; events: WatchEvent[] };

export type WatchViewMessage =
  | { type: 'ready' }
  | { type: 'start'; options: WatchOptions }
  | { type: 'stop' }
  | { type: 'enablePreImages' }
  | { type: 'openDocument'; database: string; collection: string; id: unknown }
  | { type: 'copy'; text: string };

// ---- connection options form (TLS, SSH)

export interface ConnectionForm {
  name: string;
  uri: string;
  tls: {
    enabled: boolean;
    caFile: string;
    certificateKeyFile: string;
    /** Empty: keep the saved one (if any). */
    certificateKeyFilePassword: string;
    allowInvalidCertificates: boolean;
    allowInvalidHostnames: boolean;
  };
  ssh: {
    enabled: boolean;
    host: string;
    port: string;
    username: string;
    auth: 'password' | 'privateKey' | 'agent';
    /** Empty: keep the saved one (if any). */
    password: string;
    privateKeyFile: string;
    passphrase: string;
  };
}

export type ConnectionFileField = 'caFile' | 'certificateKeyFile' | 'privateKeyFile';

/** Which secrets are saved: they are never sent to the form. */
export interface SavedSecrets {
  certificateKeyFilePassword: boolean;
  sshPassword: boolean;
  passphrase: boolean;
}

export type ConnectionEditorHostMessage =
  | { type: 'init'; isNew: boolean; form: ConnectionForm; saved: SavedSecrets }
  | { type: 'file'; field: ConnectionFileField; path: string }
  | { type: 'busy'; what: 'test' | 'save' }
  | { type: 'result'; ok: boolean; message: string; field?: string };

export type ConnectionEditorViewMessage =
  | { type: 'ready' }
  | { type: 'browse'; field: ConnectionFileField }
  | { type: 'test'; form: ConnectionForm }
  | { type: 'save'; form: ConnectionForm }
  | { type: 'cancel' };

// ---------------------------------------------------------------------------
// Comparing two collections

export interface CompareSide {
  connectionName: string;
  database: string;
  collection: string;
  /** No writes: a view, or a read-only connection. */
  readOnly: boolean;
  why?: string;
  color?: string;
}

export interface CompareEntry {
  kind: DiffKind;
  /** The canonical EJSON of the _id, which identifies the document in messages. */
  key: string;
  /** The _id, relaxed EJSON. */
  id: unknown;
  /** Changed fields (different documents). */
  fields?: FieldDiff[];
  /** The document on one line (documents on one side only). */
  preview?: string;
}

export type CompareHostMessage =
  | { type: 'init'; left: CompareSide; right: CompareSide; options?: CompareOptions }
  | { type: 'progress'; phase: 'left' | 'right' | 'details'; left: number; right: number }
  | {
      type: 'result';
      counts: CompareCounts;
      /** The first differences of each kind, with their details. */
      entries: CompareEntry[];
      durationMs: number;
    }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
  | { type: 'document'; key: string; side: 'left' | 'right'; doc?: unknown; error?: string }
  /** A write finished (or was refused or cancelled: `ok` false). */
  | { type: 'applied'; ok: boolean; message?: string };

export type CompareViewMessage =
  | { type: 'ready' }
  | { type: 'compare'; options: CompareOptions }
  | { type: 'cancel' }
  /** Makes side `to` like the other for these documents (null: every difference found). */
  | { type: 'apply'; to: 'left' | 'right'; keys: string[] | null }
  | { type: 'loadDocument'; key: string; side: 'left' | 'right' }
  | { type: 'openDocument'; key: string; side: 'left' | 'right' }
  | { type: 'swap' }
  | { type: 'copy'; text: string };
