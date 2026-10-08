// Backup and restore in mongodump's folder format: a folder per database with, for each collection,
// <name>.bson (its documents, raw BSON one after the other) and <name>.metadata.json (options and
// indexes; a view has only this), gzipped as .bson.gz / .metadata.json.gz when compressed. Backups
// restore with `mongorestore [--gzip] --dir <folder>`, and folders written by mongodump restore here.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { BSON, Db, Document, MongoBulkWriteError, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import { COPIED_OPTIONS } from './copy';
import { Recorder, UndoHistory } from './history';
import { databaseNameError } from './manage';
import type { HistoryEntry } from './shared/messages';
import { errorMessage } from './tree';

const { EJSON } = BSON;
const BATCH_DOCS = 1000;
const BATCH_BYTES = 8 * 1024 * 1024;
/** Above the 16 MB document limit, with room: a larger size means the file isn't BSON. */
const MAX_DOCUMENT = 48 * 1024 * 1024;
const SYSTEM_DATABASES = ['admin', 'local', 'config'];
const FOLDER_KEY = 'mongoster.backupFolder';
const DUPLICATE_KEY = 11000;

type Pick<T> = vscode.QuickPickItem & { value: T };

interface CollectionInfo {
  name: string;
  type?: string;
  options?: Document;
  info?: { uuid?: { buffer: Uint8Array } };
}

/** The files of one collection in a backup folder. */
export interface BackupFiles {
  name: string;
  bson?: string;
  metadata?: string;
  /** Bytes of the .bson file (compressed if gzipped). */
  size: number;
}

export interface BackupDatabase {
  name: string;
  dir: string;
  collections: BackupFiles[];
}

interface RestoreResult {
  inserted: number;
  skipped: number;
  failed: number;
  firstError?: string;
  indexes: number;
  indexErrors: string[];
  /** Why the collection wasn't restored. */
  notRestored?: string;
  entry?: HistoryEntry;
  cancelled: boolean;
}

const plural = (n: number, what: string) => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

function formatSize(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** 2026-10-08_16-45-12 */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_');

async function writeText(file: string, text: string, gzip: boolean): Promise<void> {
  const data = Buffer.from(text, 'utf8');
  await fs.promises.writeFile(gzip ? `${file}.gz` : file, gzip ? zlib.gzipSync(data) : data);
}

function readMetadata(file: string): Document {
  const data = fs.readFileSync(file);
  const text = (file.endsWith('.gz') ? zlib.gunzipSync(data) : data).toString('utf8');
  return EJSON.parse(text, { relaxed: false }) as Document;
}

/** Writes the metadata and documents of a collection (a view: its metadata only) into `dir`. */
async function dumpCollection(
  db: Db,
  info: CollectionInfo,
  dir: string,
  gzip: boolean,
  hooks: { progress(documents: number): void; cancelled(): boolean },
): Promise<{ documents: number; bytes: number; cancelled: boolean }> {
  const coll = db.collection(info.name);
  const view = info.type === 'view';
  const indexes = view ? [] : (await coll.listIndexes().toArray()).map(({ ns: _ns, ...spec }) => spec);
  const uuid = info.info?.uuid ? Buffer.from(info.info.uuid.buffer).toString('hex') : undefined;
  // The keys in mongodump's order.
  const metadata: Document = {
    ...(info.options && Object.keys(info.options).length ? { options: info.options } : {}),
    indexes,
    ...(uuid && { uuid }),
    collectionName: info.name,
    type: info.type ?? 'collection',
  };
  await writeText(path.join(dir, `${info.name}.metadata.json`), EJSON.stringify(metadata, { relaxed: false }), gzip);
  if (view) return { documents: 0, bytes: 0, cancelled: false };

  let documents = 0;
  let bytes = 0;
  let cancelled = false;
  // raw: the documents exactly as stored, without decoding them.
  const cursor = coll.find({}, { raw: true, batchSize: BATCH_DOCS });
  const source = async function* () {
    try {
      for await (const doc of cursor) {
        const data = doc as unknown as Buffer;
        documents++;
        bytes += data.length;
        yield data;
        if (documents % BATCH_DOCS === 0) {
          hooks.progress(documents);
          if (hooks.cancelled()) {
            cancelled = true;
            return;
          }
        }
      }
    } finally {
      await cursor.close();
    }
  };
  const file = path.join(dir, `${info.name}.bson${gzip ? '.gz' : ''}`);
  if (gzip) await pipeline(source, zlib.createGzip(), fs.createWriteStream(file));
  else await pipeline(source, fs.createWriteStream(file));
  hooks.progress(documents);
  return { documents, bytes, cancelled };
}

/** The documents of a .bson file (gzipped if it ends with .gz), one raw buffer each. */
export async function* readBson(file: string, onBytes: (n: number) => void = () => undefined): AsyncGenerator<Buffer> {
  const input = fs.createReadStream(file);
  input.on('data', (chunk) => onBytes(chunk.length));
  const stream = file.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  let pending: Buffer = Buffer.alloc(0);
  let offset = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 4) {
        const size = pending.readInt32LE(0);
        if (size < 5 || size > MAX_DOCUMENT) throw new Error(`${path.basename(file)} is not a BSON file (invalid document at byte ${offset.toLocaleString('en-US')}).`);
        if (pending.length < size) break;
        yield pending.subarray(0, size);
        pending = pending.subarray(size);
        offset += size;
      }
    }
  } finally {
    input.destroy();
  }
  if (pending.length) throw new Error(`${path.basename(file)} is truncated: its last document is incomplete.`);
}

