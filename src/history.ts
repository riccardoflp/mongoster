// Undo history: before a write Mongoster keeps the documents it changes (only the _id of those it
// inserts) in a gzip file per operation under the extension's global storage, so the write can be
// undone later, also after restarting VS Code. Limits on total size, age and number of operations keep
// the folder small (the oldest operations go first), and operations too large aren't recorded: their
// confirmation says they can't be undone.
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { gunzip, gzip } from 'zlib';
import { createHash } from 'crypto';
import { AnyBulkWriteOperation, BSON, Collection, Document, MongoBulkWriteError } from 'mongodb';
import type { ConnectionManager } from './connections';
import { fieldDiff, FieldDiff } from './shared/compare';
import { relaxEjson, toShell } from './shared/query';
import type { HistoryDocument, HistoryEntry, HistoryHostMessage, HistoryUsage, HistoryViewMessage } from './shared/messages';

const { EJSON } = BSON;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MB = 1024 * 1024;
const DAY = 86_400_000;
const INDEX = 'index.json';
const BATCH = 1000;
/** Documents shown in the details of an operation. */
const DETAILS = 100;
/** promoteValues: false and bsonRegExp keep every value exactly as stored, to put it back as it was. */
const READ = { promoteValues: false, bsonRegExp: true } as const;

export interface HistoryTarget {
  connectionId: string;
  database: string;
  collection: string;
}

export interface HistoryLimits {
  enabled: boolean;
  maxBytes: number;
  maxDays: number;
  maxEntries: number;
  maxDocuments: number;
  maxOperationBytes: number;
}

export function historyLimits(): HistoryLimits {
  const config = vscode.workspace.getConfiguration('mongoster.history');
  const num = (key: string, fallback: number) => {
    const v = config.get<number>(key);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    enabled: config.get<boolean>('enabled', true) !== false,
    maxBytes: num('maxSizeMB', 100) * MB,
    maxDays: num('maxDays', 7),
    maxEntries: num('maxOperations', 200),
    maxDocuments: num('maxDocumentsPerOperation', 10_000),
    maxOperationBytes: num('maxOperationSizeMB', 20) * MB,
  };
}

const canonical = (v: unknown) => (EJSON.serialize({ v }, { relaxed: false }) as { v: unknown }).v;
const keyOf = (id: unknown) => JSON.stringify(canonical(id));
/** Fingerprint of a document as stored (read with READ); null when it doesn't exist. */
const fingerprint = (doc: Document | undefined | null) => (doc ? createHash('sha1').update(BSON.serialize(doc)).digest('base64') : null);
const count = (n: number, what: string) => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A document touched by a write: as it was before (null: the write inserted it) and its fingerprint after. */
interface Recorded {
  id: unknown;
  before: Document | null;
  after?: string | null;
}

/** The documents of `ids` as they are now, by key. */
async function fetchByIds(coll: Collection, ids: unknown[]): Promise<Map<string, Document>> {
  const out = new Map<string, Document>();
  for (let i = 0; i < ids.length; i += BATCH) {
    const docs = await coll.find({ _id: { $in: ids.slice(i, i + BATCH) } } as Document, READ).toArray();
    for (const doc of docs) out.set(keyOf(doc._id), doc);
  }
  return out;
}

/** Collects what one write changes; `commit` saves it once the write is done. */
export class Recorder {
  private readonly docs = new Map<string, Recorded>();
  private bytes = 0;
  /** Why the operation isn't recorded (too large), once known. */
  overflow?: string;

