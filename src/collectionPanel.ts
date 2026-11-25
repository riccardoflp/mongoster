import * as os from 'os';
import * as vscode from 'vscode';
import { ThemeColors } from './themeColors';
import { BSON, Collection, Document } from 'mongodb';
import { ConnectionColor, ConnectionInfo, ConnectionManager } from './connections';
import { paintTab } from './connectionColors';
import { colorOf } from './shared/collectionColors';
import { byId, CollectionRef, DocumentFileSystem, relaxed, restoreTypes } from './documentFs';
import { errorMessage } from './tree';
import { QueryHistory } from './queryHistory';
import { ProjectQueries } from './projectQueries';
import { SavedQueryActions } from './savedQueryActions';
import { parseQuery, relaxEjson, toShell } from './shared/query';
import { parseDocuments } from './shared/formats';
import { PipelineStage, parseStageBody } from './shared/pipeline';
import { StageError, buildPipeline, findOptions, fromRelaxed, toBson, toUpdate } from './queries';
import { QueryRun, TIMEOUT_SETTING, findPage, pipelinePage, runWritePipeline, timeoutSeconds } from './queryRunner';
import { exportDocuments } from './transfer';
import { UndoHistory } from './history';
import { RedisOplog } from './redisOplog';
import { DocumentHistoryPanel } from './docHistory';
import { updatedFields } from './shared/oplog';
import { CONVERT_TYPES, convertField, fieldPathError, removeField, renameError, renameField, typeCounts } from './fieldActions';
import type { AggregateRequest, BulkRequest, FieldActionRequest, HistoryEntry, HostMessage, QueryRequest, QuerySource, QueryText, RunKind, UpdateFieldRequest, WebviewMessage } from './shared/messages';
import { suggestIndex, summarizeExplain } from './shared/explain';
import { analyzeSchema } from './shared/schema';
import { ChartSpec, chartStages, normalizeSpec, specError } from './shared/chart';
import { fieldHints } from './shared/complete';
import { collectionNameError } from './manage';
import { loadIndexes, saveIndex } from './indexes';
import { dropSearchIndex, loadSearchIndexes, saveSearchIndex } from './searchIndexes';
import type { ColumnLayout } from './shared/columns';
import { RelationsCache } from './relationsAnalysis';
import type { RelGraph } from './shared/relations';
import { collectionReferences } from './shared/references';
import { FORMAT_SCOPES, FormatScope, ScopedRules, readFormattingPane, readScopedChanges, readScopesOff } from './shared/formatting';
import { exportFormatting, importFormatting } from './formattingTransfer';
import { formattingKey, formattingOffKey, readFormatting, readFormattingOff, scopeReaches, writeFormatting, writeFormattingOff } from './formattingStore';
import { noLinks } from './shared/plainText';
import { POSITION_SETTING, QueryPane, queryPaneSave, readQueryPane } from './shared/queryPane';
import { collectionHtml } from './collectionHtml';

const { EJSON } = BSON;
/** Documents sampled for the autocompletion of field names and values. */
const FIELD_SAMPLE = 500;

export interface CollectionTarget extends CollectionRef {
  connectionName: string;
  /** No document changes: views, and every collection of a read-only connection. */
  readOnly: boolean;
  view: boolean;
  /** The connection is read-only: no writes of any kind (indexes, $out, …). */
  locked: boolean;
}

/** Why `target` can't be modified. */
export function readOnlyMessage(target: CollectionTarget): string {
  return target.locked ? `The connection ${target.connectionName} is read-only.` : 'Views are read-only.';
}

/** The key of a collection's tab and of its state (queries, layout). */
export const panelKey = (ref: CollectionRef) => `${ref.connectionId}/${ref.database}/${ref.collection}`;
export const expandedStateKey = (ref: CollectionRef) => `mongoster.expanded.${panelKey(ref)}`;
export const layoutStateKey = (ref: CollectionRef) => `mongoster.layout.${panelKey(ref)}`;
export const formattingStateKey = (ref: CollectionRef) => formattingKey('collection', ref);
/** The Formatting pane, for every collection's tab: `{ open, width, hidden }`. */
export const FORMATTING_PANE_KEY = 'mongoster.formattingPane';
/** The width of the query pane, for every collection's tab: `{ width }`. Its place is the setting `mongoster.queryBar.position`. */
export const QUERY_PANE_KEY = 'mongoster.queryPane';

/** Carries the recent and saved queries, the expanded columns, the layout, the formatting rules and the scopes turned off of a renamed collection over to its new name. */
export async function moveCollectionState(state: vscode.Memento, from: CollectionRef, to: CollectionRef): Promise<void> {
  const keys = (ref: CollectionRef) => [...QueryHistory.stateKeys(panelKey(ref)), expandedStateKey(ref), layoutStateKey(ref), formattingStateKey(ref), formattingOffKey(ref)];
  const [fromKeys, toKeys] = [keys(from), keys(to)];
  for (let i = 0; i < fromKeys.length; i++) {
    const value = state.get(fromKeys[i]);
    if (value === undefined) continue;
    await state.update(toKeys[i], value);
    await state.update(fromKeys[i], undefined);
  }
}

/** One webview tab per collection, showing a queryable grid of documents. */
export class CollectionPanel {
  private static readonly panels = new Map<string, CollectionPanel>();

