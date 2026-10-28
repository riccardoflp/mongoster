// "Generate Documents…": fake documents that look like a collection's, from its schema analysis (the one
// shown in the Schema tab, or a sample of 1,000), inserted into it or into another collection on any
// connection, in batches with progress, Cancel, the undo history and Open.
import * as vscode from 'vscode';
import { BSON, Collection, Document, MongoBulkWriteError, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { CollectionRef } from './documentFs';
import { collectionNameError, databaseNameError } from './manage';
import { errorMessage } from './tree';
import { UndoHistory } from './history';
import { analyzeSchema, type SchemaSummary } from './shared/schema';
import { DocumentGenerator, seededRandom } from './shared/generate';
import { relaxEjson, toShell } from './shared/query';

const { EJSON } = BSON;

export const GENERATE_MAX = 1_000_000;
const BATCH = 1000;
const SAMPLE = 1000;
const PREVIEW = 3;

export interface GenerateSource extends CollectionRef {
  view: boolean;
  /** The analysis shown in the Schema tab; without it a random sample of 1,000 documents is analyzed. */
  schema?: SchemaSummary;
  /** The filter of that analysis, in mongosh syntax. */
  filter?: string;
}

type Pick<T> = vscode.QuickPickItem & { value: T };

export class Generator {
  constructor(
    private readonly connections: ConnectionManager,
    /** Opens the collection's tab. */
    private readonly opened: (ref: CollectionRef) => void,
    /** Refreshes the tree and the collection's tab after inserting. */
    private readonly changed: (ref: CollectionRef) => void,
  ) {}

  async start(source: GenerateSource): Promise<void> {
    const srcInfo = this.connections.get(source.connectionId);
    if (!srcInfo) return;
    const name = `${source.database}.${source.collection}`;
    const title = (step: string) => `Generate documents like ${name}: ${step}`;

    // The analysis to imitate
    let schema = source.schema;
    if (!schema) {
      try {
        schema = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Analyzing a sample of ${name}` },
          async () => {
            const client = await this.connections.getClient(srcInfo.id);
            const coll = client.db(source.database).collection(source.collection);
            // promoteValues: false keeps Int32 and Double apart, so the types are imitated exactly.
            const docs = await coll.aggregate([{ $sample: { size: SAMPLE } }], { promoteValues: false, maxTimeMS: 120_000, allowDiskUse: true }).toArray();
            return analyzeSchema(docs.map((d) => EJSON.serialize(d, { relaxed: false })), { details: true });
          },
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not analyze ${name}: ${errorMessage(err)}`);
        return;
      }
    }
    if (!schema.sampled) {
      void vscode.window.showWarningMessage(
        source.schema ? 'No documents match the filter: there is nothing to imitate.' : `${name} has no documents to imitate.`,
      );
      return;
    }

    // How many
    const countText = await vscode.window.showInputBox({
      title: title('how many'),
      prompt: `Number of documents to generate (up to ${GENERATE_MAX.toLocaleString('en-US')}), like the ${schema.sampled.toLocaleString('en-US')} analyzed`,
      value: '100',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const n = parseCount(v);
        return n === undefined ? `A whole number from 1 to ${GENERATE_MAX.toLocaleString('en-US')}` : undefined;
      },
    });
    if (countText === undefined) return;
    const count = parseCount(countText)!;

    // Where
    const target = await this.pickTarget(source, srcInfo, title);
    if (!target) return;
    const { info: dstInfo, ref } = target;
    const where = `${dstInfo.name} › ${ref.database}.${ref.collection}`;

    // Seed
    const seed = await vscode.window.showInputBox({
      title: title('seed (optional)'),
      prompt: 'The same seed and analysis give the same documents (new ObjectId _ids still differ); leave empty for random ones',
      placeHolder: 'e.g. 42',
      ignoreFocusOut: true,
    });
    if (seed === undefined) return;

    let coll: Collection;
    let nextId: number | undefined;
    try {
      const client = await this.connections.getClient(dstInfo.id);
      coll = client.db(ref.database).collection(ref.collection);
      // Integer _ids continue after the largest one of the destination.
      const idType = schema.fields.find((f) => f.name === '_id')?.types[0]?.type;
      if (idType === 'int' || idType === 'long') {
        const [last] = await coll.find({ _id: { $type: 'number' } } as Document, { projection: { _id: 1 }, sort: { _id: -1 }, limit: 1 }).toArray();
        if (last && Number.isFinite(Number(last._id))) nextId = Math.floor(Number(last._id)) + 1;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${dstInfo.name}: ${errorMessage(err)}`);
      return;
    }

    const generator = new DocumentGenerator(schema, { random: seed.trim() ? seededRandom(seed.trim()) : undefined, nextId });
    const preview = Array.from({ length: Math.min(PREVIEW, count) }, () => generator.next());

    // Confirm, with a preview
    const analyzed = `${schema.sampled.toLocaleString('en-US')} document${schema.sampled === 1 ? '' : 's'} analyzed in ${srcInfo.name} › ${name}${source.filter?.trim() ? ` matching ${source.filter.trim()}` : ''}`;
    const answer = await vscode.window.showWarningMessage(
      `Insert ${count.toLocaleString('en-US')} generated document${count === 1 ? '' : 's'} into ${where}?`,
      {
        modal: true,
        detail: [
          `They look like the ${analyzed}${seed.trim() ? `, seed ${seed.trim()}` : ''}. For example:`,
          ...preview.map((d) => clip(toShell(relaxEjson(d)), 400)),
          '',
          ...(dstInfo.redisOplog ? ['Like Import, the inserts are not published to Redis for redis-oplog.'] : []),
          UndoHistory.note(dstInfo.id, count),
        ].join('\n'),
      },
      'Insert',
    );
    if (answer !== 'Insert') return;

    // Insert in batches
    const started = Date.now();
    const recorder = UndoHistory.start(ref, `Generate ${count.toLocaleString('en-US')} documents like ${name}`, count);
    let inserted = 0;
    let failed = 0;
    let firstError: string | undefined;
    let cancelled = false;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Generating documents into ${where}`, cancellable: true },
        async (progress, token) => {
          for (let done = 0; done < count; ) {
            const size = Math.min(BATCH, count - done);
            const canonical = done === 0 ? [...preview, ...Array.from({ length: size - preview.length }, () => generator.next())] : Array.from({ length: size }, () => generator.next());
            const batch = canonical.map((d) => EJSON.deserialize(d, { relaxed: false }) as Document);
            let failedAt = new Set<number>();
            try {
              inserted += (await coll.insertMany(batch, { ordered: false })).insertedCount;
            } catch (err) {
              if (!(err instanceof MongoBulkWriteError)) throw err;
              inserted += err.insertedCount;
              const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
              failed += errors.length;
              firstError ??= errors[0]?.errmsg ?? err.message;
              failedAt = new Set(errors.map((e) => e.index));
            }
            if (recorder && !recorder.overflow) batch.forEach((doc, i) => failedAt.has(i) || recorder.addNew(doc._id));
            done += size;
            progress.report({
              increment: (size / count) * 100,
              message: `${inserted.toLocaleString('en-US')} of ${count.toLocaleString('en-US')} documents`,
            });
            if (done < count && token.isCancellationRequested) {
              cancelled = true;
              break;
            }
          }
        },
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Generating documents failed after ${inserted.toLocaleString('en-US')} inserted: ${errorMessage(err)}`);
      if (inserted) this.changed(ref);
      return;
    }
    const entry = await recorder?.commit(coll);
    this.changed(ref);

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const details = [
      failed ? `${failed.toLocaleString('en-US')} failed: ${firstError}` : '',
      recorder?.overflow ? `It can't be undone: ${recorder.overflow}, too many for the undo history` : '',
    ].filter(Boolean);
    const message = cancelled
      ? `Generation cancelled after ${inserted.toLocaleString('en-US')} of ${count.toLocaleString('en-US')} documents; those stay in ${where}.`
      : `Inserted ${inserted.toLocaleString('en-US')} generated document${inserted === 1 ? '' : 's'} into ${where} in ${seconds} s.${details.length ? ` ${details.join('. ')}.` : ''}`;
    const show = cancelled || details.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const next = await show(message, 'Open', ...(entry ? ['Undo'] : []));
    if (next === 'Open') this.opened(ref);
    if (next === 'Undo' && entry) void UndoHistory.get()?.undoAndReport(entry.id);
  }

  /** This collection, or another one (new or existing) on any connection that isn't read-only. */
  private async pickTarget(
    source: GenerateSource,
    srcInfo: ConnectionInfo,
    title: (step: string) => string,
  ): Promise<{ info: ConnectionInfo; ref: CollectionRef } | undefined> {
    const here = { connectionId: srcInfo.id, database: source.database, collection: source.collection };
    if (!srcInfo.readOnly && !source.view) {
      const pick = await vscode.window.showQuickPick<Pick<boolean>>(
        [
          { label: '$(database) This collection', description: `${srcInfo.name} › ${source.database}.${source.collection}`, value: true },
          { label: '$(arrow-right) Another collection…', description: 'new or existing, on any connection', value: false },
        ],
        { title: title('destination'), ignoreFocusOut: true },
      );
      if (!pick) return undefined;
      if (pick.value) return { info: srcInfo, ref: here };
    }

    // Connection
    const others = this.connections.list().filter((c) => c.id !== srcInfo.id);
    const connection = await vscode.window.showQuickPick<Pick<ConnectionInfo>>(
      [srcInfo, ...others].map((c) => ({
        label: `$(${c.readOnly ? 'lock' : 'server'}) ${c.name}`,
        description: [c.id === srcInfo.id ? 'same connection' : '', c.readOnly ? 'read-only' : '', c.folder ?? ''].filter(Boolean).join(' · '),
        value: c,
      })),
      { title: title('destination connection'), placeHolder: 'Where the generated documents go', ignoreFocusOut: true },
    );
    if (!connection) return undefined;
    const info = connection.value;
    if (info.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${info.name} is read-only.`);
      return undefined;
    }
    let databases: string[];
    let client: MongoClient;
    try {
      client = await this.connections.getClient(info.id);
      databases = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${info.name}: ${errorMessage(err)}`);
      return undefined;
    }

    // Database
    const NEW = '$(add) New database…';
    const ordered = [...databases.filter((d) => d === source.database), ...databases.filter((d) => d !== source.database && !['admin', 'local', 'config'].includes(d))];
    const dbPick = await vscode.window.showQuickPick([...ordered, NEW], { title: title(`database on ${info.name}`), ignoreFocusOut: true });
    if (!dbPick) return undefined;
    const database =
      dbPick === NEW
        ? (
            await vscode.window.showInputBox({
              title: title('new database'),
              prompt: `Database name on ${info.name}`,
              ignoreFocusOut: true,
              validateInput: (v) => databaseNameError(v.trim()) ?? (databases.includes(v.trim()) ? 'This database already exists' : undefined),
            })
          )?.trim()
        : dbPick;
    if (!database) return undefined;

    // Collection
    const existing = await client
      .db(database)
      .listCollections({}, { nameOnly: true })
      .toArray()
      .then((list) => new Map(list.map((c) => [c.name, c.type ?? 'collection'])))
      .catch(() => new Map<string, string>());
    const sameDb = info.id === srcInfo.id && database === source.database;
    const collection = (
      await vscode.window.showInputBox({
        title: title('destination collection'),
        prompt: `Collection in ${info.name} › ${database}: a new one, or an existing one to add the documents to`,
        value: sameDb ? `${source.collection}_generated` : source.collection,
        ignoreFocusOut: true,
        validateInput: (v) =>
          collectionNameError(v.trim()) ?? (existing.get(v.trim()) === 'view' ? 'A view has this name: views are read-only' : undefined),
      })
    )?.trim();
    if (!collection) return undefined;
    return { info, ref: { connectionId: info.id, database, collection } };
  }
}

function parseCount(text: string): number | undefined {
  const s = text.replace(/[\s,_']/g, '');
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= GENERATE_MAX ? n : undefined;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