  constructor(
    private readonly history: UndoHistory,
    readonly target: HistoryTarget,
    readonly label: string,
    private readonly limits: HistoryLimits,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  ids(): unknown[] {
    return [...this.docs.values()].map((d) => d.id);
  }

  /** Keeps a document as it is before the write (the first image of a document wins). */
  add(doc: Document): boolean {
    if (this.overflow) return false;
    const key = keyOf(doc._id);
    if (this.docs.has(key)) return true;
    this.docs.set(key, { id: doc._id, before: doc });
    this.bytes += BSON.calculateObjectSize(doc);
    return this.check();
  }

  /** Marks a document the write inserts: undoing deletes it. */
  addNew(id: unknown): boolean {
    if (this.overflow) return false;
    if (id === undefined) return true;
    const key = keyOf(id);
    if (this.docs.has(key)) return true;
    this.docs.set(key, { id, before: null });
    this.bytes += BSON.calculateObjectSize({ _id: id });
    return this.check();
  }

  /** Forgets documents the write didn't touch after all (e.g. failed inserts). */
  forget(id: unknown): void {
    this.docs.delete(keyOf(id));
  }

  private check(): boolean {
    if (this.docs.size > this.limits.maxDocuments) this.overflow = `more than ${count(this.limits.maxDocuments, 'document')}`;
    else if (this.bytes > this.limits.maxOperationBytes) this.overflow = `more than ${Math.round(this.limits.maxOperationBytes / MB)} MB`;
    if (this.overflow) this.docs.clear();
    return !this.overflow;
  }

  /** Keeps the documents matching `filter` as they are before the write. False when they're too many. */
  async snapshot(coll: Collection, filter: Document): Promise<boolean> {
    const cursor = coll.find(filter, READ);
    try {
      for await (const doc of cursor) if (!this.add(doc)) return false;
    } finally {
      await cursor.close();
    }
    return true;
  }

  /** Keeps the documents with these _ids as they are before the write; those not found are marked as inserted. */
  async snapshotIds(coll: Collection, ids: unknown[]): Promise<boolean> {
    const found = await fetchByIds(coll, ids);
    for (const id of ids) {
      const doc = found.get(keyOf(id));
      if (!(doc ? this.add(doc) : this.addNew(id))) return false;
    }
    return true;
  }

  /**
   * Saves the record, after the write. Documents the write left as they were are dropped; returns the
   * entry, or undefined when nothing was recorded.
   */
  async commit(coll: Collection, undoOf?: string): Promise<HistoryEntry | undefined> {
    if (this.overflow || !this.docs.size) return undefined;
    try {
      const list = [...this.docs.values()];
      const after = await fetchByIds(coll, list.map((d) => d.id));
      for (const d of list) d.after = fingerprint(after.get(keyOf(d.id)));
      return await this.history.save(this, list, undoOf);
    } catch (err) {
      void vscode.window.showWarningMessage(`The change was made, but couldn't be saved in the undo history: ${errorText(err)}`);
      return undefined;
    }
  }
}

export class UndoHistory implements vscode.Disposable {
  private static current: UndoHistory | undefined;
  /** Newest first. */
  private entries: HistoryEntry[] = [];
  private readonly loaded: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  static init(context: vscode.ExtensionContext, connections: ConnectionManager): UndoHistory {
    UndoHistory.current = new UndoHistory(path.join(context.globalStorageUri.fsPath, 'history'), connections);
    return UndoHistory.current;
  }

  static get(): UndoHistory | undefined {
    return UndoHistory.current;
  }

  /**
   * Starts recording a write on `target`; undefined when the history is off for its connection or the
   * `expected` documents are more than an operation may record.
   */
  static start(target: HistoryTarget, label: string, expected = 1): Recorder | undefined {
    const history = UndoHistory.current;
    const limits = historyLimits();
    if (!history?.recording(target.connectionId, limits) || expected > limits.maxDocuments) return undefined;
    return new Recorder(history, target, label, limits);
  }

  /** The line of a write's confirmation telling whether it can be undone. */
  static note(connectionId: string, documents: number): string {
    const limits = historyLimits();
    if (!UndoHistory.current?.recording(connectionId, limits)) return "The undo history is off for this connection: this can't be undone.";
    if (documents > limits.maxDocuments) return `This can't be undone: the undo history keeps operations of up to ${count(limits.maxDocuments, 'document')}.`;
    return 'It can be undone from the Undo History.';
  }

  /** Shows the result of a write, with an Undo button when it was recorded. */
  static notify(message: string, entry: HistoryEntry | undefined): void {
    if (!entry) {
      void vscode.window.showInformationMessage(message);
      return;
    }
    void vscode.window.showInformationMessage(message, 'Undo').then((answer) => {
      if (answer === 'Undo') void UndoHistory.current?.undoAndReport(entry.id);
    });
  }

  private constructor(
    private readonly dir: string,
    private readonly connections: ConnectionManager,
  ) {
    this.loaded = this.load();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('mongoster.history')) return;
        void this.exclusive(() => this.prune()).then(() => this.changeEmitter.fire());
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    if (UndoHistory.current === this) UndoHistory.current = undefined;
  }

  /** Whether writes through the connection are recorded. */
  recording(connectionId: string, limits = historyLimits()): boolean {
    const info = this.connections.get(connectionId);
    return limits.enabled && !!info && !info.noHistory && !info.readOnly;
  }

  async list(): Promise<HistoryEntry[]> {
    await this.loaded;
    return this.entries.map((e) => ({ ...e, connectionName: this.connections.get(e.connectionId)?.name ?? e.connectionName }));
  }

