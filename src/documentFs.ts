import * as vscode from 'vscode';
import { BSON, Document, Filter } from 'mongodb';
import { ConnectionManager } from './connections';
import { errorMessage } from './tree';
import { UndoHistory } from './history';
import { RedisOplog } from './redisOplog';
import { documentFields } from './shared/oplog';
import { isPlainObject, parseQuery, relaxEjson, toShell } from './shared/query';

const { EJSON } = BSON;

export const DOC_SCHEME = 'mongoster';

export interface CollectionRef {
  connectionId: string;
  database: string;
  collection: string;
  readOnly?: boolean;
}

interface Entry {
  ref: CollectionRef;
  /** BSON _id; undefined for a new document that hasn't been inserted yet. */
  id?: unknown;
  /** Document as last read from the database (promoteValues: false), for type restoration and conflict checks. */
  original?: Document;
  /** Initial text of a new, not yet inserted document. */
  draft?: string;
  mtime: number;
}

/**
 * Exposes documents as editable JSON files:
 *   mongoster://<connectionId>/<db>/<collection>/<label>.json?id=<canonical EJSON>
 * Saving the editor writes the document back with replaceOne (or insertOne for new documents).
 */
export class DocumentFileSystem implements vscode.FileSystemProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly fileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.fileEmitter.event;
  private readonly savedEmitter = new vscode.EventEmitter<CollectionRef>();
  /** Fired after a document of a collection was inserted or replaced. */
  readonly onDidSave = this.savedEmitter.event;
  private newCounter = 0;

  constructor(private readonly connections: ConnectionManager) {}

  async open(ref: CollectionRef, id: unknown): Promise<void> {
    const params = new URLSearchParams({ id: EJSON.stringify({ _id: id }, { relaxed: false }) });
    if (ref.readOnly) params.set('ro', '1');
    await show(documentUri(ref, `${fileLabel(id)}.json`, params));
  }

  async openNew(ref: CollectionRef, draft = '{\n  \n}\n'): Promise<void> {
    const uri = documentUri(ref, `new-${++this.newCounter}.json`, new URLSearchParams({ new: '1' }));
    this.entries.set(uri.toString(), { ref, draft, mtime: Date.now() });
    await show(uri);
  }

  // ---- FileSystemProvider

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.entry(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: entry.mtime,
      size: 0,
      permissions: entry.ref.readOnly ? vscode.FilePermission.Readonly : undefined,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const entry = this.entry(uri);
    if (entry.id === undefined) return encode(entry.draft ?? '{\n  \n}\n');
    const doc = await (await this.collection(entry.ref)).findOne(byId(entry.id), { promoteValues: false });
    if (!doc) throw vscode.FileSystemError.FileNotFound(uri);
    entry.original = doc;
    return encode(formatDocument(doc));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const entry = this.entry(uri);
    if (entry.ref.readOnly) throw vscode.FileSystemError.NoPermissions('Read-only: a view, or a read-only connection');

    let parsed: unknown;
    try {
      parsed = parseQuery(new TextDecoder().decode(content));
    } catch (err) {
      throw new Error(`Invalid document: ${errorMessage(err)}`);
    }
    if (!isPlainObject(parsed)) throw new Error('A document must be a JSON object');
    const doc = restoreTypes(EJSON.deserialize(parsed, { relaxed: false }), entry.original) as Document;
    const coll = await this.collection(entry.ref);
    const sink = RedisOplog.sink(entry.ref);

    if (entry.id === undefined) {
      const rec = UndoHistory.start(entry.ref, 'Insert document');
      const { insertedId } = await coll.insertOne(doc);
      entry.id = insertedId;
      rec?.addNew(insertedId);
      sink?.inserted([insertedId]);
      await rec?.commit(coll);
      void vscode.window.showInformationMessage(`Inserted document ${toShell(relaxed(insertedId))}`);
    } else {
      const rec = UndoHistory.start(entry.ref, `Edit document ${toShell(relaxed(entry.id))}`);
      if ('_id' in doc && !sameBson(doc._id, entry.id)) {
        throw new Error('_id cannot be changed. Use Duplicate to create a copy with a new _id.');
      }
      const current = await coll.findOne(byId(entry.id), { promoteValues: false });
      if (!current) {
        const choice = await vscode.window.showWarningMessage(
          'This document was deleted from the database after you opened it.',
          { modal: true },
          'Insert Again',
        );
        if (choice !== 'Insert Again') throw new Error('Save cancelled: the document no longer exists.');
        await coll.insertOne({ ...doc, _id: entry.id } as Document);
        rec?.addNew(entry.id);
        sink?.inserted([entry.id]);
      } else {
        if (entry.original && !sameBson(current, entry.original)) {
          const choice = await vscode.window.showWarningMessage(
            'This document was changed in the database after you opened it.',
            { modal: true, detail: 'Overwrite replaces those changes with yours. Revert the file to load the latest version instead.' },
            'Overwrite',
          );
          if (choice !== 'Overwrite') throw new Error('Save cancelled: the document changed in the database.');
        }
        await rec?.snapshotIds(coll, [entry.id]);
        const res = await coll.replaceOne(byId(entry.id), doc);
        if (res.modifiedCount) sink?.updated([entry.id], documentFields(current, doc));
      }
      await rec?.commit(coll);
    }

    entry.original = (await coll.findOne(byId(entry.id), { promoteValues: false })) ?? undefined;
    entry.mtime = Date.now();
    this.savedEmitter.fire(entry.ref);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  // ---- helpers

  private entry(uri: vscode.Uri): Entry {
    const key = uri.toString();
    let entry = this.entries.get(key);
    if (!entry) {
      // Not opened in this session (e.g. a tab restored after a reload): rebuild from the URI.
      const [database, collection] = uri.path.split('/').slice(1, 3).map(decodeURIComponent);
      const params = new URLSearchParams(uri.query);
      const idJson = params.get('id');
      entry = {
        ref: { connectionId: uri.authority, database, collection, readOnly: params.get('ro') === '1' },
        id: idJson ? EJSON.parse(idJson, { relaxed: false })._id : undefined,
        mtime: Date.now(),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async collection(ref: CollectionRef) {
    const client = await this.connections.getClient(ref.connectionId);
    return client.db(ref.database).collection(ref.collection);
  }
}

/** Filter matching a document by its (arbitrarily typed) _id. */
export function byId(id: unknown): Filter<Document> {
  return { _id: id } as Filter<Document>;
}

function documentUri(ref: CollectionRef, file: string, params: URLSearchParams): vscode.Uri {
  return vscode.Uri.from({
    scheme: DOC_SCHEME,
    authority: ref.connectionId,
    path: `/${encodeURIComponent(ref.database)}/${encodeURIComponent(ref.collection)}/${file}`,
    query: params.toString(),
  });
}

async function show(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A BSON value as relaxed EJSON, as the webview sees it. */
export function relaxed(value: unknown): unknown {
  return (relaxEjson(EJSON.serialize({ v: value }, { relaxed: false })) as { v: unknown }).v;
}

/** Pretty relaxed EJSON, as shown in the editor. */
export function formatDocument(doc: Document): string {
  return JSON.stringify(relaxEjson(EJSON.serialize(doc, { relaxed: false })), null, 2) + '\n';
}

function fileLabel(id: unknown): string {
  const text = id instanceof BSON.ObjectId ? id.toHexString() : toShell(relaxed(id));
  return text.replace(/[\\/:*?"<>|#%\s]+/g, '_').slice(0, 60) || 'document';
}

function sameBson(a: unknown, b: unknown): boolean {
  return Buffer.from(BSON.serialize({ v: a })).equals(Buffer.from(BSON.serialize({ v: b })));
}

const NUMERIC_TYPES = new Set(['Int32', 'Double', 'Long']);

/**
 * Relaxed JSON loses the distinction between Int32, Double and small Longs: a plain number comes back
 * as Int32 when integral, Double otherwise. Keep each field's original numeric type so saving doesn't
 * silently change it — unless the user explicitly wrote another type (e.g. NumberLong(...)).
 */
export function restoreTypes(next: unknown, prev: unknown): unknown {
  const typeOf = (v: unknown) => (v as { _bsontype?: string } | null)?._bsontype;
  const nextType = typeOf(next);
  const prevType = typeOf(prev);
  if (nextType && prevType && NUMERIC_TYPES.has(nextType) && NUMERIC_TYPES.has(prevType)) {
    // Only plain JSON numbers are ambiguous; NumberLong(...) etc. are an explicit choice.
    if (nextType !== 'Int32' && nextType !== 'Double') return next;
    if (String(next) === String(prev)) return prev;
    const value = Number(String(next));
    if (prevType === 'Double') return new BSON.Double(value);
    if (prevType === 'Long' && Number.isSafeInteger(value)) return BSON.Long.fromNumber(value);
    return next;
  }
  if (Array.isArray(next)) {
    return next.map((v, i) => restoreTypes(v, Array.isArray(prev) ? prev[i] : undefined));
  }
  if (next !== null && typeof next === 'object' && Object.getPrototypeOf(next) === Object.prototype) {
    const prevObj = prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, restoreTypes(v, prevObj[k])]));
  }
  return next;
}
