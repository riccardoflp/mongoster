import * as vscode from 'vscode';
import { BSON, Collection, Document } from 'mongodb';
import { ConnectionManager } from './connections';
import { byId, CollectionRef, DocumentFileSystem } from './documentFs';
import { errorMessage } from './tree';
import { QueryHistory, sameQuery } from './queryHistory';
import { isPlainObject, parseQuery, relaxEjson, toShell } from './shared/query';
import { isWriteStage, parseStageBody } from './shared/pipeline';
import type { AggregateRequest, HostMessage, QueryRequest, WebviewMessage } from './shared/messages';

const { EJSON } = BSON;

export interface CollectionTarget extends CollectionRef {
  connectionName: string;
  /** Views can be queried but not modified. */
  readOnly: boolean;
}

const panelKey = (ref: CollectionRef) => `${ref.connectionId}/${ref.database}/${ref.collection}`;
const expandedStateKey = (ref: CollectionRef) => `mongoster.expanded.${panelKey(ref)}`;

/** One webview tab per collection, showing a queryable grid of documents. */
export class CollectionPanel {
  private static readonly panels = new Map<string, CollectionPanel>();

  static show(
    context: vscode.ExtensionContext,
    connections: ConnectionManager,
    documents: DocumentFileSystem,
    target: CollectionTarget,
  ): void {
    const key = panelKey(target);
    const existing = CollectionPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    CollectionPanel.panels.set(key, new CollectionPanel(context, connections, documents, target, () => {
      CollectionPanel.panels.delete(key);
    }));
  }