  usage(): HistoryUsage {
    const limits = historyLimits();
    return {
      bytes: this.entries.reduce((sum, e) => sum + e.size, 0),
      maxBytes: limits.maxBytes,
      maxDays: limits.maxDays,
      maxEntries: limits.maxEntries,
      maxDocuments: limits.maxDocuments,
    };
  }

  /** Runs `fn` after the load and any change in progress: index and files are changed one at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.loaded).then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json.gz`);
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(this.dir, INDEX), 'utf8'));
      this.entries = Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
    } catch {
      this.entries = [];
    }
    await this.prune(true).catch(() => undefined);
  }

  private async writeIndex(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `${INDEX}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(this.entries));
    await fs.rename(tmp, path.join(this.dir, INDEX));
  }

  /**
   * Applies the limits, oldest operations first: the first (newest to oldest) that is too old or doesn't
   * fit drops every older one too. `orphans` also removes files without an entry and entries without a file.
   */
  private async prune(orphans = false): Promise<void> {
    const limits = historyLimits();
    let files: Set<string> | undefined;
    if (orphans) {
      files = new Set(await fs.readdir(this.dir).catch(() => [] as string[]));
      this.entries = this.entries.filter((e) => !e.size || files!.has(`${e.id}.json.gz`));
    }
    const cutoff = Date.now() - limits.maxDays * DAY;
    const keep: HistoryEntry[] = [];
    let bytes = 0;
    for (const e of [...this.entries].sort((a, b) => b.time - a.time)) {
      if (e.time < cutoff || keep.length >= limits.maxEntries || bytes + e.size > limits.maxBytes) break;
      keep.push(e);
      bytes += e.size;
    }
    const dropped = this.entries.filter((e) => !keep.includes(e));
    this.entries = keep;
    for (const e of dropped) await fs.rm(this.file(e.id), { force: true });
    if (files) {
      const known = new Set(keep.map((e) => `${e.id}.json.gz`));
      for (const f of files) if (f.endsWith('.json.gz') && !known.has(f)) await fs.rm(path.join(this.dir, f), { force: true });
    }
    if (dropped.length || files?.size) await this.writeIndex();
  }

