// GridFS buckets: one tab per bucket listing its files, to upload, download, open, preview, rename and
// delete them, and to edit their metadata. Files are streamed in both directions.
import * as vscode from 'vscode';
import { createReadStream, createWriteStream, promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { BSON, Document, GridFSBucket, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { DocumentFileSystem } from './documentFs';
import type { GridFSHostMessage, GridFSViewMessage, GridFile, GridSort } from './shared/messages';
import { hexDump } from './shared/gridfs';
import { relaxEjson, toShell } from './shared/query';
import { toBson } from './queries';
import { errorMessage } from './tree';

const { EJSON } = BSON;
const canonical = (v: unknown) => EJSON.serialize(v, { relaxed: false }) as unknown;
const relaxed = (v: unknown) => relaxEjson(canonical(v));
const keyOf = (id: unknown) => JSON.stringify(canonical(id));
const idOf = (key: string) => EJSON.deserialize({ v: JSON.parse(key) } as Document, { relaxed: false }).v;

/** Largest image shown in the tab, and how much of a text file. */
const PREVIEW_IMAGE_MAX = 4 * 1024 * 1024;
const PREVIEW_TEXT_MAX = 256 * 1024;

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

export function contentTypeOf(filename: string): string | undefined {
  return MIME[path.extname(filename).toLowerCase()];
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/svg+xml']);
const isTextType = (t: string | undefined) => !!t && (t.startsWith('text/') || /json|xml|yaml|javascript/.test(t));

export interface BucketTarget {
  connectionId: string;
  database: string;
  bucket: string;
}

const targetKey = (t: BucketTarget) => [t.connectionId, t.database, t.bucket].join('\u0000');

function toFile(doc: Document): GridFile {
  const raw = relaxed(doc) as Record<string, unknown>;
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const date = raw.uploadDate as { $date?: string } | undefined;
  return {
    key: keyOf(doc._id),
    id: toShell(raw._id),
    filename: String(doc.filename ?? ''),
    length: Number(doc.length ?? 0),
    chunkSize: Number(doc.chunkSize ?? 0),
    uploadDate: date?.$date,
    contentType: (typeof metadata?.contentType === 'string' ? metadata.contentType : undefined) ?? (typeof raw.contentType === 'string' ? raw.contentType : undefined),
    metadata,
    raw,
  };
}

/** The files filter: a mongosh filter ({ … }), or part of the file name (case-insensitive). */
export function filesFilter(search: string): Document {
  const text = search.trim();
  if (!text) return {};
  if (text.startsWith('{')) return toBson(text, 'Filter') ?? {};
  return { filename: { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
}

/** Byte counter for the progress notifications. */
function counter(total: number, report: (done: number) => void): Transform {
  let done = 0;
  let last = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      if (Date.now() - last > 200 || done === total) {
        last = Date.now();
        report(done);
      }
      cb(null, chunk);
    },
  });
}

function size(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * Uploads files into a bucket (created by the first upload), asking what to do with names that exist:
 * a new revision (GridFS keeps them all, the latest is the one read by name), replace or skip.
 * Returns a summary, or undefined when cancelled.
 */
export async function uploadFiles(client: MongoClient, target: BucketTarget, where: string, uris?: vscode.Uri[]): Promise<string | undefined> {
  const picked =
    uris ??
    (await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Upload', title: `Upload files to ${where}` }));
  if (!picked?.length) return undefined;
  const db = client.db(target.database);
  const bucket = new GridFSBucket(db, { bucketName: target.bucket });
  const files = db.collection(`${target.bucket}.files`);
  const names = picked.map((u) => path.basename(u.fsPath));
  const existing = new Set((await files.distinct('filename', { filename: { $in: names } })) as string[]);
  type Mode = 'revision' | 'replace' | 'skip';
  let mode: Mode = 'revision';
  if (existing.size) {
    type Item = vscode.QuickPickItem & { mode: Mode };
    const choice = await vscode.window.showQuickPick<Item>(
      [
        { label: 'Add a new revision', description: 'GridFS keeps both; reading by name gives the newest', mode: 'revision' },
        { label: 'Replace', description: 'delete the files with the same name first', mode: 'replace' },
        { label: 'Skip', description: 'upload only the new names', mode: 'skip' },
      ],
      { title: `${[...existing].slice(0, 3).join(', ')}${existing.size > 3 ? ` and ${existing.size - 3} more` : ''} already in ${where}`, ignoreFocusOut: true },
    );
    if (!choice) return undefined;
    mode = choice.mode;
  }
  const todo = picked.filter((u) => mode !== 'skip' || !existing.has(path.basename(u.fsPath)));
  const sizes = await Promise.all(todo.map(async (u) => (await fsp.stat(u.fsPath)).size));
  const total = sizes.reduce((a, b) => a + b, 0);
  let uploaded = 0;
  let bytes = 0;
  let cancelled = false;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Uploading to ${where}`, cancellable: true },
    async (progress, token) => {
      for (const [i, uri] of todo.entries()) {
        if (token.isCancellationRequested) {
          cancelled = true;
          break;
        }
        const name = path.basename(uri.fsPath);
        if (mode === 'replace' && existing.has(name)) {
          for (const old of await files.find({ filename: name }, { projection: { _id: 1 } }).toArray()) await bucket.delete(old._id);
        }
        const contentType = contentTypeOf(name);
        const upload = bucket.openUploadStream(name, { metadata: contentType ? { contentType } : {} });
        const abort = token.onCancellationRequested(() => void upload.abort().catch(() => undefined));
        try {
          await pipeline(
            createReadStream(uri.fsPath),
            counter(sizes[i], (done) => progress.report({ message: `${name} (${i + 1} of ${todo.length}) · ${size(bytes + done)} of ${size(total)}`, increment: undefined })),
            upload,
          );
          uploaded++;
          bytes += sizes[i];
        } catch (err) {
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          throw err;
        } finally {
          abort.dispose();
        }
      }
    },
  );
  const skipped = picked.length - todo.length;
  return [
    `Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'} (${size(bytes)}) to ${where}`,
    skipped ? `skipped ${skipped} that already existed` : '',
    cancelled ? 'cancelled' : '',
  ]
    .filter(Boolean)
    .join(', ') + '.';
}

export class GridFSPanel {
  private static readonly panels = new Map<string, GridFSPanel>();
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, documents: DocumentFileSystem, target: BucketTarget): GridFSPanel {
    const existing = GridFSPanel.panels.get(targetKey(target));
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const p = new GridFSPanel(context, connections, documents, target);
    GridFSPanel.panels.set(targetKey(target), p);
    return p;
  }

  /** Reloads the open tab of a bucket (after an upload from the tree). */
  static refresh(target: BucketTarget): void {
    GridFSPanel.panels.get(targetKey(target))?.post({ type: 'action', ok: true });
  }

  static connectionChanged(info: ConnectionInfo): void {
    for (const p of GridFSPanel.panels.values()) if (p.target.connectionId === info.id) p.postInit();
  }

  static close(connectionId: string, database?: string, bucket?: string): void {
    for (const p of [...GridFSPanel.panels.values()]) {
      if (p.target.connectionId === connectionId && (database === undefined || p.target.database === database) && (bucket === undefined || p.target.bucket === bucket)) p.panel.dispose();
    }
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly documents: DocumentFileSystem,
    private readonly target: BucketTarget,
  ) {
    this.panel = vscode.window.createWebviewPanel('mongoster.gridfs', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => GridFSPanel.panels.delete(targetKey(target)));
    this.panel.webview.onDidReceiveMessage((m: GridFSViewMessage) => void this.receive(m));
  }

  private title(): string {
    return `GridFS: ${this.target.bucket}`;
  }

  private info(): ConnectionInfo | undefined {
    return this.connections.get(this.target.connectionId);
  }

  private where(): string {
    return `${this.info()?.name ?? '?'} › ${this.target.database} › ${this.target.bucket}`;
  }

  private post(m: GridFSHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private postInit(): void {
    const info = this.info();
    this.post({ type: 'init', connectionName: info?.name ?? '?', readOnly: !!info?.readOnly, color: info?.color, database: this.target.database, bucket: this.target.bucket });
  }

  private async db() {
    return (await this.connections.getClient(this.target.connectionId)).db(this.target.database);
  }

  private async bucket(): Promise<GridFSBucket> {
    return new GridFSBucket(await this.db(), { bucketName: this.target.bucket });
  }

  private async file(key: string): Promise<GridFile> {
    const doc = await (await this.db()).collection(`${this.target.bucket}.files`).findOne({ _id: idOf(key) });
    if (!doc) throw new Error('The file no longer exists.');
    return toFile(doc);
  }

  private async receive(m: GridFSViewMessage): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'action', ok, message });
    const refuse = () => {
      if (!this.info()?.readOnly) return false;
      reply(false, `The connection ${this.info()?.name} is read-only: files can't be changed.`);
      return true;
    };
    try {
      switch (m.type) {
        case 'ready':
          this.postInit();
          break;
        case 'load':
          await this.load(m.requestId, m.search, m.sort, m.skip, m.limit);
          break;
        case 'upload': {
          if (refuse()) return;
          const message = await uploadFiles(await this.connections.getClient(this.target.connectionId), this.target, this.where());
          if (message) {
            reply(true, message);
            void vscode.commands.executeCommand('mongoster.refresh');
          }
          break;
        }
        case 'download':
          await this.download(m.key);
          break;
        case 'open':
          await this.open(m.key);
          break;
        case 'preview':
          await this.preview(m.key);
          break;
        case 'rename': {
          if (refuse()) return;
          const file = await this.file(m.key);
          const name = await vscode.window.showInputBox({
            title: `Rename ${file.filename}`,
            value: file.filename,
            valueSelection: [0, file.filename.length - path.extname(file.filename).length],
            validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
          });
          if (!name || name === file.filename) return;
          await (await this.bucket()).rename(idOf(m.key), name.trim());
          reply(true, `Renamed ${file.filename} to ${name.trim()}.`);
          break;
        }
        case 'delete': {
          if (refuse()) return;
          const file = await this.file(m.key);
          const answer = await vscode.window.showWarningMessage(
            `Delete ${file.filename} (${size(file.length)}) from ${this.where()}?`,
            { modal: true, detail: "Its chunks are deleted too. This can't be undone." },
            'Delete',
          );
          if (answer !== 'Delete') return reply(false);
          await (await this.bucket()).delete(idOf(m.key));
          reply(true, `Deleted ${file.filename}.`);
          break;
        }
        case 'editMetadata':
          await this.documents.open(
            { connectionId: this.target.connectionId, database: this.target.database, collection: `${this.target.bucket}.files`, readOnly: !!this.info()?.readOnly },
            idOf(m.key),
          );
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
          break;
      }
    } catch (err) {
      if (m.type === 'load') this.post({ type: 'files', requestId: m.requestId, error: errorMessage(err) });
      else if (m.type === 'preview') this.post({ type: 'preview', key: m.key, error: errorMessage(err) });
      else reply(false, errorMessage(err));
    }
  }

  private async load(requestId: number, search: string, sort: GridSort, skip: number, limit: number): Promise<void> {
    const files = (await this.db()).collection(`${this.target.bucket}.files`);
    const filter = filesFilter(search);
    const [docs, totals] = await Promise.all([
      files
        .find(filter)
        .sort({ [sort.field]: sort.desc ? -1 : 1, _id: sort.desc ? -1 : 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      files.aggregate([{ $match: filter }, { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$length' } } }]).toArray(),
    ]);
    this.post({ type: 'files', requestId, files: docs.map(toFile), total: Number(totals[0]?.n ?? 0), totalSize: Number(totals[0]?.bytes ?? 0) });
  }

  private async download(key: string): Promise<void> {
    const file = await this.file(key);
    const to = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), file.filename.split(/[\\/]/).pop() || 'download')),
      title: `Download ${file.filename}`,
    });
    if (!to) return;
    await this.save(file, to.fsPath, `Downloading ${file.filename}`);
    this.post({ type: 'action', ok: true, message: `Downloaded ${file.filename} (${size(file.length)}) to ${to.fsPath}.` });
  }

  private async save(file: GridFile, to: string, title: string): Promise<void> {
    const bucket = await this.bucket();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      const stream = bucket.openDownloadStream(idOf(file.key));
      const abort = token.onCancellationRequested(() => void stream.abort().catch(() => undefined));
      try {
        await pipeline(stream, counter(file.length, (done) => progress.report({ message: `${size(done)} of ${size(file.length)}` })), createWriteStream(to));
      } catch (err) {
        await fsp.rm(to, { force: true });
        throw token.isCancellationRequested ? new Error('Download cancelled.') : err;
      } finally {
        abort.dispose();
      }
    });
  }

  /** Downloads to a temporary folder and opens it in VS Code (text, images, PDFs… as VS Code shows them). */
  private async open(key: string): Promise<void> {
    const file = await this.file(key);
    const dir = path.join(os.tmpdir(), 'mongoster-gridfs', Buffer.from(`${targetKey(this.target)}\u0000${key}`).toString('base64url').slice(0, 48));
    await fsp.mkdir(dir, { recursive: true });
    const to = path.join(dir, path.basename(file.filename.replace(/[\\/:*?"<>|]/g, '_')) || 'file');
    await this.save(file, to, `Opening ${file.filename}`);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(to), { preview: true });
  }

  private async preview(key: string): Promise<void> {
    const file = await this.file(key);
    const type = file.contentType ?? contentTypeOf(file.filename);
    const image = !!type && IMAGE_TYPES.has(type);
    if (image && file.length > PREVIEW_IMAGE_MAX) {
      this.post({ type: 'preview', key, kind: 'binary', error: `The image is larger than ${size(PREVIEW_IMAGE_MAX)}: Open shows it in VS Code.` });
      return;
    }
    const end = image ? file.length : Math.min(file.length, PREVIEW_TEXT_MAX);
    const chunks: Buffer[] = [];
    if (end > 0) for await (const chunk of (await this.bucket()).openDownloadStream(idOf(key), { end })) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);
    if (image) {
      this.post({ type: 'preview', key, kind: 'image', dataUrl: `data:${type};base64,${data.toString('base64')}` });
      return;
    }
    const sample = data.subarray(0, 8192);
    let text: string | undefined;
    if (isTextType(type) || !sample.includes(0)) {
      try {
        text = new TextDecoder('utf-8', { fatal: !isTextType(type) }).decode(data.length < file.length ? trimUtf8(data) : data);
      } catch {
        text = undefined;
      }
    }
    if (text !== undefined) this.post({ type: 'preview', key, kind: 'text', text, truncated: data.length < file.length });
    else this.post({ type: 'preview', key, kind: 'binary', text: hexDump(data.subarray(0, 512)), truncated: file.length > 512 });
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'monitor.css')}">
  <link rel="stylesheet" href="${asset('media', 'gridfs.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>GridFS</title>
</head>
<body>
  <header class="bar">
    <span id="title" class="title"></span>
    <input id="search" type="search" placeholder="Filter by name, or { metadata.contentType: &quot;image/png&quot; }" spellcheck="false">
    <span id="summary" class="info"></span>
    <div class="spacer"></div>
    <button id="upload" class="not-locked" title="Upload files from disk">Upload…</button>
    <button id="refresh" class="secondary" title="Reload the files">Refresh</button>
  </header>
  <div id="error" class="error hidden"></div>
  <div id="message" class="message hidden"></div>
  <div class="table-wrap list"><table id="files" class="sortable"></table></div>
  <div class="pager">
    <button id="prev" class="secondary small">‹ Previous</button>
    <span id="page" class="info"></span>
    <button id="next" class="secondary small">Next ›</button>
  </div>
  <script nonce="${nonce}" src="${asset('dist', 'gridfs.js')}"></script>
</body>
</html>`;
  }
}

/** Drops an incomplete UTF-8 sequence at the end of a cut buffer. */
function trimUtf8(data: Buffer): Buffer {
  let end = data.length;
  let back = 0;
  while (end > 0 && back < 4 && (data[end - 1] & 0xc0) === 0x80) {
    end--;
    back++;
  }
  if (end > 0 && data[end - 1] >= 0xc0) end--;
  return data.subarray(0, end);
}

/** Deletes a whole bucket (its files and chunks collections) after confirmation. */
export async function dropBucket(client: MongoClient, target: BucketTarget, where: string): Promise<boolean> {
  const db = client.db(target.database);
  const files = await db.collection(`${target.bucket}.files`).estimatedDocumentCount();
  const answer = await vscode.window.showWarningMessage(
    `Delete the GridFS bucket ${where} and its ${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'}?`,
    { modal: true, detail: `Drops ${target.bucket}.files and ${target.bucket}.chunks. This can't be undone.` },
    'Delete',
  );
  if (answer !== 'Delete') return false;
  await new GridFSBucket(db, { bucketName: target.bucket }).drop();
  return true;
}