  /** Re-runs the current query of the collection's panel, if open (e.g. after a document was saved). */
  static refresh(ref: CollectionRef): void {
    CollectionPanel.panels.get(panelKey(ref))?.post({ type: 'refresh' });
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly history: QueryHistory;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly documents: DocumentFileSystem,
    private readonly target: CollectionTarget,
    onDispose: () => void,
  ) {
    this.history = new QueryHistory(context.globalState, panelKey(target));
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')];
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.collection',
      target.collection,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'collection.svg');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m));
    this.panel.onDidDispose(onDispose);
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.post({
          type: 'init',
          connectionName: this.target.connectionName,
          database: this.target.database,
          collection: this.target.collection,
          readOnly: this.target.readOnly,
          expanded: this.context.globalState.get<string[]>(expandedStateKey(this.target), []),
        });
        this.postHistory();
        break;
      case 'saveQuery': {
        const name = await vscode.window.showInputBox({
          title: 'Save Query',
          prompt: `Name for this ${this.target.collection} query`,
          value: this.history.saved.find((s) => sameQuery(s, m.query))?.name,
          validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
        });
        if (!name) return;
        await this.history.save(name.trim(), m.query);
        this.postHistory();
        break;
      }
      case 'removeQuery':
        await this.history.remove(m.id);
        this.postHistory();
        break;
      case 'clearHistory':
        if (
          (await vscode.window.showWarningMessage(
            `Clear the recent queries of ${this.target.collection}?`,
            { modal: true, detail: 'Saved queries are kept.' },
            'Clear',
          )) !== 'Clear'
        ) {
          return;
        }
        await this.history.clearRecent();
        this.postHistory();
        break;
      case 'saveExpanded':
        await this.context.globalState.update(expandedStateKey(this.target), m.expanded.length ? m.expanded : undefined);
        break;
      case 'query':
        await this.runQuery(m);
        break;
      case 'aggregate':
        await this.runAggregate(m);
        break;
      case 'editDocument':
        await this.documents.open(this.target, fromRelaxed(m.id));
        break;
      case 'duplicateDocument': {
        const { _id, ...rest } = m.doc;
        await this.documents.openNew(this.target, JSON.stringify(rest, null, 2) + '\n');
        break;
      }
      case 'insertDocument':
        await this.documents.openNew(this.target);
        break;
      case 'deleteDocument':
        await this.deleteDocument(m.id);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('Mongoster: copied to clipboard', 2000);
        break;
    }
  }

  private postHistory(): void {
    this.post({ type: 'history', recent: this.history.recent, saved: this.history.saved });
  }

  private async deleteDocument(id: unknown): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Delete document ${toShell(id)} from ${this.target.collection}?`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') return;
    try {
      const client = await this.connections.getClient(this.target.connectionId);
      const res = await client
        .db(this.target.database)
        .collection(this.target.collection)
        .deleteOne(byId(fromRelaxed(id)));
      if (!res.deletedCount) void vscode.window.showWarningMessage('Document not found: it may have been deleted already.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Delete failed: ${errorMessage(err)}`);
    }
    this.post({ type: 'refresh' });
  }

  private async runQuery(m: QueryRequest): Promise<void> {
    const started = Date.now();
    try {
      const filter = toBson(m.filter, 'Filter') ?? {};
      const sort = toBson(m.sort, 'Sort');
      const projection = toBson(m.projection, 'Projection');
      const client = await this.connections.getClient(this.target.connectionId);
      const coll = client.db(this.target.database).collection(this.target.collection);
      const [docs, count] = await Promise.all([
        coll
          .find(filter, { sort, projection, skip: m.skip, limit: m.limit, maxTimeMS: 60_000, promoteLongs: false })
          .toArray(),
        countDocuments(coll, filter),
      ]);
      this.post({
        type: 'result',
        requestId: m.requestId,
        docs: relaxEjson(EJSON.serialize(docs, { relaxed: false })) as unknown[],
        count,
        durationMs: Date.now() - started,
      });
      if (await this.history.record(m)) this.postHistory();
    } catch (err) {
      this.post({ type: 'error', requestId: m.requestId, message: errorMessage(err) });
    }
  }

  private async runAggregate(m: AggregateRequest): Promise<void> {
    const started = Date.now();
    const active = m.stages
      .slice(0, m.upto + 1)
      .map((stage, index) => ({ stage, index }))
      .filter(({ stage }) => stage.enabled);

    const pipeline: Document[] = [];
    for (const { stage, index } of active) {
      try {
        pipeline.push({ [stage.op.trim()]: fromRelaxed(parseStageBody(stage)) });
      } catch (err) {
        this.post({ type: 'error', requestId: m.requestId, stage: index, message: `Stage ${index + 1} (${stage.op}): ${errorMessage(err)}` });
        return;
      }
    }
    const writes = active.filter(({ stage }) => isWriteStage(stage));
    const misplaced = writes.find((w) => w !== active[active.length - 1]);
    if (misplaced) {
      this.post({ type: 'error', requestId: m.requestId, stage: misplaced.index, message: `${misplaced.stage.op} must be the last stage of the pipeline` });
      return;
    }

    try {
      const client = await this.connections.getClient(this.target.connectionId);
      const coll = client.db(this.target.database).collection(this.target.collection);

      if (writes.length) {
        const { stage } = writes[0];
        const target = toShell(parseStageBody(stage));
        const answer = await vscode.window.showWarningMessage(
          `Run this pipeline? Its ${stage.op} stage writes to ${target}.`,
          { modal: true, detail: 'This modifies the database. Select an earlier stage to preview without writing.' },
          'Run',
        );
        if (answer !== 'Run') {
          this.post({ type: 'error', requestId: m.requestId, message: `Not run: the ${stage.op} stage was cancelled.` });
          return;
        }
        await coll.aggregate(pipeline, { maxTimeMS: 600_000, allowDiskUse: true }).toArray();
        this.post({
          type: 'result',
          requestId: m.requestId,
          docs: [],
          count: 0,
          durationMs: Date.now() - started,
          note: `Pipeline output written by ${stage.op} to ${target}.`,
        });
        void vscode.commands.executeCommand('mongoster.refresh');
      } else {
        const [docs, count] = await Promise.all([
          coll
            .aggregate([...pipeline, { $skip: m.skip }, { $limit: m.limit }], {
              maxTimeMS: 60_000,
              allowDiskUse: true,
              promoteLongs: false,
            })
            .toArray(),
          countPipeline(coll, pipeline),
        ]);
        this.post({
          type: 'result',
          requestId: m.requestId,
          docs: relaxEjson(EJSON.serialize(docs, { relaxed: false })) as unknown[],
          count,
          durationMs: Date.now() - started,
        });
      }
      if (await this.history.record({ filter: '', sort: '', projection: '', pipeline: m.stages })) this.postHistory();
    } catch (err) {
      this.post({ type: 'error', requestId: m.requestId, message: errorMessage(err) });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'webview.css')}">
  <title>${escapeHtml(this.target.collection)}</title>
