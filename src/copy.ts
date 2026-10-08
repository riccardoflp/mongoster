// Copying a collection (its documents, optionally filtered, its indexes and options) to another
// database or connection, e.g. production → local. Documents are streamed in batches with their
// exact BSON types; the copy shows its progress and can be cancelled between batches.
import * as vscode from 'vscode';
import { Document, MongoBulkWriteError, MongoClient, ObjectId } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { CollectionRef } from './documentFs';
import { collectionNameError, databaseNameError } from './manage';
import { toBson } from './queries';
import { errorMessage } from './tree';
import { Recorder, UndoHistory } from './history';

export const COPY_BATCH = 1000;

/** What to do when the destination collection exists. */
export type CopyMode = 'new' | 'append' | 'upsert' | 'drop';

export interface CopyPlan {
  source: { database: string; collection: string; isView: boolean };
  target: { database: string; collection: string };
  filter: Document;
  mode: CopyMode;
  indexes: boolean;
  /** Create the destination with the source's options (validation rules, capped, collation, …). */
  options: boolean;
}

export interface CopyResult {
  copied: number;
  /** Documents whose _id already existed in the destination (append mode). */
  skipped: number;
  failed: number;
  firstError?: string;
  indexes: string[];
  indexErrors: string[];
  cancelled: boolean;
}

export interface CopyHooks {
  progress(copied: number): void;
  cancelled(): boolean;
  /** Records the documents written, for the undo history. */
  recorder?: Recorder;
}

/** Collection options that make sense on a copy. */
const COPIED_OPTIONS = [
  'validator',
  'validationLevel',
  'validationAction',
  'capped',
  'size',
  'max',
  'collation',
  'timeseries',
  'expireAfterSeconds',
  'clusteredIndex',
  'changeStreamPreAndPostImages',
];

const DUPLICATE_KEY = 11000;

/** Streams the documents (and then the indexes) of the plan from `src` to `dst`. */
export async function copyCollection(plan: CopyPlan, src: MongoClient, dst: MongoClient, hooks: CopyHooks, batchSize = COPY_BATCH): Promise<CopyResult> {
  const sourceDb = src.db(plan.source.database);
  const source = sourceDb.collection(plan.source.collection);
  const targetDb = dst.db(plan.target.database);
  const result: CopyResult = { copied: 0, skipped: 0, failed: 0, indexes: [], indexErrors: [], cancelled: false };

  if (plan.mode === 'drop') {
    await targetDb.collection(plan.target.collection).drop().catch(() => undefined);
  }
  if (plan.mode === 'new' || plan.mode === 'drop') {
    let options: Document = {};
    if (plan.options && !plan.source.isView) {
      const info = (await sourceDb.listCollections({ name: plan.source.collection }, { nameOnly: false }).toArray())[0];
      options = Object.fromEntries(Object.entries((info?.options ?? {}) as Document).filter(([k]) => COPIED_OPTIONS.includes(k)));
    }
    await targetDb.createCollection(plan.target.collection, options);
  }
  const target = targetDb.collection(plan.target.collection);

  const flush = async (batch: Document[]) => {
    const rec = hooks.recorder?.overflow ? undefined : hooks.recorder;
    if (rec) {
      // The _id of each document is known before writing it, to delete it (or restore the replaced one) on undo.
      for (const doc of batch) doc._id ??= new ObjectId();
      if (plan.mode === 'upsert') await rec.snapshotIds(target, batch.map((doc) => doc._id));
    }
    let failedAt = new Set<number>();
    try {
      if (plan.mode === 'upsert') {
        const res = await target.bulkWrite(
          batch.map((doc) =>
            doc._id === undefined
              ? { insertOne: { document: doc } }
              : { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } },
          ),
          { ordered: false },
        );
        result.copied += res.insertedCount + res.upsertedCount + res.matchedCount;
      } else {
        const res = await target.insertMany(batch, { ordered: false });
        result.copied += res.insertedCount;
      }
    } catch (err) {
      if (!(err instanceof MongoBulkWriteError)) throw err;
      const res = err.result;
      result.copied += res.insertedCount + res.upsertedCount + res.matchedCount;
      const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
      failedAt = new Set(errors.map((e) => e.index));
      for (const e of errors) {
        if (e.code === DUPLICATE_KEY && plan.mode === 'append') result.skipped++;
        else {
          result.failed++;
          result.firstError ??= e.errmsg ?? errorMessage(e);
        }
      }
    }
    if (rec && plan.mode !== 'upsert') batch.forEach((doc, i) => failedAt.has(i) || rec.addNew(doc._id));
    hooks.progress(result.copied + result.skipped + result.failed);
  };

  // promoteValues: false and bsonRegExp keep Int32/Double/Long/Decimal and regex flags exactly as they are.
  const cursor = source.find(plan.filter, { promoteValues: false, bsonRegExp: true, batchSize });
  let batch: Document[] = [];
  try {
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length < batchSize) continue;
      await flush(batch);
      batch = [];
      if (hooks.cancelled()) {
        result.cancelled = true;
        break;
      }
    }
    if (!result.cancelled && batch.length) await flush(batch);
  } finally {
    await cursor.close();
  }

  if (plan.indexes && !plan.source.isView && !result.cancelled) {
    const specs = (await source.listIndexes().toArray())
      .filter((i) => i.name !== '_id_' && !i.clustered)
      .map(({ v: _v, ns: _ns, ...spec }) => spec);
    for (const spec of specs) {
      try {
        await target.createIndexes([spec as never]);
        result.indexes.push(spec.name);
      } catch (err) {
        result.indexErrors.push(`${spec.name}: ${errorMessage(err)}`);
      }
    }
  }
  return result;
}

