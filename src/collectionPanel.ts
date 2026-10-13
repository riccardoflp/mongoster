import * as os from 'os';
import * as vscode from 'vscode';
import { ThemeColors } from './themeColors';
import { BSON, Collection, Document } from 'mongodb';
import { ConnectionColor, ConnectionInfo, ConnectionManager } from './connections';
import { byId, CollectionRef, DocumentFileSystem, relaxed, restoreTypes } from './documentFs';
import { errorMessage } from './tree';
import { QueryHistory, sameQuery } from './queryHistory';
import { parseQuery, relaxEjson, toShell } from './shared/query';
import { PipelineStage, parseStageBody } from './shared/pipeline';
import { StageError, buildPipeline, fromRelaxed, toBson, toUpdate } from './queries';
import { exportDocuments } from './transfer';
import { UndoHistory } from './history';
import type { AggregateRequest, BulkRequest, HostMessage, QueryRequest, QuerySource, QueryText, UpdateFieldRequest, WebviewMessage } from './shared/messages';
import { suggestIndex, summarizeExplain } from './shared/explain';
import { analyzeSchema } from './shared/schema';
import { ChartSpec, chartStages, normalizeSpec, specError } from './shared/chart';
import { fieldHints } from './shared/complete';
import { collectionNameError } from './manage';
import { loadIndexes, saveIndex } from './indexes';
import type { ColumnLayout } from './shared/columns';

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
  color?: ConnectionColor;
}

/** Why `target` can't be modified. */
export function readOnlyMessage(target: CollectionTarget): string {
  return target.locked ? `The connection ${target.connectionName} is read-only.` : 'Views are read-only.';
}

const panelKey = (ref: CollectionRef) => `${ref.connectionId}/${ref.database}/${ref.collection}`;
export const expandedStateKey = (ref: CollectionRef) => `mongoster.expanded.${panelKey(ref)}`;
export const layoutStateKey = (ref: CollectionRef) => `mongoster.layout.${panelKey(ref)}`;

