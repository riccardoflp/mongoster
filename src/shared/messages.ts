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

// ---- users and roles

export interface RoleRef {
  role: string;
  db: string;
}

export interface UserEntry {
  user: string;
  db: string;
  roles: RoleRef[];
  mechanisms: string[];
  customData?: unknown;
  /** The usersInfo entry, relaxed EJSON. */
  raw: unknown;
}

export interface Privilege {
  /** "shop.users", "shop.*" (any collection of shop), "*.users", "*.*", "cluster" or "any resource". */
  resource: string;
  actions: string[];
}

export interface RoleEntry {
  role: string;
  db: string;
  builtin: boolean;
  privileges: Privilege[];
  /** Roles it inherits. */
  roles: RoleRef[];
  /** The rolesInfo entry, relaxed EJSON. */
  raw: unknown;
}

export type UsersHostMessage =
  | {
      type: 'init';
      connectionName: string;
      readOnly: boolean;
      color?: string;
      /** The database to show first ('' for all). */
      database: string;
      /** Who the connection is signed in as. */
      me?: { users: { user: string; db: string }[]; roles: RoleRef[] };
      meError?: string;
    }
  | { type: 'data'; requestId: number; database: string; users?: UserEntry[]; roles?: RoleEntry[]; usersError?: string; rolesError?: string; databases: string[] }
  | { type: 'action'; ok: boolean; message?: string };

export type UsersViewMessage =
  | { type: 'ready' }
  /** `database` '' for all. */
  | { type: 'load'; requestId: number; database: string; builtin: boolean }
  | { type: 'createUser'; database: string; user: string; password: string; roles: RoleRef[]; customData: string }
  | { type: 'setPassword'; database: string; user: string; password: string }
  | { type: 'grantRoles'; database: string; user: string; roles: RoleRef[] }
  | { type: 'revokeRole'; database: string; user: string; role: RoleRef }
  | { type: 'dropUser'; database: string; user: string }
  /** `privileges`: an array in mongosh syntax. */
  | { type: 'saveRole'; create: boolean; database: string; role: string; privileges: string; roles: RoleRef[] }
  | { type: 'dropRole'; database: string; role: string }
  | { type: 'copy'; text: string };

// ---- GridFS

export interface GridFile {
  /** The _id as canonical EJSON text: identifies the file in messages. */
  key: string;
  /** The _id on one line. */
  id: string;
  filename: string;
  /** Bytes. */
  length: number;
  chunkSize: number;
  /** ISO time. */
  uploadDate?: string;
  contentType?: string;
  metadata?: unknown;
  /** The files document, relaxed EJSON. */
  raw: unknown;
}

export interface GridSort {
  field: 'filename' | 'length' | 'uploadDate';
  desc: boolean;
}

export type GridFSHostMessage =
  | { type: 'init'; connectionName: string; readOnly: boolean; color?: string; database: string; bucket: string }
  | { type: 'files'; requestId: number; files?: GridFile[]; total?: number; totalSize?: number; error?: string }
  | { type: 'preview'; key: string; kind?: 'image' | 'text' | 'binary'; dataUrl?: string; text?: string; truncated?: boolean; error?: string }
  | { type: 'action'; ok: boolean; message?: string };

export type GridFSViewMessage =
  | { type: 'ready' }
  /** `search`: part of the file name, or a mongosh filter on the files collection ({ … }). */
  | { type: 'load'; requestId: number; search: string; sort: GridSort; skip: number; limit: number }
  | { type: 'upload' }
  | { type: 'download'; key: string }
  | { type: 'open'; key: string }
  | { type: 'preview'; key: string }
  | { type: 'rename'; key: string }
  | { type: 'delete'; key: string }
  | { type: 'editMetadata'; key: string }
  | { type: 'copy'; text: string };

// ---------------------------------------------------------------- undo history

/** One recorded write: what it changed, kept to put the documents back as they were. */
export interface HistoryEntry {
  id: string;
  /** Epoch ms. */
  time: number;
  connectionId: string;
  connectionName: string;
  database: string;
  collection: string;
  /** What was done, e.g. "Delete many { status: 'old' }". */
  label: string;
  inserted: number;
  updated: number;
  deleted: number;
  /** Bytes of the compressed file on disk (0 once undone). */
  size: number;
  /** Epoch ms of the undo. */
  undone?: number;
  /** The entry this one undid. */
  undoOf?: string;
}

export interface HistoryUsage {
  bytes: number;
  maxBytes: number;
  maxDays: number;
  maxEntries: number;
  maxDocuments: number;
}