export interface CopySource {
  connection: ConnectionInfo;
  database: string;
  collection: string;
  isView: boolean;
}

type Pick<T> = vscode.QuickPickItem & { value: T };

/** The "Copy Collection To…" wizard. */
export class Copier {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly opened: (ref: CollectionRef) => void,
  ) {}

  async start(from: CopySource): Promise<void> {
    const srcInfo = this.connections.get(from.connection.id) ?? from.connection;
    const name = `${from.database}.${from.collection}`;
    const title = (step: string) => `Copy ${name}: ${step}`;

    // Destination connection
    const others = this.connections.list().filter((c) => c.id !== srcInfo.id);
    const connection = await vscode.window.showQuickPick<Pick<ConnectionInfo>>(
      [srcInfo, ...others].map((c) => ({
        label: `$(${c.readOnly ? 'lock' : 'server'}) ${c.name}`,
        description: [c.id === srcInfo.id ? 'same connection' : '', c.readOnly ? 'read-only' : '', c.folder ?? ''].filter(Boolean).join(' · '),
        value: c,
      })),
      { title: title('destination connection'), placeHolder: 'Where the copy goes', ignoreFocusOut: true },
    );
    if (!connection) return;
    const dstInfo = connection.value;
    if (dstInfo.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${dstInfo.name} is read-only: it can't receive a copy.`);
      return;
    }
    let dst: MongoClient;
    let src: MongoClient;
    let databases: string[];
    try {
      src = await this.connections.getClient(srcInfo.id);
      dst = await this.connections.getClient(dstInfo.id);
      databases = (await dst.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${dstInfo.name}: ${errorMessage(err)}`);
      return;
    }

    // Database
    const NEW = '$(add) New database…';
    const ordered = [...databases.filter((d) => d === from.database), ...databases.filter((d) => d !== from.database && !['admin', 'local', 'config'].includes(d))];
    const dbPick = await vscode.window.showQuickPick([...ordered, NEW], { title: title(`database on ${dstInfo.name}`), ignoreFocusOut: true });
    if (!dbPick) return;
    const database =
      dbPick === NEW
        ? (
            await vscode.window.showInputBox({
              title: title('new database'),
              prompt: `Database name on ${dstInfo.name}`,
              ignoreFocusOut: true,
              validateInput: (v) => databaseNameError(v.trim()) ?? (databases.includes(v.trim()) ? 'This database already exists' : undefined),
            })
          )?.trim()
        : dbPick;
    if (!database) return;

    // Collection
    const existing = await dst
      .db(database)
      .listCollections({}, { nameOnly: true })
      .toArray()
      .then((list) => new Map(list.map((c) => [c.name, c.type ?? 'collection'])))
      .catch(() => new Map<string, string>());
    const sameDb = dstInfo.id === srcInfo.id && database === from.database;
    const collection = (
      await vscode.window.showInputBox({
        title: title('destination collection'),
        prompt: `Collection in ${dstInfo.name} › ${database} (an existing one can be appended to or replaced)`,
        value: sameDb ? `${from.collection}_copy` : from.collection,
        ignoreFocusOut: true,
        validateInput: (v) =>
          collectionNameError(v.trim()) ??
          (sameDb && v.trim() === from.collection ? 'That is the collection being copied' : undefined) ??
          (existing.get(v.trim()) === 'view' ? 'A view has this name' : undefined),
      })
    )?.trim();
    if (!collection) return;

    let mode: CopyMode = 'new';
    if (existing.has(collection)) {
      const count = await dst.db(database).collection(collection).estimatedDocumentCount().catch(() => undefined);
      const pick = await vscode.window.showQuickPick<Pick<CopyMode>>(
        [
          { label: 'Append', description: 'insert the documents; those whose _id already exists are skipped', value: 'append' },
          { label: 'Replace matching', description: 'documents with the same _id are replaced, the others inserted', value: 'upsert' },
          { label: 'Drop and recreate', description: `the ${count?.toLocaleString('en-US') ?? ''} documents and indexes of ${collection} are deleted first`, value: 'drop' },
        ],
        { title: title(`${collection} exists in ${dstInfo.name} › ${database}`), ignoreFocusOut: true },
      );
      if (!pick) return;
      mode = pick.value;
    }

    // Filter
    let filter: Document = {};
    const filterText = await vscode.window.showInputBox({
      title: title('filter (optional)'),
      prompt: 'Only the documents matching this filter are copied; leave empty for all',
      placeHolder: '{ status: "active", createdAt: { $gte: ISODate("2024-01-01") } }',
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          toBson(v, 'Filter');
          return undefined;
        } catch (err) {
          return errorMessage(err);
        }
      },
    });
    if (filterText === undefined) return;
    filter = toBson(filterText, 'Filter') ?? {};

    // Indexes and options
    let indexes = false;
    let options = false;
    if (!from.isView) {
      const indexCount = await src
        .db(from.database)
        .collection(from.collection)
        .listIndexes()
        .toArray()
        .then((l) => l.filter((i) => i.name !== '_id_').length)
        .catch(() => 0);
      const choices: Pick<'indexes' | 'options'>[] = [];
      if (indexCount) choices.push({ label: 'Indexes', description: `${indexCount} besides _id`, picked: true, value: 'indexes' });
      if (mode === 'new' || mode === 'drop') {
        choices.push({ label: 'Collection options', description: 'validation rules, capped size, collation, time series…', picked: true, value: 'options' });
      }
      if (choices.length) {
        const picked = await vscode.window.showQuickPick(choices, { title: title('also copy'), canPickMany: true, ignoreFocusOut: true });
        if (!picked) return;
        indexes = picked.some((p) => p.value === 'indexes');
        options = picked.some((p) => p.value === 'options');
      }
    }

    // Confirm
    const source = src.db(from.database).collection(from.collection);
    let total: number;
    try {
      total = Object.keys(filter).length || from.isView ? await source.countDocuments(filter, { maxTimeMS: 60_000 }) : await source.estimatedDocumentCount();
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return;
    }
    const where = `${dstInfo.name} › ${database}.${collection}`;
    const verb = { new: 'into the new collection', append: 'appending to', upsert: 'replacing matching documents in', drop: 'dropping and recreating' }[mode];
    const destination = { connectionId: dstInfo.id, database, collection };
    const answer = await vscode.window.showWarningMessage(
      `Copy ${total.toLocaleString('en-US')} document${total === 1 ? '' : 's'} of ${srcInfo.name} › ${name} to ${where}?`,
      {
        modal: true,
        detail: [
          `Destination: ${verb} ${where}.`,
          Object.keys(filter).length ? `Filter: ${filterText.trim()}` : 'All documents.',
          indexes ? 'Indexes are created after the documents.' : '',
          options ? 'The collection is created with the options of the source.' : '',
          mode === 'drop' ? "Dropping the destination can't be undone." : UndoHistory.note(dstInfo.id, total),
        ]
          .filter(Boolean)
          .join('\n'),
      },
      'Copy',
    );
    if (answer !== 'Copy') return;

    const plan: CopyPlan = { source: { database: from.database, collection: from.collection, isView: from.isView }, target: { database, collection }, filter, mode, indexes, options };
    const started = Date.now();
    const recorder = mode === 'drop' ? undefined : UndoHistory.start(destination, `Copy ${Object.keys(filter).length ? 'filtered ' : ''}${srcInfo.name} › ${name}`, total);
    let result: CopyResult;
    try {
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Copying ${name} → ${where}`, cancellable: true },
        (progress, token) => {
          let reported = 0;
          return copyCollection(plan, src, dst, {
            progress: (done) => {
              progress.report({
                increment: total ? ((done - reported) / total) * 100 : undefined,
                message: `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} documents`,
              });
              reported = done;
            },
            cancelled: () => token.isCancellationRequested,
            recorder,
          });
        },
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Copy failed: ${errorMessage(err)}`);
      void vscode.commands.executeCommand('mongoster.refresh');
      return;
    }
    const entry = await recorder?.commit(dst.db(database).collection(collection));
    void vscode.commands.executeCommand('mongoster.refresh');
    const ref: CollectionRef = { connectionId: dstInfo.id, database, collection };
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const parts = [`${result.copied.toLocaleString('en-US')} document${result.copied === 1 ? '' : 's'}`];
    if (result.indexes.length) parts.push(`${result.indexes.length} index${result.indexes.length === 1 ? '' : 'es'}`);
    const details = [
      result.skipped ? `${result.skipped.toLocaleString('en-US')} skipped (their _id already existed)` : '',
      result.failed ? `${result.failed.toLocaleString('en-US')} failed: ${result.firstError}` : '',
      ...result.indexErrors.map((e) => `Index not created — ${e}`),
      recorder?.overflow ? `It can't be undone: ${recorder.overflow}, too many for the undo history` : '',
    ].filter(Boolean);
    const message = result.cancelled
      ? `Copy cancelled after ${result.copied.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} documents; those stay in ${where}.`
      : `Copied ${parts.join(' and ')} to ${where} in ${seconds} s.${details.length ? ` ${details.join('. ')}.` : ''}`;
    const show = result.cancelled || details.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const next = await show(message, 'Open', ...(entry ? ['Undo'] : []));
    if (next === 'Open') this.opened(ref);
    if (next === 'Undo' && entry) void UndoHistory.get()?.undoAndReport(entry.id);
  }
}
