// Message protocol between the collection webview and the extension host.
// Documents and _id values travel as relaxed EJSON plain values.

export interface QueryRequest {
  type: 'query';
  requestId: number;
  filter: string;
  sort: string;
  projection: string;
  skip: number;
  limit: number;
}

export interface QueryText {
  filter: string;
  sort: string;
  projection: string;
}

export interface SavedQuery extends QueryText {
  id: string;
  /** Set for saved (favorite) queries. */
  name?: string;
  /** Last run / save time, epoch ms. */
  at: number;
}

export type WebviewMessage =
  | { type: 'ready' }
  | QueryRequest
  | { type: 'editDocument'; id: unknown }
  | { type: 'duplicateDocument'; doc: Record<string, unknown> }
  | { type: 'deleteDocument'; id: unknown }
  | { type: 'insertDocument' }
  | { type: 'saveExpanded'; expanded: string[] }
  | { type: 'saveQuery'; query: QueryText }
  | { type: 'removeQuery'; id: string }
  | { type: 'clearHistory' }
  | { type: 'copy'; text: string };

export type HostMessage =
  | { type: 'init'; connectionName: string; database: string; collection: string; readOnly: boolean; expanded: string[] }
  | { type: 'result'; requestId: number; docs: unknown[]; count: number | null; durationMs: number }
  | { type: 'error'; requestId: number; message: string }
  | { type: 'refresh' }
  | { type: 'history'; recent: SavedQuery[]; saved: SavedQuery[] };
