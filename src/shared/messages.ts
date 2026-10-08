// Message protocol between the collection webview and the extension host.
// Documents and _id values travel as relaxed EJSON plain values.
import type { SchemaSummary } from './schema';
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
  | BulkRequest
  | { type: 'export'; source: QuerySource; expanded: string[]; page: { skip: number; limit: number }; count: number | null };

export type HostMessage =
  | { type: 'init'; connectionName: string; database: string; collection: string; readOnly: boolean; expanded: string[] }
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
  | { type: 'schema'; requestId: number; schema?: SchemaSummary; total?: number; durationMs?: number; error?: string }
  /** `ok: false` without a message: the confirmation was cancelled. */
  | { type: 'bulkResult'; requestId: number; ok: boolean; message?: string };