  static show(
    context: vscode.ExtensionContext,
    connections: ConnectionManager,
    documents: DocumentFileSystem,
    target: CollectionTarget,
    /** A query to show instead of the last one. */
    initial?: { query: QueryText; explain: boolean },
    /** A tab to show instead of the last one, or the insert dialog. */
    mode?: 'indexes' | 'insert',
  ): void {
    const key = panelKey(target);
    const existing = CollectionPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (initial) existing.post({ type: 'loadQuery', ...initial });
      if (mode) existing.showMode(mode);
      return;
    }
    const panel = new CollectionPanel(context, connections, documents, target, () => {
      CollectionPanel.panels.delete(key);
    });
    panel.pending = initial;
    panel.pendingMode = mode;
    CollectionPanel.panels.set(key, panel);
  }

  /** Closes the panels of the collections matching `which` (e.g. dropped ones); returns their targets. */
  static close(which: (target: CollectionTarget) => boolean): CollectionTarget[] {
    const closed = [...CollectionPanel.panels.values()].filter((p) => which(p.target));
    closed.forEach((p) => p.panel.dispose());
    return closed.map((p) => p.target);
  }

  /** Applies a connection's new name, color or read-only setting to its open panels. */
  static connectionChanged(info: ConnectionInfo): void {
    for (const p of CollectionPanel.panels.values()) {
      if (p.target.connectionId !== info.id) continue;
      p.target.connectionName = info.name;
      p.target.locked = !!info.readOnly;
      p.target.readOnly = p.target.view || p.target.locked;
      p.postInit();
    }
  }

  /** Asks the active collection tab to save its current query in the project (the `Save Query in the Project` command). */
  static saveActiveInProject(): void {
    const active = [...CollectionPanel.panels.values()].find((p) => p.panel.active);
    if (active) active.post({ type: 'saveCurrent', place: 'project' });
    else void vscode.window.showInformationMessage('Open the tab of a collection to save its query in the project.');
  }

  /** Re-runs the current query of the collection's panel, if open (e.g. after a document was saved). */
  static refresh(ref: CollectionRef): void {
    CollectionPanel.panels.get(panelKey(ref))?.post({ type: 'refresh' });
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly history: QueryHistory;
  private readonly savedQueries: SavedQueryActions;
  /** Query to load once the webview is ready. */
  private pending?: { query: QueryText; explain: boolean };
  /** Tab (or the insert dialog) to show once the webview is ready. */
  private pendingMode?: 'indexes' | 'insert';
  /** The webview asked for the references: it gets them again when they are found anew. */
  private referencesWanted = false;
  /** The last run started of each kind, while it runs: what `Cancel` stops. */
  private readonly runs = new Map<RunKind, QueryRun>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly documents: DocumentFileSystem,
    private readonly target: CollectionTarget,
    onDispose: () => void,
  ) {
    this.history = new QueryHistory(context.globalState, panelKey(target));
    this.savedQueries = new SavedQueryActions(context.globalState, this.history, () => ({
      connectionName: this.target.connectionName,
      database: this.target.database,
      collection: this.target.collection,
    }));
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')];
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.collection',
      target.collection,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots },
    );
    paintTab(this.panel, context.extensionUri, this.color(), 'collection.svg');
    this.panel.webview.html = collectionHtml(this.panel.webview, context.extensionUri, target.collection);
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m));
    ThemeColors.attach(this.panel);
    // The project's saved queries change when their files do (git pull, edits by hand).
    const projectChanged = ProjectQueries.instance?.onDidChange(() => this.postHistory());
    const references = RelationsCache.onDidUpdate((e) => {
      if (this.referencesWanted && e.connectionId === this.target.connectionId && e.database === this.target.database) this.postReferences(e.graph);
    });
    // The place of the query, changed by the toggle of any tab or in the settings.
    const position = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`mongoster.${POSITION_SETTING}`)) this.post({ type: 'queryPane', pane: this.queryPane() });
    });
    this.panel.onDidDispose(() => {
      projectChanged?.dispose();
      references.dispose();
      position.dispose();
      onDispose();
    });
  }

  /** The collection's own color, or its connection's (D16). */
  private color(): ConnectionColor | undefined {
    return colorOf(this.connections.get(this.target.connectionId), this.target.database, this.target.collection);
  }

  /** Tells the open tabs a changed scope reaches, and this one when the change was not made in its pane. */
  private formatRulesChanged(changes: Partial<ScopedRules>, self: boolean): void {
    for (const p of CollectionPanel.panels.values()) {
      if (p === this && !self) continue;
      const theirs = Object.fromEntries(Object.entries(changes).filter(([scope]) => p === this || scopeReaches(scope as FormatScope, this.target, p.target)));
      if (Object.keys(theirs).length) p.post({ type: 'formatRules', changes: theirs });
    }
  }

  private postInit(): void {
    const t = this.target;
    paintTab(this.panel, this.context.extensionUri, this.color(), 'collection.svg');
    this.post({
      type: 'init',
      connectionName: t.connectionName,
      database: t.database,
      collection: t.collection,
      readOnly: t.readOnly,
      view: t.view,
      locked: t.locked,
      color: this.color(),
      expanded: this.context.globalState.get<string[]>(expandedStateKey(t), []),
      layout: this.context.globalState.get<ColumnLayout>(layoutStateKey(t), {}),
      formatting: readFormatting(this.context.globalState, t),
      formattingOff: readFormattingOff(this.context.globalState, t),
      formattingPane: readFormattingPane(this.context.globalState.get(FORMATTING_PANE_KEY)),
      queryPane: this.queryPane(),
    });
  }

  /** The place of the query (the setting) and the pane's width (globalState). */
  private queryPane(): QueryPane {
    return readQueryPane(vscode.workspace.getConfiguration('mongoster').get(POSITION_SETTING), this.context.globalState.get(QUERY_PANE_KEY));
  }

  /** Shows why the collection can't be modified; true when it can't. */
  private refuseWrite(): boolean {
    if (!this.target.readOnly) return false;
    void vscode.window.showErrorMessage(readOnlyMessage(this.target));
    return true;
  }

  private showMode(mode: 'indexes' | 'insert'): void {
    this.post(mode === 'insert' ? { type: 'showInsert' } : { type: 'showMode', mode });
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postInit();
        this.postHistory();
        if (this.pending) this.post({ type: 'loadQuery', ...this.pending });
        if (this.pendingMode) this.showMode(this.pendingMode);
        this.pending = this.pendingMode = undefined;
        break;
      case 'saveQuery':
        if (await this.savedQueries.save(m.query, m.place)) this.postHistory();
        break;
      case 'removeQuery':
        if (await this.savedQueries.remove(m.id)) this.postHistory();
        break;
      case 'renameQuery':
        if (await this.savedQueries.rename(m.id)) this.postHistory();
        break;
      case 'moveQuery':
        if (await this.savedQueries.move(m.id)) this.postHistory();
        break;
      case 'openQueryFile':
        await this.savedQueries.openFile(m.id);
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
      case 'saveLayout': {
        const l = m.layout;
        const empty = !l.hidden?.length && !l.order?.length && !l.pinned?.length && !Object.keys(l.widths ?? {}).length;
        await this.context.globalState.update(layoutStateKey(this.target), empty ? undefined : l);
        break;
      }
      case 'saveFormatRules': {
        // Feature: query.format-rules. Kept for the user, like the layout; nothing is written to the database.
        // The rules of a database, a connection and the global ones are also other open tabs': they hear of them here.
        const changes = readScopedChanges(m.changes);
        for (const scope of FORMAT_SCOPES) {
          const rules = changes[scope];
          if (rules) await writeFormatting(this.context.globalState, this.target, scope, rules);
        }
        this.formatRulesChanged(changes, false);
        break;
      }
      case 'exportFormatting':
        await exportFormatting(this.context.globalState, this.target);
        break;
      case 'importFormatting': {
        const changes = await importFormatting(this.context.globalState, this.target);
        if (changes) this.formatRulesChanged(changes, true);
        break;
      }
      case 'saveFormattingOff':
        await writeFormattingOff(this.context.globalState, this.target, readScopesOff(m.off));
        break;
      case 'saveFormattingPane': {
        // One pane for every collection's tab: open or closed, its width, the colors hidden or shown.
        const pane = readFormattingPane(m.pane);
        await this.context.globalState.update(FORMATTING_PANE_KEY, pane);
        for (const p of CollectionPanel.panels.values()) if (p !== this) p.post({ type: 'formattingPane', pane });
        break;
      }
      case 'saveQueryPane': {
        // One choice for every collection. The place is a setting: changing it reaches every tab through
        // onDidChangeConfiguration. The width is Mongoster's own state, sent to the other tabs here.
        const config = vscode.workspace.getConfiguration('mongoster');
        const save = queryPaneSave(config.get(POSITION_SETTING), this.context.globalState.get(QUERY_PANE_KEY), m.pane);
        if (save.position) await config.update(POSITION_SETTING, save.position, vscode.ConfigurationTarget.Global);
        if (save.width !== undefined) {
          await this.context.globalState.update(QUERY_PANE_KEY, { width: save.width });
          for (const p of CollectionPanel.panels.values()) if (p !== this) p.post({ type: 'queryPane', pane: p.queryPane() });
        }
        break;
      }
      case 'saveExpanded':
        await this.context.globalState.update(expandedStateKey(this.target), m.expanded.length ? m.expanded : undefined);
        break;
      case 'query':
        await this.runQuery(m);
        break;
      case 'cancel':
        await this.cancel(m.run);
        break;
      case 'aggregate':
        await this.runAggregate(m);
        break;
      case 'openCode': {
        const doc = await vscode.workspace.openTextDocument({ language: m.language, content: m.text });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        break;
      }
      case 'watch':
        await vscode.commands.executeCommand('mongoster.watchChanges', {
          connectionId: this.target.connectionId,
          database: this.target.database,
          collection: this.target.collection,
        });
        break;
      case 'editDocument':
        await this.documents.open(this.target, fromRelaxed(m.id));
        break;
      case 'insertDocuments':
        await this.insertDocuments(m.requestId, m.text);
        break;
      case 'insertInEditor':
        if (this.refuseWrite()) return;
        await this.documents.openNew(this.target, `${m.text.trim() || '{\n  \n}'}\n`);
        break;
      case 'updateField':
        await this.updateField(m);
        break;
      case 'explain':
        await this.explain(m.requestId, m.source);
        break;
      case 'bulkCount':
        try {
          const count = await (await this.coll()).countDocuments(toBson(m.filter, 'Filter') ?? {});
          this.post({ type: 'bulkCount', requestId: m.requestId, count });
        } catch (err) {
          this.post({ type: 'bulkCount', requestId: m.requestId, error: errorMessage(err) });
        }
        break;
      case 'bulkApply':
        await this.bulkApply(m);
        break;
      case 'fieldAction':
        await this.fieldAction(m);
        break;
      case 'analyzeSchema':
        await this.analyzeSchema(m.requestId, m.filter, m.size);
        break;
      case 'chart':
        await this.chart(m.requestId, m.source, m.spec);
        break;
      case 'savePng':
        await this.savePng(m.dataUrl, m.name);
        break;
      case 'loadFields':
        await this.loadFields();
        break;
      case 'saveView':
        await this.saveView(m.stages, m.upto);
        break;
      case 'editValidation':
        await vscode.commands.executeCommand('mongoster.editValidation', { ...this.target, readOnly: this.target.locked });
        break;
      case 'generateDocuments': {
        const t = this.target;
        await vscode.commands.executeCommand('mongoster.generateDocuments', {
          connectionId: t.connectionId,
          database: t.database,
          collection: t.collection,
          view: t.view,
          schema: m.schema,
          filter: m.filter,
        });
        break;
      }
      case 'loadIndexes':
        await this.postIndexes();
        break;
      case 'saveIndex':
        await this.saveIndex(m.requestId, m.original, m.keys, m.options);
        break;
      case 'dropIndex':
        if (this.refuseWrite()) return;
        await this.dropIndex(m.name);
        break;
      case 'hideIndex':
        if (this.refuseWrite()) return;
        await this.indexCommand(async () => (await this.db()).command({ collMod: this.target.collection, index: { name: m.name, hidden: m.hidden } }));
        break;
      // ---- Atlas Search and Vector Search indexes
      case 'loadSearchIndexes':
        await this.postSearchIndexes();
        break;
      case 'saveSearchIndex':
        await this.saveSearchIndex(m.requestId, m.original, m.name, m.searchType, m.definition);
        break;
      case 'dropSearchIndex':
        await this.dropSearchIndex(m.name);
        break;
      case 'deleteDocument':
        await this.deleteDocument(m.id);
        break;
      case 'deleteDocuments':
        await this.deleteDocuments(m.ids);
        break;
      case 'documentHistory':
        DocumentHistoryPanel.show(this.context, this.connections, this.documents, this.target, fromRelaxed(m.id));
        break;
      case 'export':
        await exportDocuments(this.connections, this.target, m.source, { expanded: m.expanded, layout: m.layout, page: m.page, count: m.count });
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('Mongoster: copied to clipboard', 2000);
        break;
      case 'loadReferences':
        await this.loadReferences();
        break;
      case 'openReference':
        await vscode.commands.executeCommand('mongoster.openQuery', {
          connectionId: this.target.connectionId,
          database: this.target.database,
          collection: m.collection,
          query: { filter: m.filter, sort: '', projection: '' },
          explain: false,
        });
        break;
    }
  }

  /**
   * The references of the collection, from the analysis of its database: cached per database, made on
   * the first tab that needs them (unless turned off in the settings, then only the diagram's are used).
   */
  private async loadReferences(): Promise<void> {
    this.referencesWanted = true;
    const { connectionId, database } = this.target;
    const detect = vscode.workspace.getConfiguration('mongoster.references').get<boolean>('detect', true);
    const graph = detect ? await RelationsCache.get(this.connections, connectionId, database) : RelationsCache.peek(connectionId, database);
    if (graph) this.postReferences(graph);
  }

  private postReferences(graph: RelGraph): void {
    // A view has the references of the collection it reads.
    const source = graph.collections.find((c) => c.name === this.target.collection)?.viewOn ?? this.target.collection;
    this.post({ type: 'references', ...collectionReferences(graph.relations, source) });
  }

  private postHistory(): void {
    this.post({ type: 'history', recent: this.history.recent, saved: this.savedQueries.saved() });
  }

  private async insertDocuments(requestId: number, text: string): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'insertResult', requestId, ok, message });
    if (this.target.readOnly) return reply(false, readOnlyMessage(this.target));
    let docs: Document[];
    try {
      docs = parseDocuments(text).map((d) => EJSON.deserialize(d, { relaxed: false }) as Document);
    } catch (err) {
      return reply(false, errorMessage(err));
    }
    const many = docs.length > 1;
    const rec = UndoHistory.start(this.target, many ? `Insert ${docs.length} documents` : 'Insert document', docs.length);
    let coll: Collection;
    let inserted = 0;
    let failure: string | undefined;
    try {
      coll = await this.coll();
    } catch (err) {
      return reply(false, errorMessage(err));
    }
    try {
      if (many) inserted = (await coll.insertMany(docs)).insertedCount;
      else inserted = (await coll.insertOne(docs[0])).acknowledged ? 1 : 0;
    } catch (err) {
      // An ordered insertMany stops at the first error: the documents before it are in.
      inserted = (err as { result?: { insertedCount?: number } }).result?.insertedCount ?? 0;
      failure = errorMessage(err);
      // Typically a copied document pasted back with its _id.
      if (/E11000 .* index: _id_ /.test(failure)) failure += '. Remove _id to insert a copy with a new one.';
    }
    if (!inserted) return reply(false, failure);
    // The driver sets the _id of the documents it sends.
    const ids = docs.slice(0, inserted).map((d) => d._id);
    ids.forEach((id) => rec?.addNew(id));
    RedisOplog.sink(this.target)?.inserted(ids);
    const entry = await rec?.commit(coll);
    const into = `into ${this.target.collection}.`;
    const message = failure
      ? `Inserted ${inserted} of ${docs.length} documents ${into}`
      : many
        ? `Inserted ${inserted.toLocaleString('en-US')} documents ${into}`
        : `Inserted document ${toShell(relaxed(ids[0]))} ${into}`;
    reply(!failure, failure ? `Inserted ${inserted} of ${docs.length} documents, then: ${failure}` : message);
    UndoHistory.notify(message, entry);
    this.post({ type: 'refresh' });
    void vscode.commands.executeCommand('mongoster.refresh');
  }

  private async deleteDocument(id: unknown): Promise<void> {
    if (this.refuseWrite()) return;
    const answer = await vscode.window.showWarningMessage(
      `Delete document ${toShell(id)} from ${this.target.collection}?`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') return;
    try {
      const coll = await this.coll();
      const _id = fromRelaxed(id);
      const filter = byId(_id);
      const rec = UndoHistory.start(this.target, `Delete document ${toShell(id)}`);
      await rec?.snapshot(coll, filter);
      const res = await coll.deleteOne(filter);
      if (!res.deletedCount) void vscode.window.showWarningMessage('Document not found: it may have been deleted already.');
      else {
        RedisOplog.sink(this.target)?.removed([_id]);
        const entry = await rec?.commit(coll);
        if (entry) UndoHistory.notify(`Deleted document ${toShell(id)} from ${this.target.collection}.`, entry);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Delete failed: ${errorMessage(err)}`);
    }
    this.post({ type: 'refresh' });
  }

  /**
   * $set of one value. The update only applies if the database still holds the value the user saw;
   * otherwise they're asked whether to overwrite. Numeric types are kept as in editDocument.
   */
  private async updateField(m: UpdateFieldRequest): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'fieldResult', requestId: m.requestId, ok, message });
    const key = m.path.join('.');
    if (this.target.readOnly) return reply(false, readOnlyMessage(this.target));
    if (m.path[0] === '_id') return reply(false, '_id cannot be changed.');
    let next: unknown;
    try {
      next = fromRelaxed(parseQuery(m.value));
    } catch (err) {
      return reply(false, errorMessage(err));
    }
    try {
      const client = await this.connections.getClient(this.target.connectionId);
      const coll = client.db(this.target.database).collection(this.target.collection);
      const id = fromRelaxed(m.id);
      const doc = await coll.findOne(byId(id), { projection: { [m.path[0]]: 1 }, promoteValues: false });
      if (!doc) return reply(false, 'Document not found: it may have been deleted.');
      const current = valueAt(doc, m.path);
      const changed = current === MISSING ? !m.missing : m.missing || JSON.stringify(relaxed(current)) !== JSON.stringify(m.original);
      if (changed) {
        const now = current === MISSING ? 'removed' : `changed to ${toShell(relaxed(current))}`;
        const answer = await vscode.window.showWarningMessage(
          `${key} was ${now} in the database after it was loaded. Overwrite it?`,
          { modal: true },
          'Overwrite',
        );
        if (answer !== 'Overwrite') {
          reply(false, 'Not saved: the value changed in the database.');
          this.post({ type: 'refresh' });
          return;
        }
      }
      const value = restoreTypes(next, current === MISSING ? undefined : current);
      const filter = { ...byId(id), [key]: current === MISSING ? { $exists: false } : current };
      const rec = UndoHistory.start(this.target, `Edit ${key} of ${toShell(m.id)}`);
      await rec?.snapshot(coll, byId(id));
      const update = { $set: { [key]: value } };
      const res = await coll.updateOne(filter, update);
      if (!res.matchedCount) return reply(false, `${key} changed again in the database: refresh and retry.`);
      if (res.modifiedCount) RedisOplog.sink(this.target)?.updated([id], updatedFields(update)!);
      await rec?.commit(coll);
      reply(true);
      this.post({ type: 'refresh' });
    } catch (err) {
      reply(false, errorMessage(err));
    }
  }

  /** Creates a view on this collection with the pipeline up to the previewed stage. */
  private async saveView(stages: PipelineStage[], upto: number): Promise<void> {
    if (this.target.locked) {
      void vscode.window.showErrorMessage(readOnlyMessage(this.target));
      return;
    }
    let pipeline: Document[];
    try {
      const built = buildPipeline(stages, upto);
      if (built.write) throw new Error(`A view can't contain ${built.write.op}: select an earlier stage.`);
      pipeline = built.pipeline;
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return;
    }
    const db = await this.db();
    const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    const name = (
      await vscode.window.showInputBox({
        title: 'Save Pipeline as View',
        prompt: `Name of the view on ${this.target.collection} (${pipeline.length} stage${pipeline.length === 1 ? '' : 's'})`,
        ignoreFocusOut: true,
        validateInput: (v) =>
          collectionNameError(v.trim()) ?? (existing.includes(v.trim()) ? 'A collection or view with this name already exists' : undefined),
      })
    )?.trim();
    if (!name) return;
    try {
      await db.createCollection(name, { viewOn: this.target.collection, pipeline });
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return;
    }
    void vscode.commands.executeCommand('mongoster.refresh');
    const open = await vscode.window.showInformationMessage(noLinks(`Created view ${this.target.database}.${name}.`), 'Open View');
    if (open === 'Open View') {
      CollectionPanel.show(this.context, this.connections, this.documents, { ...this.target, collection: name, view: true, readOnly: true });
    }
  }

  /** Field names and frequent values of a random sample, for autocompletion. */
  private async loadFields(): Promise<void> {
    try {
      const docs = await (await this.coll())
        .aggregate([{ $sample: { size: FIELD_SAMPLE } }], { promoteValues: false, maxTimeMS: 20_000 })
        .toArray();
      this.post({ type: 'fields', fields: fieldHints(analyzeSchema(docs.map((d) => EJSON.serialize(d, { relaxed: false })))) });
    } catch {
      this.post({ type: 'fields', fields: [] });
    }
  }

  /** Schema of a random sample of the documents matching the filter (all of them when they fit). */
  private async analyzeSchema(requestId: number, filterText: string, size: number): Promise<void> {
    const started = Date.now();
    const run = this.begin('schema');
    try {
      const coll = await this.coll();
      const filter = toBson(filterText, 'Filter') ?? {};
      const all = !Object.keys(filter).length;
      const total =
        all && !this.target.view ? await coll.estimatedDocumentCount(run.options(60_000)) : await coll.countDocuments(filter, run.options(60_000));
      const pipeline: Document[] = [];
      if (!all) pipeline.push({ $match: filter });
      pipeline.push(total > size ? { $sample: { size } } : { $limit: size });
      // promoteValues: false keeps Int32 and Double apart, so the types are reported exactly.
      const docs = await coll.aggregate(pipeline, { promoteValues: false, allowDiskUse: true, ...run.options(120_000) }).toArray();
      // The details are for `Generate…`.
      const schema = analyzeSchema(docs.map((d) => EJSON.serialize(d, { relaxed: false })), { details: true });
      this.post({ type: 'schema', requestId, schema, total: Math.max(total, schema.sampled), durationMs: Date.now() - started });
    } catch (err) {
      this.post({ type: 'schema', requestId, error: run.cancelled ? 'Analysis cancelled.' : errorMessage(err) });
    } finally {
      this.end('schema', run);
    }
  }

  /** The chart stages run after the filter (sort and projection don't matter) or the pipeline up to the previewed stage. */
  private async chart(requestId: number, source: QuerySource, requested: ChartSpec): Promise<void> {
    const started = Date.now();
    const run = this.begin('chart');
    try {
      const spec = normalizeSpec(requested);
      const invalid = specError(spec);
      if (invalid) throw new Error(invalid);
      let prefix: Document[];
      if (source.kind === 'find') {
        const filter = toBson(source.filter, 'Filter') ?? {};
        prefix = Object.keys(filter).length ? [{ $match: filter }] : [];
      } else {
        const built = buildPipeline(source.stages, source.upto);
        if (built.write) throw new Error(`A pipeline ending with ${built.write.op} can't be charted: select an earlier stage.`);
        prefix = built.pipeline;
      }
      const coll = await this.coll();
      const rows = await coll.aggregate([...prefix, ...chartStages(spec)], { allowDiskUse: true, ...run.options(120_000) }).toArray();
      this.post({ type: 'chartData', requestId, rows: relaxEjson(EJSON.serialize(rows, { relaxed: false })) as unknown[], durationMs: Date.now() - started });
    } catch (err) {
      this.post({ type: 'chartData', requestId, error: run.cancelled ? 'Chart cancelled.' : errorMessage(err) });
    } finally {
      this.end('chart', run);
    }
  }

  private async savePng(dataUrl: string, name: string): Promise<void> {
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!match) return;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const file = name.replace(/[\\/:*?"<>|]+/g, '_') + '.png';
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, file),
      filters: { 'PNG image': ['png'] },
      title: 'Export Chart',
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(match[1], 'base64'));
      void vscode.window.showInformationMessage(`Saved the chart to ${uri.fsPath}.`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not save the chart: ${errorMessage(err)}`);
    }
  }

  private async bulkApply(m: BulkRequest): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'bulkResult', requestId: m.requestId, ok, message });
    if (this.target.readOnly) return reply(false, readOnlyMessage(this.target));
    try {
      const filter = toBson(m.filter, 'Filter') ?? {};
      const update = m.op === 'update' ? toUpdate(m.update ?? '') : undefined;
      const coll = await this.coll();
      const verb = update ? 'Update' : 'Delete';
      if (!Object.keys(filter).length) {
        const total = await coll.countDocuments();
        if (!(await confirmEmptyFilter(`${verb} all ${total.toLocaleString('en-US')} documents of ${this.target.collection}?`, `${verb} All`))) {
          return reply(false);
        }
      }
      const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
      const label = `${verb} many ${oneLine(m.filter) || '{}'}${update ? ` with ${oneLine(m.update ?? '')}` : ''}`;
      const done = await this.writeMany(coll, filter, update, label);
      if (!done) return reply(false);
      const message = update
        ? `Updated ${this.target.collection}: ${done.matched.toLocaleString('en-US')} matched, ${done.modified.toLocaleString('en-US')} modified.`
        : `Deleted ${done.deleted.toLocaleString('en-US')} document${done.deleted === 1 ? '' : 's'} from ${this.target.collection}.`;
      reply(true, message);
      UndoHistory.notify(message, done.entry);
      this.post({ type: 'refresh' });
      void vscode.commands.executeCommand('mongoster.refresh');
    } catch (err) {
      reply(false, errorMessage(err));
    }
  }

  /**
   * Updates (with `update`) or deletes the documents matching `filter`, keeping them in the undo history
   * and announcing them to redis-oplog: the path of Update many / Delete many, the selected rows and the
   * column actions. Undefined when the user cancels (too many documents to undo).
   */
  private async writeMany(
    coll: Collection,
    filter: Document,
    update: Document | Document[] | undefined,
    label: string,
  ): Promise<{ matched: number; modified: number; deleted: number; entry?: HistoryEntry } | undefined> {
    const verb = update ? 'Update' : 'Delete';
    const rec = UndoHistory.start(this.target, label.length > 300 ? `${label.slice(0, 299)}…` : label);
    if (rec && !(await rec.snapshot(coll, filter))) {
      const answer = await vscode.window.showWarningMessage(
        `${verb} without the possibility to undo?`,
        { modal: true, detail: `The documents matching the filter are ${rec.overflow}: too many for the undo history (settings mongoster.history).` },
        `${verb} Without Undo`,
      );
      if (answer !== `${verb} Without Undo`) return undefined;
    }
    // redis-oplog announces each document: their _ids, before the write.
    const sink = RedisOplog.sink(this.target);
    const ids = !sink ? [] : rec && !rec.overflow ? rec.ids() : (await coll.find(filter, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    const done = { matched: 0, modified: 0, deleted: 0 };
    if (update) {
      const res = await coll.updateMany(filter, update);
      done.matched = res.matchedCount;
      done.modified = res.modifiedCount;
      if (res.modifiedCount) await sink?.updatedBy(coll, ids, update);
    } else {
      const res = await coll.deleteMany(filter);
      done.deleted = res.deletedCount;
      await sink?.removedOf(coll, ids, res.deletedCount);
    }
    return { ...done, entry: await rec?.commit(coll) };
  }

  /**
   * Rename field, Remove field or Convert type on a column: asks for the details, counts and confirms,
   * then writes like Update many (undo history, redis-oplog) on the documents matching the filter.
   */
  private async fieldAction(m: FieldActionRequest): Promise<void> {
    if (this.refuseWrite()) return;
    const field = m.field;
    const shown = m.array ? `${m.array}[].${field.slice(m.array.length + 1)}` : field;
    const invalid = fieldPathError(field);
    if (invalid) {
      // Field names come from the documents: in a notification their links are broken.
      void vscode.window.showErrorMessage(noLinks(`${field}: ${invalid}.`));
      return;
    }
    if (m.array && m.action !== 'remove') {
      void vscode.window.showErrorMessage(
        `${shown} is a field of the elements of the array ${m.array}: ${m.action === 'rename' ? '$rename' : 'Convert type'} can't change fields inside arrays.`,
        { modal: true, detail: `Use Update many with a pipeline that rewrites the array, e.g. [ { $set: { ${m.array}: { $map: { input: "$${m.array}", in: … } } } } ].` },
      );
      return;
    }
    try {
      const userFilter = toBson(m.filter, 'Filter') ?? {};
      const everything = !Object.keys(userFilter).length;
      const scope = everything ? `of ${this.target.collection}` : 'matching the filter';
      const where = everything ? '' : ` where ${m.filter.replace(/\s+/g, ' ').trim()}`;
      const coll = await this.coll();
      const count = (filter: Document) => coll.countDocuments(filter, { maxTimeMS: 60_000 });
      const docs = (n: number) => `${n.toLocaleString('en-US')} document${n === 1 ? '' : 's'}`;
      const confirm = async (question: string, button: string, details: string[], n: number, all: string) => {
        const detail = [...details, UndoHistory.note(this.target.connectionId, n)].filter(Boolean).join('\n');
        if ((await vscode.window.showWarningMessage(question, { modal: true, detail }, button)) !== button) return false;
        return !everything || confirmEmptyFilter(all, `${button} in All`);
      };
      const finish = (message: string, entry: HistoryEntry | undefined) => {
        UndoHistory.notify(message, entry);
        this.post({ type: 'refresh' });
      };

      if (m.action === 'rename') {
        const to = (
          await vscode.window.showInputBox({
            title: `Rename ${field}`,
            prompt: `New name of ${field} in the documents ${scope} (a dotted path moves it into a sub-document)`,
            value: field,
            valueSelection: [field.lastIndexOf('.') + 1, field.length],
            validateInput: (v) => renameError(field, v.trim()),
          })
        )?.trim();
        if (!to) return;
        const op = renameField(userFilter, field, to);
        const [n, reached, overwrites] = await Promise.all([count(op.filter), count(op.reached), count(op.overwrites)]);
        const skipped = reached > n ? `${docs(reached - n)} with ${field} or ${to} inside an array ${reached - n === 1 ? 'is' : 'are'} left out: $rename can't go through arrays.` : '';
        if (!n) {
          void vscode.window.showInformationMessage(noLinks(`No document ${scope} has ${field}.${skipped ? ` ${skipped}` : ''}`));
          return;
        }
        const replaced = overwrites ? `${docs(overwrites)} already ${overwrites === 1 ? 'has' : 'have'} ${to}: its value is replaced by that of ${field}.` : '';
        if (!(await confirm(`Rename ${field} to ${to} in ${docs(n)} ${scope}?`, 'Rename', [replaced, skipped], n, `Rename ${field} to ${to} in the whole collection ${this.target.collection}?`))) return;
        const done = await this.writeMany(coll, op.filter, op.update, `Rename field ${field} to ${to}${where}`);
        if (!done) return;
        this.post({ type: 'fieldChanged', from: field, to });
        finish(`Renamed ${field} to ${to} in ${docs(done.modified)} of ${this.target.collection}.`, done.entry);
      } else if (m.action === 'remove') {
        const op = removeField(userFilter, field, m.array);
        const [n, reached] = await Promise.all([count(op.filter), count(op.reached)]);
        const skipped =
          reached <= n
            ? ''
            : m.array
              ? `${docs(reached - n)} where ${m.array} isn't an array ${reached - n === 1 ? 'is' : 'are'} left out.`
              : `${docs(reached - n)} where ${field} is inside an array ${reached - n === 1 ? 'is' : 'are'} left out: remove it from the elements with Update many and $[].`;
        if (!n) {
          void vscode.window.showInformationMessage(noLinks(`No document ${scope} has ${shown}.${skipped ? ` ${skipped}` : ''}`));
          return;
        }
        const what = m.array ? `${shown} from the elements of ${m.array} in` : `${field} from`;
        if (!(await confirm(`Remove ${what} ${docs(n)} ${scope}?`, 'Remove', [skipped], n, `Remove ${shown} from the whole collection ${this.target.collection}?`))) return;
        const done = await this.writeMany(coll, op.filter, op.update, `Remove field ${shown}${where}`);
        if (!done) return;
        this.post({ type: 'fieldChanged', from: field });
        finish(`Removed ${shown} from ${docs(done.modified)} of ${this.target.collection}.`, done.entry);
      } else {
        let now = '';
        try {
          const types = await coll.aggregate(typeCounts(userFilter, field), { maxTimeMS: 30_000 }).toArray();
          now = types.map((t) => `${t._id} ${Number(t.n).toLocaleString('en-US')}`).join(' · ');
        } catch {
          // Only a hint.
        }
        const pick = await vscode.window.showQuickPick(
          CONVERT_TYPES.map((t) => ({ label: t.type, description: t.description })),
          { title: `Convert ${field}`, placeHolder: `Type to convert the values to${now ? ` · now: ${now}` : ''}` },
        );
        if (!pick) return;
        const type = pick.label;
        const op = convertField(userFilter, field, type);
        const [n, reached] = await Promise.all([count(op.filter), count(op.reached)]);
        const skipped = reached > n ? `${docs(reached - n)} where ${field} is inside an array ${reached - n === 1 ? 'is' : 'are'} left out.` : '';
        if (!n) {
          void vscode.window.showInformationMessage(noLinks(`No value of ${field} ${scope} needs converting to ${type}: null, missing values and arrays are left as they are.`));
          return;
        }
        const keep = "Values that can't be converted keep their value and type; null and arrays are left as they are.";
        if (!(await confirm(`Convert ${field} to ${type} in ${docs(n)} ${scope}?`, 'Convert', [keep, skipped], n, `Convert ${field} to ${type} in the whole collection ${this.target.collection}?`))) return;
        const done = await this.writeMany(coll, op.filter, op.update, `Convert field ${field} to ${type}${where}`);
        if (!done) return;
        const failed = await count(op.filter);
        const values = (k: number) => `${k.toLocaleString('en-US')} value${k === 1 ? '' : 's'}`;
        finish(
          `Converted ${field} to ${type} in ${docs(done.modified)} of ${this.target.collection}.${failed ? ` ${values(failed)} couldn't be converted and kept ${failed === 1 ? 'its' : 'their'} type.` : ''}`,
          done.entry,
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      this.post({ type: 'refresh' });
    }
  }

  /** Deletes the rows selected in the table, after a confirmation. */
  private async deleteDocuments(ids: unknown[]): Promise<void> {
    if (this.refuseWrite() || !ids.length) return;
    const n = ids.length;
    const answer = await vscode.window.showWarningMessage(
      `Delete ${n.toLocaleString('en-US')} documents from ${this.target.collection}?`,
      { modal: true, detail: `The ${n.toLocaleString('en-US')} documents selected in the table. ${UndoHistory.note(this.target.connectionId, n)}` },
      'Delete',
    );
    if (answer !== 'Delete') return;
    try {
      const coll = await this.coll();
      const label = `Delete ${n.toLocaleString('en-US')} documents ${ids.map((id) => toShell(id)).join(', ')}`;
      const done = await this.writeMany(coll, { _id: { $in: ids.map(fromRelaxed) } }, undefined, label);
      if (done) {
        const message =
          done.deleted < n
            ? `Deleted ${done.deleted.toLocaleString('en-US')} of ${n.toLocaleString('en-US')} documents from ${this.target.collection}: the others were already gone.`
            : `Deleted ${n.toLocaleString('en-US')} documents from ${this.target.collection}.`;
        UndoHistory.notify(message, done.entry);
        void vscode.commands.executeCommand('mongoster.refresh');
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Delete failed: ${errorMessage(err)}`);
    }
    this.post({ type: 'refresh' });
  }

  private async coll() {
    const client = await this.connections.getClient(this.target.connectionId);
    return client.db(this.target.database).collection(this.target.collection);
  }

  private db() {
    return this.connections.getClient(this.target.connectionId).then((c) => c.db(this.target.database));
  }

  private async explain(requestId: number, source: QuerySource): Promise<void> {
    // An explain with executionStats runs the query: it gets the query's time limit.
    const seconds = timeoutSeconds(vscode.workspace.getConfiguration('mongoster').get(TIMEOUT_SETTING));
    const limit = seconds > 0 ? { maxTimeMS: seconds * 1000 } : {};
    try {
      const coll = await this.coll();
      let raw: Document;
      let filter: unknown;
      let sort: unknown;
      if (source.kind === 'find') {
        raw = await coll.find(toBson(source.filter, 'Filter') ?? {}, { ...findOptions(source), ...limit }).explain('executionStats');
        filter = source.filter.trim() ? parseQuery(source.filter) : {};
        sort = source.sort.trim() ? parseQuery(source.sort) : undefined;
      } else {
        const { pipeline, write } = buildPipeline(source.stages, source.upto);
        if (write) throw new Error(`A pipeline ending with ${write.op} can't be explained here: select an earlier stage.`);
        raw = await coll.aggregate(pipeline, { allowDiskUse: true, ...limit }).explain('executionStats');
        // The query layer can use an index for a leading $match (and a $sort right after it).
        const [first, second] = source.stages.slice(0, source.upto + 1).filter((s) => s.enabled);
        if (first?.op.trim() === '$match') {
          filter = parseStageBody(first);
          if (second?.op.trim() === '$sort') sort = parseStageBody(second);
        } else if (first?.op.trim() === '$sort') sort = parseStageBody(first);
      }
      const summary = summarizeExplain(raw);
      const suggestion = summary.collscan || summary.inMemorySort ? suggestIndex(filter, sort) : null;
      this.post({ type: 'explainResult', requestId, summary, raw: relaxEjson(EJSON.serialize(raw, { relaxed: false })), suggestion });
    } catch (err) {
      this.post({ type: 'explainResult', requestId, error: errorMessage(err) });
    }
  }

  private async postIndexes(): Promise<void> {
    try {
      this.post({ type: 'indexes', ...(await loadIndexes(await this.db(), await this.coll())) });
    } catch (err) {
      this.post({ type: 'indexes', indexes: [], error: errorMessage(err) });
    }
  }

  private async saveIndex(requestId: number, original: string | undefined, keys: string, options: string): Promise<void> {
    try {
      if (this.target.view) throw new Error('Views have no indexes of their own.');
      if (this.target.locked) throw new Error(readOnlyMessage(this.target));
      if (original === '_id_') throw new Error("The _id index can't be changed.");
      const message = await saveIndex(await this.db(), await this.coll(), original, keys, options);
      this.post({ type: 'indexResult', requestId, ok: message !== undefined, message });
    } catch (err) {
      this.post({ type: 'indexResult', requestId, ok: false, message: errorMessage(err) });
    }
    await this.postIndexes();
  }

  private async dropIndex(name: string): Promise<void> {
    if (name === '_id_') return;
    const answer = await vscode.window.showWarningMessage(
      `Drop index ${name} on ${this.target.collection}?`,
      { modal: true, detail: 'Queries that use it will fall back to other indexes or a collection scan. Hiding the index first lets you check the impact without losing it.' },
      'Drop',
    );
    if (answer !== 'Drop') return;
    await this.indexCommand(async () => (await this.coll()).dropIndex(name));
  }

  private async indexCommand(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
    }
    await this.postIndexes();
  }

  // ---- Atlas Search and Vector Search indexes

  private async postSearchIndexes(): Promise<void> {
    try {
      this.post({ type: 'searchIndexes', ...(await loadSearchIndexes(await this.coll())) });
    } catch (err) {
      this.post({ type: 'searchIndexes', indexes: [], error: errorMessage(err) });
    }
  }

  /** Why the search indexes can't be changed from here, if they can't. */
  private searchIndexRefusal(): string | undefined {
    if (this.target.view) return 'Views have no indexes of their own: manage the search indexes from the Indexes tab of the source collection.';
    if (this.target.locked) return readOnlyMessage(this.target);
    return undefined;
  }

  private async saveSearchIndex(requestId: number, original: string | undefined, name: string, type: string, definition: string): Promise<void> {
    try {
      const refusal = this.searchIndexRefusal();
      if (refusal) throw new Error(refusal);
      const message = await saveSearchIndex(await this.coll(), original, name, type, definition);
      this.post({ type: 'searchIndexResult', requestId, ok: true, message });
    } catch (err) {
      this.post({ type: 'searchIndexResult', requestId, ok: false, message: errorMessage(err) });
    }
    await this.postSearchIndexes();
  }

  private async dropSearchIndex(name: string): Promise<void> {
    const refusal = this.searchIndexRefusal();
    if (refusal) {
      void vscode.window.showErrorMessage(refusal);
      return;
    }
    try {
      if (!(await dropSearchIndex(await this.coll(), name))) return;
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
    }
    await this.postSearchIndexes();
  }

  /** Starts a run of `kind`, with the time limit of the setting; it is the one `Cancel` stops until it ends. */
  private begin(kind: RunKind): QueryRun {
    const run = new QueryRun(timeoutSeconds(vscode.workspace.getConfiguration('mongoster').get(TIMEOUT_SETTING)));
    this.runs.set(kind, run);
    return run;
  }

  private end(kind: RunKind, run: QueryRun): void {
    if (this.runs.get(kind) === run) this.runs.delete(kind);
  }

  /** Feature: query.cancel. Stops the running query of `kind`, in the driver and on the server; it writes nothing. */
  private async cancel(kind: RunKind): Promise<void> {
    const run = this.runs.get(kind);
    if (!run) return;
    try {
      await run.cancel(await this.connections.getClient(this.target.connectionId));
    } catch {
      // The connection is gone: so is the query.
    }
  }

  private async runQuery(m: QueryRequest): Promise<void> {
    const started = Date.now();
    const run = this.begin('query');
    try {
      const { docs, count } = await findPage(await this.coll(), m, run);
      this.post({
        type: 'result',
        requestId: m.requestId,
        docs: relaxEjson(EJSON.serialize(docs, { relaxed: false })) as unknown[],
        count,
        durationMs: Date.now() - started,
      });
      if (await this.history.record(m)) this.postHistory();
    } catch (err) {
      this.post({ type: 'error', requestId: m.requestId, message: run.describe(err) ?? errorMessage(err), ...(run.cancelled && { cancelled: true }) });
    } finally {
      this.end('query', run);
    }
  }

  private async runAggregate(m: AggregateRequest): Promise<void> {
    const started = Date.now();
    let pipeline: Document[];
    let write: PipelineStage | undefined;
    try {
      ({ pipeline, write } = buildPipeline(m.stages, m.upto));
    } catch (err) {
      this.post({ type: 'error', requestId: m.requestId, stage: (err as StageError).stage, message: errorMessage(err) });
      return;
    }

    let run: QueryRun | undefined;
    try {
      const coll = await this.coll();

      if (write && this.target.locked) {
        this.post({ type: 'error', requestId: m.requestId, message: `${readOnlyMessage(this.target)} Pipelines ending with ${write.op} write to the database.` });
        return;
      }
      if (write) {
        const stage = write;
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
        run = this.begin('query');
        await runWritePipeline(coll, pipeline, run);
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
        run = this.begin('query');
        const { docs, count } = await pipelinePage(coll, pipeline, m.skip, m.limit, run);
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
      this.post({ type: 'error', requestId: m.requestId, message: run?.describe(err) ?? errorMessage(err), ...(run?.cancelled && { cancelled: true }) });
    } finally {
      if (run) this.end('query', run);
    }
  }
}

/** The extra confirmation of a write on every document of the collection (an empty filter). */
async function confirmEmptyFilter(question: string, button: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    question,
    { modal: true, detail: 'The filter is empty, so every document of the collection is affected.' },
    button,
  );
  return answer === button;
}

const MISSING = Symbol('missing');

/** Value at a path that may step into arrays by index; MISSING when absent. */
function valueAt(doc: unknown, path: string[]): unknown {
  let current = doc;
  for (const segment of path) {
    if (Array.isArray(current) && /^\d+$/.test(segment) && Number(segment) < current.length) current = current[Number(segment)];
    else if (current !== null && typeof current === 'object' && !Array.isArray(current) && !('_bsontype' in current) && segment in current) {
      current = (current as Record<string, unknown>)[segment];
    } else return MISSING;
  }
  return current;
}
