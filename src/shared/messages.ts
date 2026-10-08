// Message protocol between the collection webview and the extension host.
// Documents and _id values travel as relaxed EJSON plain values.
import type { SchemaSummary } from './schema';
import type { ChartSpec } from './chart';
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
  | { type: 'bulkResult'; requestId: number; ok: boolean; message?: string };

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

export interface ProfileEntry {
  /** ISO date. */
  ts: string;
  op: string;
  ns: string;
  millis: number;
  docsExamined?: number;
  keysExamined?: number;
  nreturned?: number;
  plan?: string;
  user?: string;
  summary: string;
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

export type MonitorHostMessage =
  | { type: 'init'; connectionName: string; readOnly: boolean; color?: string; databases: string[] }
  | { type: 'ops'; requestId: number; ops?: MonitorOp[]; error?: string; at: number }
  | { type: 'killResult'; opid: number | string; ok: boolean; message?: string }
  | { type: 'profile'; requestId: number; database: string; level?: number; slowms?: number; entries?: ProfileEntry[]; error?: string }
  | { type: 'server'; requestId: number; stats?: ServerStats; error?: string }
  | { type: 'databases'; requestId: number; databases?: DatabaseStats[]; error?: string }
  | { type: 'collections'; requestId: number; database: string; collections?: CollectionStats[]; error?: string };

export type MonitorViewMessage =
  | { type: 'ready' }
  | { type: 'loadOps'; requestId: number; includeIdle: boolean }
  | { type: 'killOp'; opid: number | string; summary: string }
  | { type: 'loadProfile'; requestId: number; database: string }
  | { type: 'setProfile'; requestId: number; database: string; level: 0 | 1 | 2; slowms: number }
  | { type: 'loadServer'; requestId: number }
  | { type: 'loadDatabases'; requestId: number }
  | { type: 'loadCollections'; requestId: number; database: string }
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