  /** Writes the record of a write; returns its entry, unless the limits dropped it right away. */
  async save(rec: Recorder, docs: Recorded[], undoOf?: string): Promise<HistoryEntry | undefined> {
    // Documents the write didn't change (updated to the same values, failed inserts) can't be undone.
    const changed = docs.filter((d) => (d.before ? d.after !== fingerprint(d.before) : d.after !== null));
    if (!changed.length) return undefined;
    const entry: HistoryEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      time: Date.now(),
      connectionId: rec.target.connectionId,
      connectionName: this.connections.get(rec.target.connectionId)?.name ?? '?',
      database: rec.target.database,
      collection: rec.target.collection,
      label: rec.label,
      inserted: changed.filter((d) => !d.before).length,
      updated: changed.filter((d) => d.before && d.after !== null).length,
      deleted: changed.filter((d) => d.before && d.after === null).length,
      size: 0,
      ...(undoOf && { undoOf }),
    };
    const text = EJSON.stringify({ docs: changed.map((d) => ({ id: d.id, before: d.before, after: d.after })) }, { relaxed: false });
    const data = await gzipAsync(Buffer.from(text, 'utf8'));
    entry.size = data.length;
    await this.exclusive(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.file(entry.id), data);
      this.entries.unshift(entry);
      await this.prune();
      await this.writeIndex();
    });
    this.changeEmitter.fire();
    return this.entries.includes(entry) ? entry : undefined;
  }

  /** Removes the entries matching `which` (all of them by default) and their files. */
  async clear(which: (e: HistoryEntry) => boolean = () => true): Promise<number> {
    const removed = await this.exclusive(async () => {
      const gone = this.entries.filter(which);
      if (!gone.length) return 0;
      this.entries = this.entries.filter((e) => !gone.includes(e));
      for (const e of gone) await fs.rm(this.file(e.id), { force: true });
      await this.writeIndex();
      return gone.length;
    });
    if (removed) this.changeEmitter.fire();
    return removed;
  }

  private async read(entry: HistoryEntry): Promise<Recorded[]> {
    const data = await gunzipAsync(await fs.readFile(this.file(entry.id)));
    return (EJSON.parse(data.toString('utf8'), { relaxed: false }) as { docs: Recorded[] }).docs;
  }

  private async open(id: string): Promise<{ entry: HistoryEntry; where: string; coll: Collection; docs: Recorded[] }> {
    await this.loaded;
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error('This operation is no longer in the undo history.');
    if (entry.undone) throw new Error('This operation was already undone.');
    const info = this.connections.get(entry.connectionId);
    if (!info) throw new Error(`The connection ${entry.connectionName} no longer exists.`);
    const docs = await this.read(entry);
    const coll = (await this.connections.getClient(entry.connectionId)).db(entry.database).collection(entry.collection);
    return { entry, where: `${info.name} › ${entry.database}.${entry.collection}`, coll, docs };
  }

  /** What undoing an operation would do to (the first DETAILS of) its documents. */
  async details(id: string): Promise<{ documents: HistoryDocument[]; total: number }> {
    const { coll, docs } = await this.open(id);
    const shown = docs.slice(0, DETAILS);
    const current = await fetchByIds(coll, shown.map((d) => d.id));
    const opts = { ignore: [], ignoreOrder: false, numbersByValue: false };
    const documents = shown.map((d): HistoryDocument => {
      const doc = current.get(keyOf(d.id));
      const now = doc ? canonical(doc) : undefined;
      const then = d.before ? canonical(d.before) : undefined;
      let fields: FieldDiff[] = [];
      if (now !== undefined && then !== undefined) fields = fieldDiff(now, then, opts, relaxEjson);
      else if (now !== undefined) fields = [{ path: '(document)', left: relaxEjson(now) }];
      else if (then !== undefined) fields = [{ path: '(document)', right: relaxEjson(then) }];
      return {
        id: toShell(relaxEjson(canonical(d.id))),
        kind: !d.before ? 'inserted' : d.after === null ? 'deleted' : 'updated',
        changed: fingerprint(doc) !== d.after,
        fields,
      };
    });
    return { documents, total: docs.length };
  }

  /**
   * Puts the documents of an operation back as they were, after confirmation (which warns about those
   * changed since). The undo is recorded in turn, so it can be undone too.
   */
  async undo(id: string): Promise<{ ok: boolean; message?: string; entry?: HistoryEntry }> {
    let opened: Awaited<ReturnType<UndoHistory['open']>>;
    try {
      opened = await this.open(id);
    } catch (err) {
      return { ok: false, message: errorText(err) };
    }
    const { entry, where, coll, docs } = opened;
    const info = this.connections.get(entry.connectionId);
    if (info?.readOnly) return { ok: false, message: `The connection ${info.name} is read-only: nothing can be undone through it.` };
    const current = await fetchByIds(coll, docs.map((d) => d.id));
    const changed = new Set(docs.filter((d) => fingerprint(current.get(keyOf(d.id))) !== d.after));
    const what = [
      entry.inserted ? `deletes ${count(entry.inserted, 'inserted document')}` : '',
      entry.updated ? `restores ${count(entry.updated, 'updated document')}` : '',
      entry.deleted ? `inserts again ${count(entry.deleted, 'deleted document')}` : '',
    ].filter(Boolean);
    const detail = [
      `The undo ${what.join(', ')}.`,
      changed.size
        ? `${changed.size === docs.length ? (docs.length === 1 ? 'The document' : 'All of them') : `${changed.size.toLocaleString('en-US')} of them`} changed after the operation: undoing overwrites those changes too.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const buttons = !changed.size ? ['Undo'] : changed.size === docs.length ? ['Undo Anyway'] : ['Undo All', 'Undo Unchanged Only'];
    const answer = await vscode.window.showWarningMessage(`Undo "${entry.label}" in ${where}?`, { modal: true, detail }, ...buttons);
    if (!answer || !buttons.includes(answer)) return { ok: false };
    const chosen = answer === 'Undo Unchanged Only' ? docs.filter((d) => !changed.has(d)) : docs;

    const label = entry.label.startsWith('Undo: ') ? `Redo: ${entry.label.slice(6)}` : entry.label.startsWith('Redo: ') ? `Undo: ${entry.label.slice(6)}` : `Undo: ${entry.label}`;
    const rec = UndoHistory.start(entry, label, chosen.length);
    for (const d of chosen) {
      const doc = current.get(keyOf(d.id));
      if (doc) rec?.add(doc);
      else rec?.addNew(d.id);
    }
    const ops = chosen.map((d): AnyBulkWriteOperation =>
      d.before ? { replaceOne: { filter: { _id: d.id } as Document, replacement: d.before, upsert: true } } : { deleteOne: { filter: { _id: d.id } as Document } },
    );
    let failed = 0;
    let firstError = '';
    for (let i = 0; i < ops.length; i += BATCH) {
      try {
        await coll.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
      } catch (err) {
        if (!(err instanceof MongoBulkWriteError)) throw err;
        const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
        failed += errors.length;
        firstError ||= errors[0]?.errmsg ?? err.message;
      }
    }
    const undoEntry = await rec?.commit(coll, entry.id);
    if (failed) {
      // The writes are idempotent: the operation stays in the history to try again.
      return { ok: false, entry: undoEntry, message: `Undo of "${entry.label}" incomplete: ${count(failed, 'document')} of ${chosen.length.toLocaleString('en-US')} failed: ${firstError}` };
    }
    await this.exclusive(async () => {
      entry.undone = Date.now();
      await fs.rm(this.file(entry.id), { force: true });
      entry.size = 0;
      await this.writeIndex();
    });
    this.changeEmitter.fire();
    return { ok: true, entry: undoEntry, message: `Undid "${entry.label}": ${count(chosen.length, 'document')} in ${where}.` };
  }

  /** Undoes and shows the result in a notification. */
  async undoAndReport(id: string): Promise<boolean> {
    try {
      const result = await this.undo(id);
      if (result.ok) {
        UndoHistory.notify(result.message!, result.entry);
        void vscode.commands.executeCommand('mongoster.refresh');
      } else if (result.message) void vscode.window.showErrorMessage(result.message);
      return result.ok;
    } catch (err) {
      void vscode.window.showErrorMessage(`Undo failed: ${errorText(err)}`);
      return false;
    }
  }

  /** The newest operation that can still be undone. */
  async last(): Promise<HistoryEntry | undefined> {
    await this.loaded;
    return this.entries.find((e) => !e.undone);
  }
}

/** The Undo History tab: recorded operations, what undoing each one does, and the space they take. */
export class HistoryPanel {
  private static instance: HistoryPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, history: UndoHistory): void {
    if (HistoryPanel.instance) HistoryPanel.instance.panel.reveal();
    else HistoryPanel.instance = new HistoryPanel(context, history);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly history: UndoHistory,
  ) {
    this.panel = vscode.window.createWebviewPanel('mongoster.history', 'Undo History', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.disposables.push(history.onDidChange(() => void this.postInit()));
    this.panel.onDidDispose(() => {
      HistoryPanel.instance = undefined;
      this.disposables.forEach((d) => d.dispose());
    });
    this.panel.webview.onDidReceiveMessage((m: HistoryViewMessage) => void this.receive(m));
  }

  private post(m: HistoryHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private async postInit(): Promise<void> {
    this.post({ type: 'init', entries: await this.history.list(), usage: this.history.usage(), enabled: historyLimits().enabled });
  }

  private async receive(m: HistoryViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.postInit();
        break;
      case 'details':
        try {
          this.post({ type: 'details', id: m.id, ...(await this.history.details(m.id)) });
        } catch (err) {
          this.post({ type: 'details', id: m.id, error: errorText(err) });
        }
        break;
      case 'undo':
        try {
          const result = await this.history.undo(m.id);
          if (result.message) this.post({ type: 'message', text: result.message, failed: !result.ok });
          if (result.ok) void vscode.commands.executeCommand('mongoster.refresh');
        } catch (err) {
          this.post({ type: 'message', text: `Undo failed: ${errorText(err)}`, failed: true });
        }
        break;
      case 'remove':
        await this.history.clear((e) => e.id === m.id);
        break;
      case 'clear': {
        const entries = await this.history.list();
        if (!entries.length) return;
        const answer = await vscode.window.showWarningMessage(
          `Clear the undo history?`,
          { modal: true, detail: `${count(entries.length, 'operation')} can then no longer be undone.` },
          'Clear History',
        );
        if (answer === 'Clear History') await this.history.clear();
        break;
      }
      case 'settings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'mongoster.history');
        break;
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
  <link rel="stylesheet" href="${asset('media', 'monitor.css')}">
  <link rel="stylesheet" href="${asset('media', 'undoHistory.css')}">
  <title>Undo History</title>
</head>
<body>
  <header class="bar">
    <span class="title">Undo History</span>
    <input id="search" type="search" placeholder="Filter by connection, collection or operation" spellcheck="false">
    <span id="summary" class="info"></span>
    <div class="spacer"></div>
    <button id="settings" class="secondary" title="Limits of the undo history: size, age, operations">Settings</button>
    <button id="clear" class="secondary" title="Delete every saved operation">Clear History…</button>
  </header>
  <div id="off" class="message notice hidden">The undo history is off (setting <code>mongoster.history.enabled</code>): new changes aren't recorded.</div>
  <div id="message" class="message hidden"></div>
  <div class="table-wrap list"><table id="entries"></table></div>
  <script nonce="${nonce}" src="${asset('dist', 'undoHistory.js')}"></script>
</body>
</html>`;
  }
}