/** Carries the recent and saved queries and the expanded columns of a renamed collection over to its new name. */
export async function moveCollectionState(state: vscode.Memento, from: CollectionRef, to: CollectionRef): Promise<void> {
  const keys = (ref: CollectionRef) => [...QueryHistory.stateKeys(panelKey(ref)), expandedStateKey(ref), layoutStateKey(ref)];
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
    /** A tab to show instead of the last one. */
    mode?: 'indexes',
  ): void {
    const key = panelKey(target);
    const existing = CollectionPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (initial) existing.post({ type: 'loadQuery', ...initial });
      if (mode) existing.post({ type: 'showMode', mode });
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
      p.target.color = info.color;
      p.target.locked = !!info.readOnly;
      p.target.readOnly = p.target.view || p.target.locked;
      p.postInit();
    }
  }

  /** Re-runs the current query of the collection's panel, if open (e.g. after a document was saved). */
  static refresh(ref: CollectionRef): void {
    CollectionPanel.panels.get(panelKey(ref))?.post({ type: 'refresh' });
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly history: QueryHistory;
  /** Query to load once the webview is ready. */
  private pending?: { query: QueryText; explain: boolean };
  /** Tab to show once the webview is ready. */
  private pendingMode?: 'indexes';

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
    ThemeColors.attach(this.panel);
    this.panel.onDidDispose(onDispose);
  }

  private postInit(): void {
    const t = this.target;
    this.post({
      type: 'init',
      connectionName: t.connectionName,
      database: t.database,
      collection: t.collection,
      readOnly: t.readOnly,
      view: t.view,
      locked: t.locked,
      color: t.color,
      expanded: this.context.globalState.get<string[]>(expandedStateKey(t), []),
      layout: this.context.globalState.get<ColumnLayout>(layoutStateKey(t), {}),
    });
  }

  /** Shows why the collection can't be modified; true when it can't. */
  private refuseWrite(): boolean {
    if (!this.target.readOnly) return false;
    void vscode.window.showErrorMessage(readOnlyMessage(this.target));
    return true;
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
        if (this.pendingMode) this.post({ type: 'showMode', mode: this.pendingMode });
        this.pending = this.pendingMode = undefined;
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
      case 'saveLayout': {
        const l = m.layout;
        const empty = !l.hidden?.length && !l.order?.length && !l.pinned?.length && !Object.keys(l.widths ?? {}).length;
        await this.context.globalState.update(layoutStateKey(this.target), empty ? undefined : l);
        break;
      }
      case 'saveExpanded':
        await this.context.globalState.update(expandedStateKey(this.target), m.expanded.length ? m.expanded : undefined);
        break;
      case 'query':
        await this.runQuery(m);
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
      case 'duplicateDocument': {
        if (this.refuseWrite()) return;
        const { _id, ...rest } = m.doc;
        await this.documents.openNew(this.target, JSON.stringify(rest, null, 2) + '\n');
        break;
      }
      case 'insertDocument':
        if (this.refuseWrite()) return;
        await this.documents.openNew(this.target);
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
      case 'deleteDocument':
        await this.deleteDocument(m.id);
        break;
      case 'export':
        await exportDocuments(this.connections, this.target, m.source, { expanded: m.expanded, layout: m.layout, page: m.page, count: m.count });
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
    if (this.refuseWrite()) return;
    const answer = await vscode.window.showWarningMessage(
      `Delete document ${toShell(id)} from ${this.target.collection}?`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') return;
    try {
      const coll = await this.coll();
      const filter = byId(fromRelaxed(id));
      const rec = UndoHistory.start(this.target, `Delete document ${toShell(id)}`);
      await rec?.snapshot(coll, filter);
      const res = await coll.deleteOne(filter);
      if (!res.deletedCount) void vscode.window.showWarningMessage('Document not found: it may have been deleted already.');
      else {
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
      const res = await coll.updateOne(filter, { $set: { [key]: value } });
      if (!res.matchedCount) return reply(false, `${key} changed again in the database: refresh and retry.`);
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
    const open = await vscode.window.showInformationMessage(`Created view ${this.target.database}.${name}.`, 'Open View');
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
    try {
      const coll = await this.coll();
      const filter = toBson(filterText, 'Filter') ?? {};
      const all = !Object.keys(filter).length;
      const total =
        all && !this.target.view ? await coll.estimatedDocumentCount() : await coll.countDocuments(filter, { maxTimeMS: 60_000 });
      const pipeline: Document[] = [];
      if (!all) pipeline.push({ $match: filter });
      pipeline.push(total > size ? { $sample: { size } } : { $limit: size });
      // promoteValues: false keeps Int32 and Double apart, so the types are reported exactly.
      const docs = await coll.aggregate(pipeline, { promoteValues: false, maxTimeMS: 120_000, allowDiskUse: true }).toArray();
      const schema = analyzeSchema(docs.map((d) => EJSON.serialize(d, { relaxed: false })));
      this.post({ type: 'schema', requestId, schema, total: Math.max(total, schema.sampled), durationMs: Date.now() - started });
    } catch (err) {
      this.post({ type: 'schema', requestId, error: errorMessage(err) });
    }
  }

  /** The chart stages run after the filter (sort and projection don't matter) or the pipeline up to the previewed stage. */
  private async chart(requestId: number, source: QuerySource, requested: ChartSpec): Promise<void> {
    const started = Date.now();
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
      const rows = await coll.aggregate([...prefix, ...chartStages(spec)], { allowDiskUse: true, maxTimeMS: 120_000 }).toArray();
      this.post({ type: 'chartData', requestId, rows: relaxEjson(EJSON.serialize(rows, { relaxed: false })) as unknown[], durationMs: Date.now() - started });
    } catch (err) {
      this.post({ type: 'chartData', requestId, error: errorMessage(err) });
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
      if (!Object.keys(filter).length) {
        const verb = m.op === 'update' ? 'Update' : 'Delete';
        const total = await coll.countDocuments();
        const answer = await vscode.window.showWarningMessage(
          `${verb} all ${total.toLocaleString('en-US')} documents of ${this.target.collection}?`,
          { modal: true, detail: 'The filter is empty, so every document of the collection is affected.' },
          `${verb} All`,
        );
        if (answer !== `${verb} All`) return reply(false);
      }
      const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
      const label = `${update ? 'Update' : 'Delete'} many ${oneLine(m.filter) || '{}'}${update ? ` with ${oneLine(m.update ?? '')}` : ''}`;
      const rec = UndoHistory.start(this.target, label.length > 300 ? `${label.slice(0, 299)}…` : label);
      if (rec && !(await rec.snapshot(coll, filter))) {
        const verb = m.op === 'update' ? 'Update' : 'Delete';
        const answer = await vscode.window.showWarningMessage(
          `${verb} without the possibility to undo?`,
          { modal: true, detail: `The documents matching the filter are ${rec.overflow}: too many for the undo history (settings mongoster.history).` },
          `${verb} Without Undo`,
        );
        if (answer !== `${verb} Without Undo`) return reply(false);
      }
      let message: string;
      if (update) {
        const res = await coll.updateMany(filter, update);
        message = `Updated ${this.target.collection}: ${res.matchedCount.toLocaleString('en-US')} matched, ${res.modifiedCount.toLocaleString('en-US')} modified.`;
      } else {
        const res = await coll.deleteMany(filter);
        message = `Deleted ${res.deletedCount.toLocaleString('en-US')} document${res.deletedCount === 1 ? '' : 's'} from ${this.target.collection}.`;
      }
      const entry = await rec?.commit(coll);
      reply(true, message);
      UndoHistory.notify(message, entry);
      this.post({ type: 'refresh' });
      void vscode.commands.executeCommand('mongoster.refresh');
    } catch (err) {
      reply(false, errorMessage(err));
    }
  }

  private async coll() {
    const client = await this.connections.getClient(this.target.connectionId);
    return client.db(this.target.database).collection(this.target.collection);
  }

  private db() {
    return this.connections.getClient(this.target.connectionId).then((c) => c.db(this.target.database));
  }

  private async explain(requestId: number, source: QuerySource): Promise<void> {
    try {
      const coll = await this.coll();
      let raw: Document;
      let filter: unknown;
      let sort: unknown;
      if (source.kind === 'find') {
        raw = await coll
          .find(toBson(source.filter, 'Filter') ?? {}, {
            sort: toBson(source.sort, 'Sort'),
            projection: toBson(source.projection, 'Projection'),
            maxTimeMS: 60_000,
          })
          .explain('executionStats');
        filter = source.filter.trim() ? parseQuery(source.filter) : {};
        sort = source.sort.trim() ? parseQuery(source.sort) : undefined;
      } else {
        const { pipeline, write } = buildPipeline(source.stages, source.upto);
        if (write) throw new Error(`A pipeline ending with ${write.op} can't be explained here: select an earlier stage.`);
        raw = await coll.aggregate(pipeline, { allowDiskUse: true, maxTimeMS: 60_000 }).explain('executionStats');
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
    let pipeline: Document[];
    let write: PipelineStage | undefined;
    try {
      ({ pipeline, write } = buildPipeline(m.stages, m.upto));
    } catch (err) {
      this.post({ type: 'error', requestId: m.requestId, stage: (err as StageError).stage, message: errorMessage(err) });
      return;
    }

    try {
      const client = await this.connections.getClient(this.target.connectionId);
      const coll = client.db(this.target.database).collection(this.target.collection);

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
<body data-chart-src="${asset('dist', 'chartjs.js')}"${ThemeColors.bodyAttribute()}>
  <div id="progress" class="progress"></div>
  <header class="toolbar">
    <div class="row top">
      <div class="ns" id="ns"></div>
      <div class="top-actions">
      <div class="mode" role="tablist" aria-label="Query mode">
        <button id="modeFind" role="tab" aria-selected="true" title="Filter, sort and project documents">Find</button>
        <button id="modeAggregate" role="tab" aria-selected="false" title="Build an aggregation pipeline">Aggregate</button>
        <button id="modeSchema" role="tab" aria-selected="false" title="Fields, types and values of a sample of documents">Schema</button>
        <button id="modeChart" role="tab" aria-selected="false" title="Bar, line, pie, scatter and histogram charts of the documents">Chart</button>
        <button id="modeIndexes" role="tab" aria-selected="false" title="Indexes of the collection">Indexes</button>
      </div>
      <button id="historyBtn" class="secondary" title="Recent and saved queries" aria-haspopup="true" aria-expanded="false">History ▾</button>
      <button id="export" class="secondary not-indexes not-schema not-chart" title="Export the results to JSON, JSON Lines or CSV">Export</button>
      <button id="watch" class="secondary not-view" title="Show the changes of the collection as they happen (change stream)">Watch</button>
      <button id="insert" class="secondary editable" title="Insert a new document">Insert</button>
      </div>
    </div>
    <div class="find-only">
      <div class="row">
        <label for="filter">Filter</label>
        <div class="filter-line">
        <div class="filter-wrap" id="filterWrap">
          <textarea id="filter" rows="1" spellcheck="false" placeholder="{ field: &quot;value&quot; }  —  or drag a cell / column here"></textarea>
          <div class="dropzones" id="dropzones"></div>
        </div>
        <div class="filter-actions">
        <button id="builderToggle" class="secondary" title="Build the filter from fields, operators and values" aria-expanded="false" aria-controls="builder">Builder</button>
        <button id="run" class="primary" title="Run query (Ctrl+Enter)">Find</button>
        <button id="reset" class="secondary" title="Clear filter, sort and projection">Reset</button>
        <button id="explainFind" class="secondary not-schema not-chart" title="Show how MongoDB runs this query: index used, documents examined">Explain</button>
        <button id="codeFind" class="secondary not-schema not-chart" title="The query as code for mongosh, Node.js, Python, Java, C# or Go">Code</button>
        <button id="updateMany" class="secondary editable not-schema not-chart" title="Update every document matching the filter">Update many…</button>
        <button id="deleteMany" class="secondary editable danger not-schema not-chart" title="Delete every document matching the filter">Delete many…</button>
        </div>
        </div>
      </div>
      <div id="builder" class="builder hidden" role="group" aria-label="Filter builder"></div>
      <div class="row options not-schema not-chart">
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
        <button id="explainPipeline" class="secondary" title="Show how MongoDB runs the pipeline (up to the previewed stage)">Explain</button>
        <button id="saveView" class="secondary not-locked" title="Create a view with the pipeline up to the previewed stage">Save as view…</button>
        <button id="addStage" class="secondary" title="Add a stage at the end">+ Stage</button>
        <button id="pipelineTextToggle" class="secondary" title="Edit or paste the whole pipeline as text">Edit as text</button>
        <button id="copyPipeline" class="secondary" title="Copy the pipeline (mongosh syntax)">Copy</button>
        <button id="codePipeline" class="secondary" title="The pipeline as code for mongosh, Node.js, Python, Java, C# or Go">Code</button>
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
  <section class="schema-only schema-view" id="schemaView">
    <div class="row schema-head">
      <span id="schemaInfo" class="schema-info"></span>
      <span class="spacer"></span>
      <label for="schemaSize">Sample</label>
      <select id="schemaSize" title="Documents analyzed: a random sample when more match the filter">
        <option>100</option><option selected>1000</option><option>10000</option>
      </select>
      <button id="editValidation" class="secondary not-view" title="Validation rules ($jsonSchema) of the collection; without rules, a schema generated from the documents is proposed">Validation rules…</button>
      <button id="schemaExpand" class="icon" title="Expand all">⊞</button>
      <button id="schemaCollapse" class="icon" title="Collapse all">⊟</button>
    </div>
    <div id="schemaBody" class="schema-body"></div>
  </section>
  <section class="chart-only chart-view" id="chartView">
    <div class="row chart-head">
      <div id="chartTypes" class="mode" role="tablist" aria-label="Chart type"></div>
      <label for="chartSource">Data</label>
      <select id="chartSource" title="Documents charted: those matching the filter, or the output of the pipeline of the Aggregate tab (up to the previewed stage)">
        <option value="find">Filter</option><option value="aggregate">Pipeline</option>
      </select>
      <span id="chartPipelineInfo" class="chart-muted"></span>
      <span class="spacer"></span>
      <button id="chartCode" class="secondary" title="The chart's aggregation as code for mongosh, Node.js, Python, Java, C# or Go">Code</button>
      <button id="chartPng" class="secondary" title="Save the chart as a PNG image">Export PNG</button>
    </div>
    <div class="row chart-fields">
      <label for="chartX" id="chartXLabel">Category</label>
      <input id="chartX" list="chartFieldList" spellcheck="false" placeholder="field">
      <select id="chartUnit" title="Group the dates of the category by" aria-label="Group dates by">
        <option value="">exact values</option><option value="hour">by hour</option><option value="day">by day</option><option value="week">by week</option><option value="month">by month</option><option value="year">by year</option>
      </select>
      <label for="chartAgg" id="chartAggLabel">Value</label>
      <select id="chartAgg">
        <option value="count">count</option><option value="sum">sum of</option><option value="avg">average of</option><option value="min">minimum of</option><option value="max">maximum of</option>
      </select>
      <label for="chartY" id="chartYLabel" class="hidden">Y</label>
      <input id="chartY" list="chartFieldList" spellcheck="false" placeholder="field">
      <label for="chartSeries" id="chartSeriesLabel">Series</label>
      <input id="chartSeries" list="chartFieldList" spellcheck="false" placeholder="none" title="A field splitting the data into series (up to 12)">
      <label for="chartLimit" id="chartLimitLabel">Top</label>
      <input id="chartLimit" type="number" min="1">
      <button id="chartDraw" class="primary" title="Draw the chart (Enter)">Draw</button>
      <datalist id="chartFieldList"></datalist>
    </div>
    <div id="chartInfo" class="chart-info chart-muted"></div>
    <div class="chart-wrap" id="chartWrap">
      <canvas id="chartCanvas" role="img" aria-label="Chart"></canvas>
      <div id="chartEmpty" class="empty hidden"></div>
    </div>
  </section>
  <section class="indexes-only indexes-view" id="indexesView">
    <div class="row index-head">
      <button id="newIndex" class="primary editable" title="Create an index on the collection">Create index…</button>
      <button id="refreshIndexes" class="secondary" title="Read the indexes, their sizes and their usage again">Refresh</button>
      <span id="indexSummary" class="index-summary"></span>
    </div>
    <div id="indexMessage" class="hidden"></div>
    <table id="indexTable" class="grid index-table"></table>
  </section>
  <div class="statusbar">
    <span id="status"></span>
    <span class="spacer"></span>
    <button id="columnsBtn" class="secondary columns-btn" title="Show, hide, pin and reorder the columns" aria-haspopup="true" aria-expanded="false">Columns</button>
    <span class="status-group">
    <label for="limit">Page size</label>
    <select id="limit">
      <option>10</option><option>20</option><option selected>50</option><option>100</option><option>200</option><option>500</option>
    </select>
    </span>
    <span class="status-group">
    <button id="prev" class="icon" title="Previous page">‹</button>
    <span id="range"></span>
    <button id="next" class="icon" title="Next page">›</button>
    </span>
  </div>
  <div id="columnsPanel" class="columns-panel hidden" role="dialog" aria-label="Columns">
    <div class="columns-head">
      <input id="columnsSearch" spellcheck="false" placeholder="Search columns">
      <button id="columnsShowAll" class="secondary" title="Show the hidden columns">Show all</button>
      <button id="columnsReset" class="secondary" title="Natural order, no hidden or pinned columns, automatic widths">Reset</button>
    </div>
    <div id="columnsList" class="columns-list"></div>
  </div>
  <div id="columnMenu" class="context-menu hidden" role="menu"></div>
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
  <div id="codeModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box code-box">
      <div class="modal-head">
        <span id="codeTitle" class="doc-title">Code</span>
        <span class="spacer"></span>
        <button id="codeClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="code-options">
        <div id="codeLangs" class="mode" role="tablist" aria-label="Language"></div>
        <label title="Imports, connection (MONGODB_URI) and printing the results"><input id="codeProgram" type="checkbox"> Full program</label>
      </div>
      <div id="codeError" class="error hidden"></div>
      <pre id="codeText" class="code-text"></pre>
      <div class="bulk-actions">
        <button id="codeOpen" class="secondary" title="Open the code in a new editor tab">Open in Editor</button>
        <button id="codeCopy" class="primary">Copy</button>
      </div>
    </div>
  </div>
  <div id="bulkModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box bulk-box">
      <div class="modal-head">
        <span id="bulkTitle" class="doc-title">Update many</span>
        <span class="spacer"></span>
        <button id="bulkClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="bulk-body">
        <span class="bulk-label">Filter</span>
        <code id="bulkFilter" class="bulk-filter"></code>
        <label for="bulkUpdate" class="bulk-label bulk-update">Update</label>
        <textarea id="bulkUpdate" class="bulk-update" rows="4" spellcheck="false" placeholder="{ $set: { status: &quot;archived&quot; }, $inc: { version: 1 } }  —  or a pipeline [ { $set: … } ]"></textarea>
        <div id="bulkCount" class="bulk-count"></div>
        <div id="bulkError" class="bulk-error error hidden"></div>
      </div>
      <div class="bulk-actions">
        <button id="bulkCancel" class="secondary">Cancel</button>
        <button id="bulkApply" class="primary" title="Ctrl+Enter">Update</button>
      </div>
    </div>
  </div>
  <div id="indexModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box index-box">
      <div class="modal-head">
        <span id="indexTitle" class="doc-title">Create index</span>
        <span class="spacer"></span>
        <div class="mode" role="tablist" aria-label="Edit the index as">
          <button id="indexModeForm" role="tab" aria-selected="true" title="Fields, types and the common options">Form</button>
          <button id="indexModeText" role="tab" aria-selected="false" title="The keys and options as createIndex takes them">Text</button>
        </div>
        <button id="indexClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="index-body">
        <div id="indexForm" class="index-form">
          <div class="index-section">Fields</div>
          <div id="indexFields" class="index-fields"></div>
          <div><button id="indexAddField" class="secondary" title="Add a field: a compound index follows the order of its fields">+ Field</button></div>
          <datalist id="indexFieldList"></datalist>
          <div class="index-section">Options</div>
          <div class="index-options">
            <label for="indexName">Name</label>
            <input id="indexName" spellcheck="false">
            <label class="index-check"><input id="indexUnique" type="checkbox"> Unique</label>
            <span class="index-hint">No two documents can have the same value in the indexed fields.</span>
            <label class="index-check"><input id="indexSparse" type="checkbox"> Sparse</label>
            <span class="index-hint">Only documents that have the indexed fields are in the index.</span>
            <label class="index-check"><input id="indexHidden" type="checkbox"> Hidden</label>
            <span class="index-hint">Kept up to date, but not used by queries.</span>
            <label class="index-check" title="On a single date field: the server deletes the documents when they expire"><input id="indexTtl" type="checkbox"> TTL</label>
            <span class="index-inline">
              <span class="index-hint">Documents are deleted</span>
              <input id="indexTtlValue" type="number" min="0" aria-label="Time before the documents expire">
              <select id="indexTtlUnit" aria-label="Unit"></select>
              <span class="index-hint">after the date in the field.</span>
            </span>
            <label class="index-check" title="partialFilterExpression"><input id="indexPartial" type="checkbox"> Partial</label>
            <textarea id="indexPartialFilter" rows="1" spellcheck="false" placeholder="{ status: &quot;active&quot; }  —  only the documents matching this filter are in the index" aria-label="Partial filter"></textarea>
            <label class="index-check" title="Language rules for comparing strings: queries must ask for the same collation to use the index"><input id="indexCollation" type="checkbox"> Collation</label>
            <input id="indexCollationValue" spellcheck="false" placeholder="{ locale: &quot;en&quot;, strength: 2 }" aria-label="Collation">
            <label for="indexLanguage" class="text-only" title="default_language of a text index">Language</label>
            <input id="indexLanguage" class="text-only" spellcheck="false" placeholder="english">
            <label for="indexMore" title="Any other option of createIndex">More options</label>
            <textarea id="indexMore" rows="1" spellcheck="false" placeholder="{ wildcardProjection: { … }, language_override: &quot;…&quot;, bits: 26, … }"></textarea>
          </div>
        </div>
        <div id="indexText" class="index-options hidden">
          <label for="indexKeys">Keys</label>
          <textarea id="indexKeys" rows="3" spellcheck="false" placeholder="{ status: 1, createdAt: -1 }"></textarea>
          <label for="indexOptions">Options</label>
          <textarea id="indexOptions" rows="6" spellcheck="false" placeholder="{ unique: true, name: &quot;…&quot;, expireAfterSeconds: 3600, partialFilterExpression: { … } }"></textarea>
        </div>
        <div class="index-section">Command</div>
        <pre id="indexPreview" class="index-preview"></pre>
        <div id="indexWarnings" class="index-plan warn hidden"></div>
        <div id="indexPlan" class="index-plan hidden"></div>
        <div id="indexError" class="error hidden"></div>
      </div>
      <div class="bulk-actions">
        <button id="indexCopy" class="secondary" title="Copy the mongosh command that creates the index">Copy command</button>
        <span class="spacer"></span>
        <button id="indexCancel" class="secondary">Cancel</button>
        <button id="indexSave" class="primary" title="Ctrl+Enter">Create index</button>
      </div>
    </div>
  </div>
  <div id="explainModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box explain-box">
      <div class="modal-head">
        <span id="explainTitle" class="doc-title">Explain</span>
        <span class="spacer"></span>
        <button id="explainRaw" class="secondary" title="Toggle the full explain output">Raw</button>
        <button id="explainClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="modal-body" id="explainBody"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
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
