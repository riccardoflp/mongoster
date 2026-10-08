// Message protocol between the collection webview and the extension host.

export interface QueryRequest {
  type: 'query';
  requestId: number;
  filter: string;
  sort: string;
  projection: string;
  skip: number;
  limit: number;
}

export type WebviewMessage =
  | { type: 'ready' }
  | QueryRequest
  | { type: 'openDocument'; doc: unknown }
  | { type: 'copy'; text: string };

export type HostMessage =
  | { type: 'init'; connectionName: string; database: string; collection: string }
  | { type: 'result'; requestId: number; docs: unknown[]; count: number | null; durationMs: number }
  | { type: 'error'; requestId: number; message: string };
