// Export of query / pipeline results to JSON, JSON Lines or CSV, and import of such files into a collection.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import { BSON, Document, MongoBulkWriteError, ObjectId } from 'mongodb';
import { ConnectionManager } from './connections';
import { CollectionRef } from './documentFs';
import { QuerySource, buildPipeline, toBson } from './queries';
import { errorMessage } from './tree';
import { UndoHistory } from './history';
import type { HistoryEntry } from './shared/messages';
import { ColumnLayout, applyLayout, buildColumns } from './shared/columns';
import { csvTable, csvToDocs, parseCsv, toCsv } from './shared/csv';
import { isPlainObject, parseQuery, relaxEjson } from './shared/query';

const { EJSON } = BSON;

type Format = 'json' | 'jsonl' | 'csv';

const FORMATS: (vscode.QuickPickItem & { format: Format; ext: string })[] = [
  { label: 'JSON', description: 'Array of documents, readable (relaxed Extended JSON)', format: 'json', ext: 'json' },
  { label: 'JSON Lines', description: 'One document per line, canonical Extended JSON: keeps every type, re-importable', format: 'jsonl', ext: 'jsonl' },
  { label: 'CSV', description: 'The columns shown in the table; expanded arrays give one row per element', format: 'csv', ext: 'csv' },
];

export interface ExportOptions {
  /** Expanded column paths and the user's column layout, for the CSV columns. */
  expanded: string[];
  layout?: ColumnLayout;
  /** The page shown in the table, offered as an alternative to all results. */
  page?: { skip: number; limit: number };
  /** Total results, when known (for the scope picker). */
  count?: number | null;
}