/** What undoing an entry does to one document: its value now vs after the undo. */
export interface HistoryDocument {
  /** _id on one line. */
  id: string;
  /** What the recorded write did to the document. */
  kind: 'inserted' | 'updated' | 'deleted';
  /** The document changed after the write: undoing it overwrites those changes. */
  changed: boolean;
  /** Field differences, left: now, right: after the undo. Empty when the undo changes nothing. */
  fields: FieldDiff[];
}

export type HistoryHostMessage =
  | { type: 'init'; entries: HistoryEntry[]; usage: HistoryUsage; enabled: boolean }
  | { type: 'details'; id: string; documents?: HistoryDocument[]; total?: number; error?: string }
  | { type: 'message'; text: string; failed?: boolean };

export type HistoryViewMessage =
  | { type: 'ready' }
  | { type: 'details'; id: string }
  | { type: 'undo'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'settings' };

// ---- global search

export interface SearchOptions {
  text: string;
  /** text: contains the text (an id, number or date too); regex: a regular expression. */
  mode: 'text' | 'regex';
  matchCase: boolean;
  /** Also match field names. */
  fieldNames: boolean;
  /** Also search the views (their documents usually repeat those of a collection). */
  views: boolean;
  /** Documents read per collection; 0 for all. */
  limit: number;
}

/** Where the text was found in a document. */
export interface SearchHit {
  /** Dotted path, with array indexes: "address.city", "tags.1". */
  path: string;
  /** value, or the field name itself. */
  on: 'value' | 'key';
  /** BSON type of the value: string, objectId, date, number, … */
  kind: string;
  /** The text around the match, and the match within it. */
  before: string;
  match: string;
  after: string;
}

export interface SearchResult {
  /** The document's _id: relaxed EJSON, and on one line. */
  id: unknown;
  key: string;
  hits: SearchHit[];
  /** Matches beyond the hits listed. */
  more: number;
}

export interface SearchCollection {
  database: string;
  collection: string;
  view: boolean;
  /** estimatedDocumentCount (not for views). */
  estimate?: number;
}

export interface SearchProgress {
  /** Index in the plan. */
  index: number;
  state: 'scanning' | 'done' | 'error';
  scanned: number;
  matches: number;
  /** New results since the previous update. */
  results: SearchResult[];
  /** The scan stopped at the documents limit. */
  partial?: boolean;
  error?: string;
}

export type SearchHostMessage =
  | { type: 'init'; connectionName: string; color?: string; database?: string; collection?: string }
  | { type: 'plan'; searchId: number; collections: SearchCollection[] }
  | { type: 'progress'; searchId: number; updates: SearchProgress[] }
  | { type: 'done'; searchId: number; ms: number; stopped: boolean }
  | { type: 'failed'; searchId: number; message: string };

export type SearchViewMessage =
  | { type: 'ready' }
  | { type: 'search'; searchId: number; options: SearchOptions }
  | { type: 'stop' }
  | { type: 'openDocument'; database: string; collection: string; view: boolean; id: unknown }
  /** Opens the collection's tab filtered on the matching documents. */
  | { type: 'showInCollection'; index: number }
  | { type: 'copy'; text: string };

// ---- index advisor

/** Where the slow operations came from. */
export interface AdvisorSources {
  /** Per database: the profiler level (0 off, 1 slow operations, 2 all) and the operations read from system.profile. */
  profiler: { database: string; level?: number; ops: number; error?: string }[];
  /** The server log ("Slow query" lines), for the databases without profiler data. */
  log: { ops: number; error?: string };
  /** Operations slower than this are slow (profiler level 1 and log). */
  slowms?: number;
  /** The oldest operation read. */
  since?: string;
}

export interface AdvisorReport {
  advice: import('./advisor').Advice[];
  collections: number;
  indexes: number;
  indexBytes: number;
  /** Indexes not used yet, but observed for less than a day. */
  tooRecent: number;
  sources: AdvisorSources;
  /** Collections whose indexes couldn't be read. */
  failed: { ns: string; error: string }[];
}

export type AdvisorHostMessage =
  | { type: 'init'; connectionName: string; color?: string; readOnly: boolean; database?: string; collection?: string }
  | { type: 'report'; requestId: number; report?: AdvisorReport; error?: string }
  | { type: 'actionResult'; ok: boolean; message?: string };

export type AdvisorViewMessage =
  | { type: 'ready' }
  | { type: 'analyze'; requestId: number }
  /** Creates the index of a 'create' advice. */
  | { type: 'create'; id: string }
  | { type: 'hide'; database: string; collection: string; name: string; hidden: boolean }
  | { type: 'drop'; database: string; collection: string; name: string; why: string }
  /** Opens a query of a 'create' advice in the collection's tab. */
  | { type: 'openQuery'; id: string; query: number; explain: boolean }
  | { type: 'enableProfiler'; database: string }
  | { type: 'copy'; text: string };