</head>
<body>
  <div id="progress" class="progress"></div>
  <header class="toolbar">
    <div class="row top">
      <div class="ns" id="ns"></div>
      <span class="spacer"></span>
      <div class="mode" role="tablist" aria-label="Query mode">
        <button id="modeFind" role="tab" aria-selected="true" title="Filter, sort and project documents">Find</button>
        <button id="modeAggregate" role="tab" aria-selected="false" title="Build an aggregation pipeline">Aggregate</button>
      </div>
      <button id="historyBtn" class="secondary" title="Recent and saved queries" aria-haspopup="true" aria-expanded="false">History ▾</button>
      <button id="insert" class="secondary editable" title="Insert a new document">Insert</button>
    </div>
    <div class="find-only">
      <div class="row">
        <label for="filter">Filter</label>
        <div class="filter-wrap" id="filterWrap">
          <textarea id="filter" rows="1" spellcheck="false" placeholder="{ field: &quot;value&quot; }  —  or drag a cell / column here"></textarea>
          <div class="dropzones" id="dropzones"></div>
        </div>
        <button id="run" class="primary" title="Run query (Ctrl+Enter)">Find</button>
        <button id="reset" class="secondary" title="Clear filter, sort and projection">Reset</button>
      </div>
      <div class="row options">
        <label for="sort">Sort</label>
        <input id="sort" spellcheck="false" placeholder="{ field: -1 }">
        <label for="projection">Project</label>
        <input id="projection" spellcheck="false" placeholder="{ field: 1 }">
      </div>
    </div>
    <div class="aggregate-only pipeline">
      <div class="stages-wrap" id="stagesWrap">
        <div class="stages" id="stages"></div>
        <textarea id="pipelineText" class="pipeline-text hidden" spellcheck="false" placeholder="[ { $match: { field: &quot;value&quot; } }, { $group: { _id: &quot;$field&quot;, n: { $sum: 1 } } } ]"></textarea>
        <div class="dropzones pipeline-drop" id="pipelineDrop"></div>
      </div>
      <datalist id="stageOps"></datalist>
      <div class="row pipeline-actions">
        <button id="runPipeline" class="primary" title="Run the whole pipeline (Ctrl+Enter in a stage)">Run</button>
        <button id="clearPipeline" class="secondary" title="Remove all stages">Clear</button>
        <button id="addStage" class="secondary" title="Add a stage at the end">+ Stage</button>
        <button id="pipelineTextToggle" class="secondary" title="Edit or paste the whole pipeline as text">Edit as text</button>
        <button id="copyPipeline" class="secondary" title="Copy the pipeline (mongosh syntax)">Copy</button>
        <span class="spacer"></span>
        <span id="previewInfo" class="preview-info"></span>
      </div>
    </div>
  </header>
  <div id="historyPanel" class="history hidden" role="dialog" aria-label="Query history">
    <div class="history-head">
      <input id="historySearch" spellcheck="false" placeholder="Search queries">
      <button id="saveCurrent" class="secondary" title="Save the current filter, sort and projection with a name">☆ Save current</button>
    </div>
    <div class="history-body" id="historyBody"></div>
  </div>
  <div class="error hidden" id="error"></div>
  <div class="statusbar">
    <span id="status"></span>
    <span class="spacer"></span>
    <label for="limit">Page size</label>
    <select id="limit">
      <option>10</option><option>20</option><option selected>50</option><option>100</option><option>200</option><option>500</option>
    </select>
    <button id="prev" class="icon" title="Previous page">‹</button>
    <span id="range"></span>
    <button id="next" class="icon" title="Next page">›</button>
  </div>
  <main class="grid-wrap" id="gridWrap">
    <table id="grid" class="grid"></table>
    <div id="empty" class="empty hidden">No documents match this query.</div>
  </main>
  <div id="modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box">
      <div class="modal-head">
        <button id="docPrev" class="icon" title="Previous document (↑)">‹</button>
        <span id="docTitle" class="doc-title"></span>
        <button id="docNext" class="icon" title="Next document (↓)">›</button>
        <span class="spacer"></span>
        <button id="docExpand" class="icon" title="Expand all">⊞</button>
        <button id="docCollapse" class="icon" title="Collapse all">⊟</button>
        <button id="docCopy" class="secondary">Copy</button>
        <button id="docDuplicate" class="secondary editable doc-write" title="Open a copy without _id as a new document">Duplicate</button>
        <button id="docDelete" class="secondary editable danger doc-write">Delete</button>
        <button id="docEdit" class="primary doc-write" title="Open in an editor tab (Ctrl+S saves to the database)">Edit</button>
        <button id="docClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="modal-body" id="docBody"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
}

/** Relaxed EJSON plain value from the webview -> BSON value. */
function fromRelaxed(value: unknown): unknown {
  return EJSON.deserialize({ v: value } as Document, { relaxed: false }).v;
}

function toBson(text: string, label: string): Document | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = parseQuery(text);
  } catch (err) {
    throw new Error(`${label}: ${errorMessage(err)}`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  // Non-relaxed keeps NumberLong/NumberDecimal exact instead of collapsing them to JS numbers.
  return EJSON.deserialize(value, { relaxed: false }) as Document;
}

async function countPipeline(coll: Collection, pipeline: Document[]): Promise<number | null> {
  try {
    const [res] = await coll.aggregate([...pipeline, { $count: 'n' }], { maxTimeMS: 10_000, allowDiskUse: true }).toArray();
    return res?.n ?? 0;
  } catch {
    return null;
  }
}

async function countDocuments(coll: Collection, filter: Document): Promise<number | null> {
  try {
    return Object.keys(filter).length
      ? await coll.countDocuments(filter, { maxTimeMS: 10_000 })
      : await coll.estimatedDocumentCount({ maxTimeMS: 10_000 });
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