/** Asks for format, scope and file, then streams the results to the file. Returns the number of documents written. */
export async function exportDocuments(
  connections: ConnectionManager,
  ref: CollectionRef,
  source: QuerySource,
  options: ExportOptions,
): Promise<number | undefined> {
  // Validate before asking anything.
  let open: (skip?: number, limit?: number) => Promise<AsyncIterable<Document> & { close(): Promise<void> }>;
  try {
    const client = await connections.getClient(ref.connectionId);
    const coll = client.db(ref.database).collection(ref.collection);
    if (source.kind === 'find') {
      const filter = toBson(source.filter, 'Filter') ?? {};
      const sort = toBson(source.sort, 'Sort');
      const projection = toBson(source.projection, 'Projection');
      open = async (skip, limit) => coll.find(filter, { sort, projection, skip, limit, promoteLongs: false, batchSize: 1000 });
    } else {
      const { pipeline, write } = buildPipeline(source.stages, source.upto);
      if (write) throw new Error(`A pipeline ending with ${write.op} writes to the database and can't be exported. Select an earlier stage to export its output.`);
      open = async (skip, limit) =>
        coll.aggregate(skip === undefined ? pipeline : [...pipeline, { $skip: skip }, { $limit: limit! }], {
          allowDiskUse: true,
          promoteLongs: false,
          batchSize: 1000,
        });
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Export failed: ${errorMessage(err)}`);
    return undefined;
  }

  const format = await vscode.window.showQuickPick(FORMATS, { title: `Export ${ref.collection}`, placeHolder: 'Format' });
  if (!format) return undefined;

  let page = options.page;
  if (page) {
    const all = `All results${options.count != null ? ` (${options.count.toLocaleString()} documents)` : ''}`;
    const scope = await vscode.window.showQuickPick([all, `Current page (${(page.skip + 1).toLocaleString()}–${(page.skip + page.limit).toLocaleString()})`], {
      title: `Export ${ref.collection} as ${format.label}`,
    });
    if (!scope) return undefined;
    if (scope === all) page = undefined;
  }

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const uri = await vscode.window.showSaveDialog({
    title: `Export ${ref.collection}`,
    defaultUri: vscode.Uri.joinPath(folder, `${ref.collection}.${format.ext}`),
    filters: { [format.label]: [format.ext] },
  });
  if (!uri) return undefined;

  let written = 0;
  try {
    const done = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${ref.collection}`, cancellable: true },
      async (progress, token) => {
        const cursor = await open(page?.skip, page?.limit);
        const out = new FileWriter(uri);
        const csvDocs: Record<string, unknown>[] = [];
        try {
          if (format.format === 'json') await out.write('[');
          for await (const doc of cursor) {
            if (token.isCancellationRequested) return false;
            if (format.format === 'jsonl') await out.write(EJSON.stringify(doc, { relaxed: false }) + '\n');
            else {
              const relaxed = relaxEjson(EJSON.serialize(doc, { relaxed: false })) as Record<string, unknown>;
              if (format.format === 'csv') csvDocs.push(relaxed);
              else await out.write((written ? ',\n' : '\n') + indent(JSON.stringify(relaxed, null, 2)));
            }
            written++;
            if (written % 1000 === 0) progress.report({ message: `${written.toLocaleString()} documents` });
          }
          if (format.format === 'json') await out.write(written ? '\n]\n' : ']\n');
          if (format.format === 'csv') {
            const columns = applyLayout(buildColumns(csvDocs, new Set(options.expanded)), options.layout ?? {});
            await out.write('﻿' + toCsv(csvTable(csvDocs, columns)));
          }
          await out.close();
          return true;
        } finally {
          await cursor.close();
          if (!out.closed) await out.abort();
        }
      },
    );
    if (!done) {
      void vscode.window.showInformationMessage('Export cancelled.');
      return undefined;
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Export failed: ${errorMessage(err)}`);
    return undefined;
  }

  void vscode.window
    .showInformationMessage(`Exported ${written.toLocaleString()} documents to ${path.basename(uri.path)}.`, 'Open', 'Reveal')
    .then((choice) => {
      if (choice === 'Open') void vscode.window.showTextDocument(uri);
      if (choice === 'Reveal') void vscode.commands.executeCommand('revealFileInOS', uri);
    });
  return written;
}

const indent = (text: string) => text.replace(/^/gm, '  ');

/** Streams to a local file; buffers and writes once for other file systems (remote workspaces). */
class FileWriter {
  private readonly stream?: fs.WriteStream;
  private readonly chunks: string[] = [];
  closed = false;

  constructor(private readonly uri: vscode.Uri) {
    if (uri.scheme === 'file') this.stream = fs.createWriteStream(uri.fsPath, { encoding: 'utf8' });
  }

  async write(text: string): Promise<void> {
    if (!this.stream) {
      this.chunks.push(text);
      return;
    }
    if (!this.stream.write(text)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.stream) {
      await vscode.workspace.fs.writeFile(this.uri, new TextEncoder().encode(this.chunks.join('')));
      return;
    }
    this.stream.end();
    await once(this.stream, 'finish');
  }

  /** Stops writing and removes the partial file. */
  async abort(): Promise<void> {
    this.closed = true;
    if (!this.stream) return;
    this.stream.destroy();
    await fs.promises.rm(this.uri.fsPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Import

/**
 * Documents in an import file: CSV (by extension), a JSON array, JSON Lines, or a single document.
 * Extended JSON keeps the types; mongosh syntax (ObjectId(...), ISODate(...)) is accepted too.
 */
export function parseImport(text: string, fileName: string): Document[] {
  let values: unknown[];
  if (/\.csv$/i.test(fileName)) {
    values = csvToDocs(parseCsv(text));
  } else {
    const trimmed = text.replace(/^﻿/, '').trim();
    if (!trimmed) return [];
    values = trimmed.startsWith('[') ? asArray(parseJson(trimmed)) : parseLines(trimmed);
  }
  return values.map((v, i) => {
    if (!isPlainObject(v)) throw new Error(`Document ${i + 1} is not an object`);
    return EJSON.deserialize(v, { relaxed: false }) as Document;
  });
}

/** Extended JSON, or mongosh syntax as a fallback. Values stay as EJSON plain objects. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    try {
      return parseQuery(text);
    } catch {
      throw err;
    }
  }
}

function asArray(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('Expected an array of documents');
  return v;
}

function parseLines(text: string): unknown[] {
  const lines = text.split(/\r?\n/);
  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      out.push(parseJson(lines[i]));
    } catch (err) {
      // Not JSON Lines: maybe one pretty-printed document.
      if (out.length === 0) {
        try {
          return [parseJson(text)];
        } catch {
          // report the line error below
        }
      }
      throw new Error(`Line ${i + 1}: ${errorMessage(err)}`);
    }
  }
  return out;
}

export interface ImportResult {
  inserted: number;
  failed: number;
  firstError?: string;
  /** The undo history entry of the import. */
  entry?: HistoryEntry;
}

/** Inserts in batches, unordered: one bad document (e.g. a duplicate _id) doesn't stop the others. */
export async function insertDocuments(
  connections: ConnectionManager,
  ref: CollectionRef,
  docs: Document[],
  report: (inserted: number) => void = () => undefined,
  cancelled: () => boolean = () => false,
  label = `Insert ${docs.length.toLocaleString('en-US')} documents`,
): Promise<ImportResult> {
  const client = await connections.getClient(ref.connectionId);
  const coll = client.db(ref.database).collection(ref.collection);
  const result: ImportResult = { inserted: 0, failed: 0 };
  const rec = UndoHistory.start(ref, label, docs.length);
  for (let i = 0; i < docs.length && !cancelled(); i += 1000) {
    const batch = docs.slice(i, i + 1000);
    // The _id of each document is known before inserting it, to delete it on undo.
    if (rec) for (const doc of batch) doc._id ??= new ObjectId();
    let failedAt = new Set<number>();
    try {
      result.inserted += (await coll.insertMany(batch, { ordered: false })).insertedCount;
    } catch (err) {
      if (!(err instanceof MongoBulkWriteError)) throw err;
      result.inserted += err.insertedCount;
      const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
      result.failed += errors.length;
      result.firstError ??= errors[0]?.errmsg ?? err.message;
      failedAt = new Set(errors.map((e) => e.index));
    }
    batch.forEach((doc, j) => failedAt.has(j) || rec?.addNew(doc._id));
    report(result.inserted);
  }
  result.entry = await rec?.commit(coll);
  return result;
}

/** Asks for a file, confirms, and inserts its documents. Returns the result, or undefined if cancelled. */
export async function importDocuments(connections: ConnectionManager, ref: CollectionRef): Promise<ImportResult | undefined> {
  if (ref.readOnly) {
    void vscode.window.showErrorMessage(`${ref.database}.${ref.collection} is read-only.`);
    return undefined;
  }
  const [uri] =
    (await vscode.window.showOpenDialog({
      title: `Import into ${ref.database}.${ref.collection}`,
      canSelectMany: false,
      filters: { 'JSON, JSON Lines, CSV': ['json', 'jsonl', 'ndjson', 'csv'], 'All files': ['*'] },
    })) ?? [];
  if (!uri) return undefined;
  const name = path.basename(uri.path);

  let docs: Document[];
  try {
    docs = parseImport(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), name);
  } catch (err) {
    void vscode.window.showErrorMessage(`Can't import ${name}: ${errorMessage(err)}`);
    return undefined;
  }
  if (!docs.length) {
    void vscode.window.showWarningMessage(`${name} contains no documents.`);
    return undefined;
  }

  const withId = docs.filter((d) => d._id !== undefined).length;
  const answer = await vscode.window.showWarningMessage(
    `Import ${docs.length.toLocaleString()} documents from ${name} into ${ref.database}.${ref.collection}?`,
    {
      modal: true,
      detail: [
        withId ? `${withId.toLocaleString()} of them have an _id: documents whose _id already exists are skipped.` : 'New _id values will be generated.',
        UndoHistory.note(ref.connectionId, docs.length),
      ].join('\n'),
    },
    'Import',
  );
  if (answer !== 'Import') return undefined;

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Importing ${name}`, cancellable: true },
      (progress, token) =>
        insertDocuments(
          connections,
          ref,
          docs,
          (n) => progress.report({ message: `${n.toLocaleString()} of ${docs.length.toLocaleString()}`, increment: (1000 / docs.length) * 100 }),
          () => token.isCancellationRequested,
          `Import ${name}`,
        ),
    );
    const summary = `Imported ${result.inserted.toLocaleString()} of ${docs.length.toLocaleString()} documents into ${ref.collection}.`;
    if (result.failed) void vscode.window.showWarningMessage(`${summary} ${result.failed.toLocaleString()} failed: ${result.firstError}`);
    else UndoHistory.notify(summary, result.entry);
    return result;
  } catch (err) {
    void vscode.window.showErrorMessage(`Import failed: ${errorMessage(err)}`);
    return undefined;
  }
}