/** The collections of a mongodump database folder (its <name>.bson and <name>.metadata.json files). */
export function scanDatabase(dir: string): BackupFiles[] {
  const found = new Map<string, BackupFiles>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const m = /^(.+)\.(bson|metadata\.json)(\.gz)?$/.exec(entry.name);
    if (!entry.isFile() || !m || m[1].startsWith('system.')) continue;
    const files = found.get(m[1]) ?? { name: m[1], size: 0 };
    const file = path.join(dir, entry.name);
    if (m[2] === 'bson') {
      files.bson = file;
      files.size = fs.statSync(file).size;
    } else files.metadata = file;
    found.set(m[1], files);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The databases of a backup: the folder itself when it's a database folder, otherwise its sub-folders. */
export function scanBackup(folder: string): BackupDatabase[] {
  const own = scanDatabase(folder);
  if (own.length) return [{ name: path.basename(folder), dir: folder, collections: own }];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, dir: path.join(folder, e.name), collections: scanDatabase(path.join(folder, e.name)) }))
    .filter((d) => d.collections.length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Restores one collection: creates it (with its options) if needed, inserts the documents, then the indexes. */
async function restoreCollection(
  db: Db,
  name: string,
  files: BackupFiles,
  drop: boolean,
  hooks: { bytes(n: number): void; cancelled(): boolean; recorder?: Recorder },
): Promise<RestoreResult> {
  const result: RestoreResult = { inserted: 0, skipped: 0, failed: 0, indexes: 0, indexErrors: [], cancelled: false };
  const meta = files.metadata ? readMetadata(files.metadata) : {};
  const type = (meta.type as string | undefined) ?? 'collection';
  const options = (meta.options ?? {}) as Document;
  if (type === 'timeseries') {
    hooks.bytes(files.size);
    return { ...result, notRestored: 'a time series collection (use mongorestore)' };
  }
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (exists && drop) await db.collection(name).drop();
  const created = !exists || drop;
  if (type === 'view') {
    if (!created) return { ...result, notRestored: 'a view that already exists' };
    await db.createCollection(name, { viewOn: options.viewOn, pipeline: options.pipeline, ...(options.collation && { collation: options.collation }) });
    return result;
  }
  if (created) await db.createCollection(name, Object.fromEntries(Object.entries(options).filter(([k]) => COPIED_OPTIONS.includes(k))));

  const coll = db.collection(name);
  const rec = hooks.recorder;
  let batch: Document[] = [];
  let batchBytes = 0;
  const flush = async () => {
    let failedAt = new Set<number>();
    try {
      result.inserted += (await coll.insertMany(batch, { ordered: false, bypassDocumentValidation: true })).insertedCount;
    } catch (err) {
      if (!(err instanceof MongoBulkWriteError)) throw err;
      result.inserted += err.insertedCount;
      const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
      failedAt = new Set(errors.map((e) => e.index));
      for (const e of errors) {
        if (e.code === DUPLICATE_KEY) result.skipped++;
        else {
          result.failed++;
          result.firstError ??= e.errmsg ?? errorMessage(e);
        }
      }
    }
    if (rec) batch.forEach((doc, i) => failedAt.has(i) || rec.addNew(doc._id));
    batch = [];
    batchBytes = 0;
  };
  if (files.bson) {
    for await (const data of readBson(files.bson, hooks.bytes)) {
      // promoteValues: false and bsonRegExp keep every value exactly as it was saved.
      batch.push(BSON.deserialize(data, { promoteValues: false, bsonRegExp: true }));
      batchBytes += data.length;
      if (batch.length >= BATCH_DOCS || batchBytes >= BATCH_BYTES) {
        await flush();
        if (hooks.cancelled()) {
          result.cancelled = true;
          break;
        }
      }
    }
    if (batch.length) await flush();
  }
  result.entry = await rec?.commit(coll);
  if (result.cancelled) return result;

  const specs = ((meta.indexes ?? []) as Document[]).filter((i) => i.name !== '_id_' && !i.clustered).map(({ v: _v, ns: _ns, ...spec }) => spec);
  for (const spec of specs) {
    try {
      await coll.createIndexes([spec as never]);
      result.indexes++;
    } catch (err) {
      result.indexErrors.push(`${name}.${spec.name}: ${errorMessage(err)}`);
    }
  }
  return result;
}

export class Backups {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
  ) {}

  private async client(info: ConnectionInfo): Promise<MongoClient | undefined> {
    try {
      return await this.connections.getClient(info.id);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${info.name}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private defaultFolder(): vscode.Uri {
    const last = this.context.globalState.get<string>(FOLDER_KEY);
    return last ? vscode.Uri.file(last) : vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  }

  /** Backs up a connection (the databases picked), a database (the collections picked) or a collection. */
  async backup(node: ConnectionInfo, database?: string, collection?: string): Promise<void> {
    const info = this.connections.get(node.id) ?? node;
    const what = collection ? `${database}.${collection}` : database ?? info.name;
    const title = (step: string) => `Back Up ${what}: ${step}`;
    const client = await this.client(info);
    if (!client) return;

    // What
    const listCollections = async (db: string) =>
      ((await client.db(db).listCollections({}, { nameOnly: false }).toArray()) as CollectionInfo[])
        .filter((c) => !c.name.startsWith('system.'))
        .sort((a, b) => a.name.localeCompare(b.name));
    const plan: { database: string; collections: CollectionInfo[] }[] = [];
    try {
      if (database && collection) {
        plan.push({ database, collections: (await listCollections(database)).filter((c) => c.name === collection) });
      } else if (database) {
        const all = await listCollections(database);
        let picked = all;
        if (all.length > 1) {
          const pick = await vscode.window.showQuickPick<Pick<CollectionInfo>>(
            all.map((c) => ({ label: c.name, description: c.type === 'collection' ? undefined : c.type, picked: true, value: c })),
            { title: title('collections'), canPickMany: true, ignoreFocusOut: true },
          );
          if (!pick?.length) return;
          picked = pick.map((p) => p.value);
        }
        plan.push({ database, collections: picked });
      } else {
        const names = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).filter((d) => !SYSTEM_DATABASES.includes(d));
        if (!names.length) {
          void vscode.window.showInformationMessage(`${info.name} has no databases to back up.`);
          return;
        }
        let picked = names.sort();
        if (names.length > 1) {
          const pick = await vscode.window.showQuickPick(
            picked.map((d) => ({ label: d, picked: true })),
            { title: title('databases'), canPickMany: true, ignoreFocusOut: true },
          );
          if (!pick?.length) return;
          picked = pick.map((p) => p.label);
        }
        for (const d of picked) plan.push({ database: d, collections: await listCollections(d) });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Backup failed: ${errorMessage(err)}`);
      return;
    }
    const skipped = plan.flatMap((p) => p.collections.filter((c) => c.type === 'timeseries').map((c) => `${p.database}.${c.name}`));
    for (const p of plan) p.collections = p.collections.filter((c) => c.type !== 'timeseries');
    if (!plan.some((p) => p.collections.length)) {
      void vscode.window.showWarningMessage(skipped.length ? `Nothing to back up: time series collections aren't supported (use mongodump).` : `Nothing to back up in ${what}.`);
      return;
    }

    // Format and folder
    const format = await vscode.window.showQuickPick<Pick<boolean>>(
      [
        { label: 'Compressed (gzip)', description: '.bson.gz files; restore with mongorestore --gzip', value: true },
        { label: 'Uncompressed', description: '.bson files', value: false },
      ],
      { title: title('format'), ignoreFocusOut: true },
    );
    if (!format) return;
    const gzip = format.value;
    const [folder] =
      (await vscode.window.showOpenDialog({
        title: title('folder'),
        defaultUri: this.defaultFolder(),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Back Up Here',
      })) ?? [];
    if (!folder) return;
    await this.context.globalState.update(FOLDER_KEY, folder.fsPath);
    // A new folder: never one of an earlier backup (it's deleted if the backup is cancelled).
    const base = path.join(folder.fsPath, `${safeName(what)}_${stamp()}`);
    let root = base;
    for (let n = 2; fs.existsSync(root); n++) root = `${base}_${n}`;

    // Copy
    const totals = new Map<string, number>();
    for (const p of plan) {
      for (const c of p.collections) {
        if (c.type !== 'view') totals.set(`${p.database}.${c.name}`, await client.db(p.database).collection(c.name).estimatedDocumentCount().catch(() => 0));
      }
    }
    const total = [...totals.values()].reduce((a, b) => a + b, 0);
    const started = Date.now();
    let documents = 0;
    let bytes = 0;
    let collections = 0;
    let cancelled = false;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Backing up ${what}`, cancellable: true },
        async (progress, token) => {
          for (const p of plan) {
            const dir = path.join(root, p.database);
            await fs.promises.mkdir(dir, { recursive: true });
            for (const c of p.collections) {
              let reported = 0;
              const res = await dumpCollection(client.db(p.database), c, dir, gzip, {
                progress: (n) => {
                  progress.report({
                    message: `${p.database}.${c.name}: ${n.toLocaleString('en-US')} documents`,
                    increment: total ? ((n - reported) / total) * 100 : undefined,
                  });
                  reported = n;
                },
                cancelled: () => token.isCancellationRequested,
              });
              documents += res.documents;
              bytes += res.bytes;
              collections++;
              if (res.cancelled || token.isCancellationRequested) {
                cancelled = true;
                return;
              }
            }
          }
        },
      );
    } catch (err) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
      void vscode.window.showErrorMessage(`Backup of ${what} failed: ${errorMessage(err)}`);
      return;
    }
    if (cancelled) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
      void vscode.window.showWarningMessage(`Backup of ${what} cancelled: the incomplete backup was deleted.`);
      return;
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const parts = [plural(collections, 'collection'), plural(documents, 'document'), formatSize(bytes)];
    const note = skipped.length ? ` Time series collections aren't supported and were left out (use mongodump): ${skipped.join(', ')}.` : '';
    const message = `Backed up ${what} (${parts.join(', ')}) to ${root} in ${seconds} s.${note}`;
    const command = `mongorestore ${gzip ? '--gzip ' : ''}--dir "${root}"`;
    const show = note ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const answer = await show(message, 'Copy mongorestore Command', 'Reveal Folder');
    if (answer === 'Copy mongorestore Command') await vscode.env.clipboard.writeText(command);
    if (answer === 'Reveal Folder') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
  }

  /**
   * Restores a backup folder (mongodump's or Mongoster's) into a connection (its databases, by name), a
   * database (one database of the backup), or a .bson file into a collection.
   */
  async restore(node: ConnectionInfo, database?: string, collection?: string): Promise<void> {
    const info = this.connections.get(node.id) ?? node;
    if (info.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${info.name} is read-only: nothing can be restored into it.`);
      return;
    }
    const where = collection ? `${info.name} › ${database}.${collection}` : database ? `${info.name} › ${database}` : info.name;
    const title = (step: string) => `Restore into ${where}: ${step}`;

    // What
    const plan: { database: string; collections: { name: string; files: BackupFiles }[] }[] = [];
    let from: string;
    if (database && collection) {
      const [file] =
        (await vscode.window.showOpenDialog({
          title: title('BSON file'),
          defaultUri: this.defaultFolder(),
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'BSON (mongodump)': ['bson', 'gz'] },
          openLabel: 'Restore',
        })) ?? [];
      if (!file) return;
      from = file.fsPath;
      const m = /^(.+)\.bson(\.gz)?$/.exec(path.basename(from));
      if (!m) {
        void vscode.window.showErrorMessage(`${path.basename(from)} isn't a .bson or .bson.gz file.`);
        return;
      }
      const metadata = [`${m[1]}.metadata.json`, `${m[1]}.metadata.json.gz`].map((f) => path.join(path.dirname(from), f)).find((f) => fs.existsSync(f));
      plan.push({ database, collections: [{ name: collection, files: { name: m[1], bson: from, metadata, size: fs.statSync(from).size } }] });
    } else {
      const [folder] =
        (await vscode.window.showOpenDialog({
          title: title('backup folder'),
          defaultUri: this.defaultFolder(),
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Restore',
        })) ?? [];
      if (!folder) return;
      from = folder.fsPath;
      const found = scanBackup(from);
      if (!found.length) {
        void vscode.window.showErrorMessage(`No backup found in ${from}: expected <collection>.bson and <collection>.metadata.json files (mongodump), or a folder of them per database.`);
        return;
      }
      let sources = found;
      if (found.length > 1) {
        const items = found.map((d) => ({ label: d.name, description: plural(d.collections.length, 'collection'), picked: true, value: d }));
        if (database) {
          const pick = await vscode.window.showQuickPick<Pick<BackupDatabase>>(items, { title: title('database of the backup'), ignoreFocusOut: true });
          if (!pick) return;
          sources = [pick.value];
        } else {
          const pick = await vscode.window.showQuickPick<Pick<BackupDatabase>>(items, { title: title('databases'), canPickMany: true, ignoreFocusOut: true });
          if (!pick?.length) return;
          sources = pick.map((p) => p.value);
        }
      }
      for (const source of sources) {
        let target = database ?? source.name;
        if (!database && sources.length === 1) {
          const name = (
            await vscode.window.showInputBox({
              title: title('database'),
              prompt: `Database on ${info.name} to restore ${source.name} into`,
              value: source.name,
              ignoreFocusOut: true,
              validateInput: (v) => databaseNameError(v.trim()),
            })
          )?.trim();
          if (!name) return;
          target = name;
        }
        let picked = source.collections;
        if (picked.length > 1) {
          const pick = await vscode.window.showQuickPick<Pick<BackupFiles>>(
            picked.map((c) => ({ label: c.name, description: c.bson ? formatSize(c.size) : 'view or metadata only', picked: true, value: c })),
            { title: title(`collections of ${source.name}`), canPickMany: true, ignoreFocusOut: true },
          );
          if (!pick?.length) return;
          picked = pick.map((p) => p.value);
        }
        plan.push({ database: target, collections: picked.map((files) => ({ name: files.name, files })) });
      }
    }

    // Mode
    const mode = await vscode.window.showQuickPick<Pick<boolean>>(
      [
        { label: 'Add documents', description: 'documents whose _id already exists are kept and skipped', value: false },
        { label: 'Drop and restore', description: 'each collection is dropped first, like mongorestore --drop', value: true },
      ],
      { title: title('existing collections'), ignoreFocusOut: true },
    );
    if (!mode) return;
    const drop = mode.value;
    const count = plan.reduce((n, p) => n + p.collections.length, 0);
    const targets = [...new Set(plan.map((p) => p.database))].join(', ');
    const maxUndo = UndoHistory.maxDocuments(info.id);
    const answer = await vscode.window.showWarningMessage(
      `Restore ${plural(count, 'collection')} into ${info.name} › ${targets}?`,
      {
        modal: true,
        detail: [
          `From ${from}.`,
          drop
            ? "Existing collections with the same names are dropped first, with their documents and indexes: this can't be undone."
            : 'Documents are added; those whose _id already exists are skipped.',
          !drop && maxUndo !== undefined ? `It can be undone from the Undo History, for collections of up to ${plural(maxUndo, 'document')}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      'Restore',
    );
    if (answer !== 'Restore') return;
    const client = await this.client(info);
    if (!client) return;

    // Restore
    const totalBytes = plan.reduce((n, p) => n + p.collections.reduce((m, c) => m + c.files.size, 0), 0);
    const results: RestoreResult[] = [];
    const notRestored: string[] = [];
    const started = Date.now();
    let error: string | undefined;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Restoring into ${where}`, cancellable: true },
        async (progress, token) => {
          for (const p of plan) {
            for (const c of p.collections) {
              const recorder = drop ? undefined : UndoHistory.start({ connectionId: info.id, database: p.database, collection: c.name }, `Restore ${path.basename(c.files.bson ?? c.name)}`);
              const res = await restoreCollection(client.db(p.database), c.name, c.files, drop, {
                bytes: (n) => {
                  progress.report({ message: `${p.database}.${c.name}`, increment: totalBytes ? (n / totalBytes) * 100 : undefined });
                },
                cancelled: () => token.isCancellationRequested,
                recorder,
              });
              results.push(res);
              if (res.notRestored) notRestored.push(`${p.database}.${c.name} (${res.notRestored})`);
              if (res.cancelled || token.isCancellationRequested) return;
            }
          }
        },
      );
    } catch (err) {
      error = errorMessage(err);
    }
    void vscode.commands.executeCommand('mongoster.refresh');

    const sum = (key: 'inserted' | 'skipped' | 'failed' | 'indexes') => results.reduce((n, r) => n + r[key], 0);
    const entries = results.map((r) => r.entry).filter((e): e is HistoryEntry => !!e);
    const firstError = results.find((r) => r.firstError)?.firstError;
    const details = [
      sum('skipped') ? `${sum('skipped').toLocaleString('en-US')} skipped (their _id already existed)` : '',
      sum('failed') ? `${sum('failed').toLocaleString('en-US')} failed: ${firstError}` : '',
      ...results.flatMap((r) => r.indexErrors).map((e) => `Index not created — ${e}`),
      notRestored.length ? `Not restored: ${notRestored.join(', ')}` : '',
      entries.length > 1 ? `Undo from the Undo History, one operation per collection` : '',
    ].filter(Boolean);
    const restored = results.length - notRestored.length;
    const indexes = sum('indexes');
    const summary = `${plural(sum('inserted'), 'document')} and ${indexes.toLocaleString('en-US')} index${indexes === 1 ? '' : 'es'} in ${plural(restored, 'collection')}`;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (error) {
      void vscode.window.showErrorMessage(`Restore into ${where} failed: ${error}${results.length ? ` Restored before the error: ${summary}.` : ''}`);
      return;
    }
    if (results.some((r) => r.cancelled)) {
      void vscode.window.showWarningMessage(`Restore into ${where} cancelled after ${summary}; those stay.`);
      return;
    }
    const message = `Restored ${summary} into ${info.name} › ${targets} in ${seconds} s.${details.length ? ` ${details.join('. ')}.` : ''}`;
    if (details.some((d) => !d.startsWith('Undo'))) void vscode.window.showWarningMessage(message);
    else UndoHistory.notify(message, entries.length === 1 ? entries[0] : undefined);
  }
}
