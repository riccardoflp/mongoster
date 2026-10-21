// Backup and restore in mongodump's folder format: a folder per database with, for each collection,
// <name>.bson (its documents, raw BSON one after the other) and <name>.metadata.json (options and
// indexes; a view has only this), gzipped as .bson.gz / .metadata.json.gz when compressed. Backups
// restore with `mongorestore [--gzip] --dir <folder>`, and folders written by mongodump restore here.
// Backups can also be a single archive file, as `mongodump --archive --gzip` writes it (.agz, see archive.ts).
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { BSON, Collection, Db, Document, MongoBulkWriteError, MongoClient } from 'mongodb';
import { archivePrelude, bsonFrames, Crc64, namespaceHeader, readArchive, readArchiveCollections, TERMINATOR } from './archive';
import type { ConnectionInfo, ConnectionManager } from './connections';
import { COPIED_OPTIONS } from './copy';
import { Recorder, UndoHistory } from './history';
import { databaseNameError } from './manage';
import type { HistoryEntry } from './shared/messages';
import { errorMessage } from './tree';

const { EJSON } = BSON;
const BATCH_DOCS = 1000;
const BATCH_BYTES = 8 * 1024 * 1024;
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

/** The files of one collection in a backup folder, or a collection of an archive (its metadata only). */
export interface BackupFiles {
  name: string;
  bson?: string;
  metadata?: string;
  /** The metadata of a collection of an archive. */
  meta?: Document;
  /** Bytes of the .bson file (compressed if gzipped). */
  size: number;
}

export interface BackupDatabase {
  name: string;
  /** The database's folder, or the archive. */
  dir: string;
  collections: BackupFiles[];
}

interface DumpStats {
  collections: number;
  documents: number;
  bytes: number;
  cancelled: boolean;
}

interface DumpHooks {
  progress(documents: number): void;
  cancelled(): boolean;
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

/** The metadata of a collection, as mongodump writes it (its .metadata.json). */
async function collectionMetadata(db: Db, info: CollectionInfo): Promise<Document> {
  const indexes = info.type === 'view' ? [] : (await db.collection(info.name).listIndexes().toArray()).map(({ ns: _ns, ...spec }) => spec);
  const uuid = info.info?.uuid ? Buffer.from(info.info.uuid.buffer).toString('hex') : undefined;
  // The keys in mongodump's order.
  return {
    ...(info.options && Object.keys(info.options).length ? { options: info.options } : {}),
    indexes,
    ...(uuid && { uuid }),
    collectionName: info.name,
    type: info.type ?? 'collection',
  };
}

/** The documents of a collection exactly as stored (raw: without decoding them), until cancelled. */
async function* rawDocuments(db: Db, name: string, stats: DumpStats, hooks: DumpHooks): AsyncGenerator<Buffer> {
  const cursor = db.collection(name).find({}, { raw: true, batchSize: BATCH_DOCS });
  let documents = 0;
  try {
    for await (const doc of cursor) {
      const data = doc as unknown as Buffer;
      documents++;
      stats.documents++;
      stats.bytes += data.length;
      yield data;
      if (documents % BATCH_DOCS === 0) {
        hooks.progress(documents);
        if (hooks.cancelled()) {
          stats.cancelled = true;
          return;
        }
      }
    }
  } finally {
    await cursor.close();
  }
  hooks.progress(documents);
}

/** Writes the metadata and documents of a collection (a view: its metadata only) into `dir`. */
async function dumpCollection(db: Db, info: CollectionInfo, dir: string, gzip: boolean, stats: DumpStats, hooks: DumpHooks): Promise<void> {
  await writeText(path.join(dir, `${info.name}.metadata.json`), EJSON.stringify(await collectionMetadata(db, info), { relaxed: false }), gzip);
  if (info.type === 'view') return;
  const file = path.join(dir, `${info.name}.bson${gzip ? '.gz' : ''}`);
  const source = rawDocuments(db, info.name, stats, hooks);
  if (gzip) await pipeline(source, zlib.createGzip(), fs.createWriteStream(file));
  else await pipeline(source, fs.createWriteStream(file));
}

/** An archive of the collections (to gzip): the prelude with their metadata, then their documents one collection after the other. */
async function* archiveOf(
  client: MongoClient,
  plan: { database: string; collections: CollectionInfo[] }[],
  stats: DumpStats,
  hooks: (database: string, info: CollectionInfo) => DumpHooks,
): AsyncGenerator<Buffer> {
  const buildInfo = await client.db('admin').command({ buildInfo: 1 }).catch(() => undefined);
  const collections = [];
  for (const p of plan) {
    for (const c of p.collections) {
      collections.push({ database: p.database, collection: c.name, metadata: await collectionMetadata(client.db(p.database), c), type: c.type ?? 'collection' });
    }
  }
  yield archivePrelude(typeof buildInfo?.version === 'string' ? buildInfo.version : '0.0.0', collections);
  for (const p of plan) {
    for (const c of p.collections) {
      const h = hooks(p.database, c);
      if (h.cancelled()) stats.cancelled = true;
      if (stats.cancelled) return;
      // Every collection has an EOF header, a view too (mongorestore creates it there), after its block of documents if it has any.
      const crc = new Crc64();
      let documents = 0;
      if (c.type !== 'view') {
        for await (const data of rawDocuments(client.db(p.database), c.name, stats, h)) {
          if (!documents++) yield namespaceHeader(p.database, c.name);
          crc.update(data);
          yield data;
        }
      }
      if (stats.cancelled) return;
      yield Buffer.concat([...(documents ? [TERMINATOR] : []), namespaceHeader(p.database, c.name, crc), TERMINATOR]);
      stats.collections++;
    }
  }
}

/** The documents of a .bson file (gzipped if it ends with .gz), one raw buffer each. */
export async function* readBson(file: string, onBytes: (n: number) => void = () => undefined): AsyncGenerator<Buffer> {
  const input = fs.createReadStream(file);
  input.on('data', (chunk) => onBytes(chunk.length));
  const stream = file.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  try {
    for await (const frame of bsonFrames(stream, path.basename(file))) if (frame) yield frame;
  } finally {
    input.destroy();
  }
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

/** The databases of an archive, with the metadata of their collections. */
export async function scanArchive(file: string): Promise<BackupDatabase[]> {
  const found = new Map<string, BackupFiles[]>();
  for (const c of await readArchiveCollections(file)) {
    // Collections without a database are the oplog (mongodump --oplog).
    if (!c.database || c.collection.startsWith('system.')) continue;
    const list = found.get(c.database) ?? [];
    list.push({ name: c.collection, meta: { ...c.metadata, type: c.type }, size: 0 });
    found.set(c.database, list);
  }
  return [...found]
    .map(([name, collections]) => ({ name, dir: file, collections: collections.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const typeOf = (files: BackupFiles) => (files.meta?.type as string | undefined) ?? 'collection';

/** Restores one collection: creates it (with its options) if needed, inserts the documents it's given, then creates the indexes. */
class CollectionRestore {
  readonly result: RestoreResult = { inserted: 0, skipped: 0, failed: 0, indexes: 0, indexErrors: [], cancelled: false };
  private batch: Document[] = [];
  private batchBytes = 0;

  private constructor(
    private readonly meta: Document,
    /** Undefined when no documents go into it: a view, or a collection that isn't restored. */
    private readonly coll?: Collection,
    private readonly recorder?: Recorder,
  ) {}

  static async open(db: Db, name: string, meta: Document, drop: boolean, recorder?: Recorder): Promise<CollectionRestore> {
    const type = (meta.type as string | undefined) ?? 'collection';
    const options = (meta.options ?? {}) as Document;
    const none = (notRestored?: string) => {
      const restore = new CollectionRestore(meta);
      restore.result.notRestored = notRestored;
      return restore;
    };
    if (type === 'timeseries') return none('a time series collection (use mongorestore)');
    const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
    if (exists && drop) await db.collection(name).drop();
    const created = !exists || drop;
    if (type === 'view') {
      if (!created) return none('a view that already exists');
      await db.createCollection(name, { viewOn: options.viewOn, pipeline: options.pipeline, ...(options.collation && { collation: options.collation }) });
      return none();
    }
    if (created) await db.createCollection(name, Object.fromEntries(Object.entries(options).filter(([k]) => COPIED_OPTIONS.includes(k))));
    return new CollectionRestore(meta, db.collection(name), recorder);
  }

  /** Whether it takes documents. */
  get accepting(): boolean {
    return !!this.coll;
  }

  /** Adds a document; true when that wrote a batch. */
  async add(data: Buffer): Promise<boolean> {
    // promoteValues: false and bsonRegExp keep every value exactly as it was saved.
    this.batch.push(BSON.deserialize(data, { promoteValues: false, bsonRegExp: true }));
    this.batchBytes += data.length;
    if (this.batch.length < BATCH_DOCS && this.batchBytes < BATCH_BYTES) return false;
    await this.flush();
    return true;
  }

  private async flush(): Promise<void> {
    const { batch, result, recorder: rec } = this;
    let failedAt = new Set<number>();
    try {
      result.inserted += (await this.coll!.insertMany(batch, { ordered: false, bypassDocumentValidation: true })).insertedCount;
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
    this.batch = [];
    this.batchBytes = 0;
  }

  /** Inserts the last documents and records the undo; then, unless cancelled, creates the indexes. */
  async finish(cancelled: boolean): Promise<RestoreResult> {
    const { coll, result } = this;
    if (!coll) return result;
    if (this.batch.length) await this.flush();
    result.entry = await this.recorder?.commit(coll);
    result.cancelled = cancelled;
    if (cancelled) return result;

    const specs = ((this.meta.indexes ?? []) as Document[]).filter((i) => i.name !== '_id_' && !i.clustered).map(({ v: _v, ns: _ns, ...spec }) => spec);
    for (const spec of specs) {
      try {
        await coll.createIndexes([spec as never]);
        result.indexes++;
      } catch (err) {
        result.indexErrors.push(`${coll.collectionName}.${spec.name}: ${errorMessage(err)}`);
      }
    }
    return result;
  }
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

    // Format and destination
    const format = await vscode.window.showQuickPick<Pick<'archive' | 'gzip' | 'plain'>>(
      [
        { label: 'Archive (.agz)', description: 'a single gzipped file; restore with mongorestore --gzip --archive', value: 'archive' },
        { label: 'Folder, compressed (gzip)', description: '.bson.gz files; restore with mongorestore --gzip --dir', value: 'gzip' },
        { label: 'Folder, uncompressed', description: '.bson files', value: 'plain' },
      ],
      { title: title('format'), ignoreFocusOut: true },
    );
    if (!format) return;
    const archive = format.value === 'archive';
    const gzip = format.value !== 'plain';
    let root: string;
    if (archive) {
      const file = await vscode.window.showSaveDialog({
        title: title('archive'),
        defaultUri: vscode.Uri.joinPath(this.defaultFolder(), `${safeName(what)}_${stamp()}.agz`),
        filters: { 'mongodump archive (gzip)': ['agz'] },
        saveLabel: 'Back Up',
      });
      if (!file) return;
      root = file.fsPath;
      await this.context.globalState.update(FOLDER_KEY, path.dirname(root));
    } else {
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
      root = base;
      for (let n = 2; fs.existsSync(root); n++) root = `${base}_${n}`;
    }

    // Copy
    const totals = new Map<string, number>();
    for (const p of plan) {
      for (const c of p.collections) {
        if (c.type !== 'view') totals.set(`${p.database}.${c.name}`, await client.db(p.database).collection(c.name).estimatedDocumentCount().catch(() => 0));
      }
    }
    const total = [...totals.values()].reduce((a, b) => a + b, 0);
    const started = Date.now();
    const stats: DumpStats = { collections: 0, documents: 0, bytes: 0, cancelled: false };
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Backing up ${what}`, cancellable: true },
        async (progress, token) => {
          const hooks = (database: string, c: CollectionInfo): DumpHooks => {
            let reported = 0;
            return {
              progress: (n) => {
                progress.report({
                  message: `${database}.${c.name}: ${n.toLocaleString('en-US')} documents`,
                  increment: total ? ((n - reported) / total) * 100 : undefined,
                });
                reported = n;
              },
              cancelled: () => token.isCancellationRequested,
            };
          };
          if (archive) {
            await pipeline(archiveOf(client, plan, stats, hooks), zlib.createGzip(), fs.createWriteStream(root));
            return;
          }
          for (const p of plan) {
            const dir = path.join(root, p.database);
            await fs.promises.mkdir(dir, { recursive: true });
            for (const c of p.collections) {
              await dumpCollection(client.db(p.database), c, dir, gzip, stats, hooks(p.database, c));
              if (stats.cancelled || token.isCancellationRequested) {
                stats.cancelled = true;
                return;
              }
              stats.collections++;
            }
          }
        },
      );
    } catch (err) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
      void vscode.window.showErrorMessage(`Backup of ${what} failed: ${errorMessage(err)}`);
      return;
    }
    if (stats.cancelled) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
      void vscode.window.showWarningMessage(`Backup of ${what} cancelled: the incomplete backup was deleted.`);
      return;
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const parts = [plural(stats.collections, 'collection'), plural(stats.documents, 'document'), formatSize(stats.bytes)];
    const note = skipped.length ? ` Time series collections aren't supported and were left out (use mongodump): ${skipped.join(', ')}.` : '';
    const message = `Backed up ${what} (${parts.join(', ')}) to ${root} in ${seconds} s.${note}`;
    const command = archive ? `mongorestore --gzip --archive="${root}"` : `mongorestore ${gzip ? '--gzip ' : ''}--dir "${root}"`;
    const reveal = archive ? 'Reveal File' : 'Reveal Folder';
    const show = note ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const answer = await show(message, 'Copy mongorestore Command', reveal);
    if (answer === 'Copy mongorestore Command') await vscode.env.clipboard.writeText(command);
    if (answer === reveal) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
  }

  /** The databases of an archive, or undefined (with an error shown) if it can't be read. */
  private async archiveDatabases(file: string): Promise<BackupDatabase[] | undefined> {
    try {
      return await scanArchive(file);
    } catch (err) {
      void vscode.window.showErrorMessage(`Can't read ${path.basename(file)}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  /**
   * Restores a backup folder or archive (mongodump's or Mongoster's) into a connection (its databases, by
   * name) or a database (one database of the backup), or a .bson file or a collection of an archive into a
   * collection.
   */
  async restore(node: ConnectionInfo, database?: string, collection?: string): Promise<void> {
    const info = this.connections.get(node.id) ?? node;
    if (info.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${info.name} is read-only: nothing can be restored into it.`);
      return;
    }
    const where = collection ? `${info.name} › ${database}.${collection}` : database ? `${info.name} › ${database}` : info.name;
    const title = (step: string) => `Restore into ${where}: ${step}`;

    // What. `source`: the database of the backup.
    const plan: { database: string; source: string; collections: { name: string; files: BackupFiles }[] }[] = [];
    let from: string;
    let archive = false;
    if (database && collection) {
      const [file] =
        (await vscode.window.showOpenDialog({
          title: title('BSON file or archive'),
          defaultUri: this.defaultFolder(),
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'BSON or archive (mongodump)': ['bson', 'gz', 'agz', 'archive'], 'All files': ['*'] },
          openLabel: 'Restore',
        })) ?? [];
      if (!file) return;
      from = file.fsPath;
      const m = /^(.+)\.bson(\.gz)?$/.exec(path.basename(from));
      if (m) {
        const metadata = [`${m[1]}.metadata.json`, `${m[1]}.metadata.json.gz`].map((f) => path.join(path.dirname(from), f)).find((f) => fs.existsSync(f));
        plan.push({ database, source: database, collections: [{ name: collection, files: { name: m[1], bson: from, metadata, size: fs.statSync(from).size } }] });
      } else {
        // An archive: one of its collections.
        archive = true;
        const found = await this.archiveDatabases(from);
        if (!found) return;
        const items = found.flatMap((d) =>
          d.collections.filter((c) => typeOf(c) === 'collection').map((c) => ({ label: c.name, description: d.name, value: { database: d.name, files: c } })),
        );
        if (!items.length) {
          void vscode.window.showErrorMessage(`${path.basename(from)} has no collections to restore.`);
          return;
        }
        const pick =
          items.length === 1
            ? items[0]
            : await vscode.window.showQuickPick<Pick<{ database: string; files: BackupFiles }>>(
                [...items].sort((a, b) => Number(b.label === collection) - Number(a.label === collection)),
                { title: title('collection of the archive'), matchOnDescription: true, ignoreFocusOut: true },
              );
        if (!pick) return;
        plan.push({ database, source: pick.value.database, collections: [{ name: collection, files: pick.value.files }] });
      }
    } else {
      // Folders and files can't be picked in the same dialog on Windows and Linux.
      const kind = await vscode.window.showQuickPick<Pick<boolean>>(
        [
          { label: 'Archive', description: 'a single .agz or .archive file (mongodump --archive)', value: true },
          { label: 'Folder', description: 'a folder backup (mongodump --out), or the folder of one database', value: false },
        ],
        { title: title('backup'), ignoreFocusOut: true },
      );
      if (!kind) return;
      archive = kind.value;
      const [picked] =
        (await vscode.window.showOpenDialog({
          title: title(archive ? 'archive' : 'backup folder'),
          defaultUri: this.defaultFolder(),
          canSelectFiles: archive,
          canSelectFolders: !archive,
          canSelectMany: false,
          ...(archive && { filters: { 'mongodump archive': ['agz', 'archive', 'gz'], 'All files': ['*'] } }),
          openLabel: 'Restore',
        })) ?? [];
      if (!picked) return;
      from = picked.fsPath;
      const found = archive ? await this.archiveDatabases(from) : scanBackup(from);
      if (!found) return;
      if (!found.length) {
        void vscode.window.showErrorMessage(
          archive
            ? `${path.basename(from)} has no collections to restore.`
            : `No backup found in ${from}: expected <collection>.bson and <collection>.metadata.json files (mongodump), or a folder of them per database.`,
        );
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
            picked.map((c) => ({
              label: c.name,
              description: c.meta ? (typeOf(c) === 'collection' ? undefined : typeOf(c)) : c.bson ? formatSize(c.size) : 'view or metadata only',
              picked: true,
              value: c,
            })),
            { title: title(`collections of ${source.name}`), canPickMany: true, ignoreFocusOut: true },
          );
          if (!pick?.length) return;
          picked = pick.map((p) => p.value);
        }
        plan.push({ database: target, source: source.name, collections: picked.map((files) => ({ name: files.name, files })) });
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
    const totalBytes = archive ? fs.statSync(from).size : plan.reduce((n, p) => n + p.collections.reduce((m, c) => m + c.files.size, 0), 0);
    const results: RestoreResult[] = [];
    const notRestored: string[] = [];
    const started = Date.now();
    let error: string | undefined;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Restoring into ${where}`, cancellable: true },
        async (progress, token) => {
          let current = '';
          const bytes = (n: number) => progress.report({ message: current, increment: totalBytes ? (n / totalBytes) * 100 : undefined });
          const open = (target: { database: string; name: string; files: BackupFiles }) => {
            current = `${target.database}.${target.name}`;
            const label = archive ? `Restore ${target.files.name} from ${path.basename(from)}` : `Restore ${path.basename(target.files.bson ?? target.name)}`;
            const recorder = drop ? undefined : UndoHistory.start({ connectionId: info.id, database: target.database, collection: target.name }, label);
            const meta = target.files.meta ?? (target.files.metadata ? readMetadata(target.files.metadata) : {});
            return CollectionRestore.open(client.db(target.database), target.name, meta, drop, recorder);
          };
          const done = (target: { database: string; name: string }, res: RestoreResult) => {
            results.push(res);
            if (res.notRestored) notRestored.push(`${target.database}.${target.name} (${res.notRestored})`);
          };

          if (!archive) {
            for (const p of plan) {
              for (const c of p.collections) {
                const target = { database: p.database, ...c };
                const restore = await open(target);
                let cancelled = false;
                if (restore.accepting && c.files.bson) {
                  for await (const data of readBson(c.files.bson, bytes)) {
                    if ((await restore.add(data)) && token.isCancellationRequested) {
                      cancelled = true;
                      break;
                    }
                  }
                } else bytes(c.files.size);
                done(target, await restore.finish(cancelled));
                if (cancelled || token.isCancellationRequested) return;
              }
            }
            return;
          }

          // An archive is read once: its collections can alternate, so those being restored stay open until their end.
          const targets = new Map<string, { database: string; name: string; files: BackupFiles }>(
            plan.flatMap((p) => p.collections.map((c) => [`${p.source}.${c.files.name}`, { database: p.database, ...c }] as const)),
          );
          const restores = new Map<string, CollectionRestore>();
          const finished = new Set<string>();
          const finish = async (key: string, cancelled: boolean) => {
            done(targets.get(key)!, await restores.get(key)!.finish(cancelled));
            restores.delete(key);
            finished.add(key);
          };
          let cancelled = false;
          for await (const item of readArchive(from, bytes)) {
            const key = `${item.database}.${item.collection}`;
            const target = targets.get(key);
            if (!target || finished.has(key)) continue;
            let restore = restores.get(key);
            if (!restore) restores.set(key, (restore = await open(target)));
            current = `${target.database}.${target.name}`;
            if (!item.data) await finish(key, false);
            else if (restore.accepting && (await restore.add(item.data)) && token.isCancellationRequested) {
              cancelled = true;
              break;
            }
          }
          for (const key of [...restores.keys()]) await finish(key, cancelled);
          if (cancelled) return;
          // Collections the archive lists but has no data for.
          for (const [key, target] of targets) {
            if (finished.has(key)) continue;
            restores.set(key, await open(target));
            await finish(key, false);
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
