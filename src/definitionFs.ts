// Collection definitions as editable JSON files, applied with collMod on save:
//   mongoster-def://<connectionId>/<db>/<collection>/validation.json  → validator, validationLevel, validationAction
//   mongoster-def://<connectionId>/<db>/<view>/view.json              → viewOn, pipeline
import * as vscode from 'vscode';
import { BSON, Document } from 'mongodb';
import type { ConnectionManager } from './connections';
import type { CollectionRef } from './documentFs';
import { errorMessage } from './tree';
import { isPlainObject, parseQuery, relaxEjson } from './shared/query';
import { analyzeSchema, toJsonSchema } from './shared/schema';

const { EJSON } = BSON;

export const DEF_SCHEME = 'mongoster-def';
export type DefinitionKind = 'validation' | 'view';

const VALIDATION_KEYS = ['validator', 'validationLevel', 'validationAction'];
const SAMPLE = 1000;

interface Target {
  ref: CollectionRef;
  kind: DefinitionKind;
}

export class DefinitionFileSystem implements vscode.FileSystemProvider {
  private readonly fileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.fileEmitter.event;
  private readonly savedEmitter = new vscode.EventEmitter<CollectionRef>();
  /** Fired after a definition was applied (a view's results may have changed). */
  readonly onDidSave = this.savedEmitter.event;
  private readonly mtimes = new Map<string, number>();
  /** Validation files whose content was generated from the documents, not read from the collection. */
  private readonly generated = new Map<string, number>();

  constructor(private readonly connections: ConnectionManager) {}

  async open(ref: CollectionRef, kind: DefinitionKind): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: DEF_SCHEME,
      authority: ref.connectionId,
      path: `/${encodeURIComponent(ref.database)}/${encodeURIComponent(ref.collection)}/${kind}.json`,
      query: ref.readOnly ? 'ro=1' : '',
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const sampled = this.generated.get(uri.toString());
    if (sampled !== undefined) {
      void vscode.window.showInformationMessage(
        `${ref.collection} has no validation rules: this $jsonSchema was generated from ${sampled.toLocaleString('en-US')} documents. ` +
          'Review it, then save (Ctrl+S) to apply it. validationAction "warn" only logs invalid documents.',
      );
    }
  }

  // ---- FileSystemProvider

  stat(uri: vscode.Uri): vscode.FileStat {
    const { ref } = parse(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.mtimes.get(uri.toString()) ?? 0,
      size: 0,
      permissions: ref.readOnly ? vscode.FilePermission.Readonly : undefined,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { ref, kind } = parse(uri);
    const db = await this.db(ref);
    const info = (await db.listCollections({ name: ref.collection }).toArray())[0] as Document | undefined;
    if (!info) throw vscode.FileSystemError.FileNotFound(uri);
    const options = (info.options ?? {}) as Document;
    let content: Document;
    if (kind === 'view') {
      if (info.type !== 'view') throw new Error(`${ref.collection} is not a view`);
      content = { viewOn: options.viewOn, pipeline: options.pipeline ?? [] };
    } else if (options.validator && Object.keys(options.validator).length) {
      content = {
        validator: options.validator,
        validationLevel: options.validationLevel ?? 'strict',
        validationAction: options.validationAction ?? 'error',
      };
    } else {
      const docs = await db
        .collection(ref.collection)
        .aggregate([{ $sample: { size: SAMPLE } }], { promoteValues: false, maxTimeMS: 60_000 })
        .toArray();
      const summary = analyzeSchema(docs.map((d) => EJSON.serialize(d, { relaxed: false })));
      content = {
        validator: summary.sampled ? { $jsonSchema: toJsonSchema(summary) } : {},
        validationLevel: 'strict',
        validationAction: 'error',
      };
      if (summary.sampled) this.generated.set(uri.toString(), summary.sampled);
    }
    if (!this.mtimes.has(uri.toString())) this.mtimes.set(uri.toString(), Date.now());
    return new TextEncoder().encode(JSON.stringify(relaxEjson(EJSON.serialize(content, { relaxed: false })), null, 2) + '\n');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { ref, kind } = parse(uri);
    if (ref.readOnly) throw vscode.FileSystemError.NoPermissions('The connection is read-only');
    let parsed: unknown;
    try {
      parsed = parseQuery(new TextDecoder().decode(content));
    } catch (err) {
      throw new Error(`Invalid definition: ${errorMessage(err)}`);
    }
    if (!isPlainObject(parsed)) throw new Error('The definition must be a JSON object');
    const value = EJSON.deserialize(parsed, { relaxed: false }) as Document;
    const command: Document = { collMod: ref.collection };
    if (kind === 'view') {
      if (typeof value.viewOn !== 'string' || !value.viewOn) throw new Error('viewOn: the name of the source collection or view');
      if (!Array.isArray(value.pipeline)) throw new Error('pipeline: an array of stages');
      const extra = Object.keys(value).filter((k) => k !== 'viewOn' && k !== 'pipeline');
      if (extra.length) throw new Error(`Unknown field ${extra[0]}: a view has viewOn and pipeline`);
      Object.assign(command, { viewOn: value.viewOn, pipeline: value.pipeline });
    } else {
      const extra = Object.keys(value).filter((k) => !VALIDATION_KEYS.includes(k));
      if (extra.length) throw new Error(`Unknown field ${extra[0]}: use ${VALIDATION_KEYS.join(', ')}`);
      if (value.validator !== undefined && !isPlainObject(value.validator)) throw new Error('validator must be an object ({} removes the rules)');
      for (const key of VALIDATION_KEYS) if (value[key] !== undefined) command[key] = value[key];
    }
    try {
      await (await this.db(ref)).command(command);
    } catch (err) {
      throw new Error(`Not applied: ${errorMessage(err)}`);
    }
    this.generated.delete(uri.toString());
    this.mtimes.set(uri.toString(), Date.now());
    void vscode.window.showInformationMessage(
      kind === 'view' ? `Saved view ${ref.database}.${ref.collection}.` : `Applied the validation rules of ${ref.database}.${ref.collection}.`,
    );
    this.savedEmitter.fire(ref);
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

  private async db(ref: CollectionRef) {
    return (await this.connections.getClient(ref.connectionId)).db(ref.database);
  }
}

function parse(uri: vscode.Uri): Target {
  const [database, collection, file] = uri.path.split('/').slice(1, 4).map(decodeURIComponent);
  return {
    ref: { connectionId: uri.authority, database, collection, readOnly: uri.query.includes('ro=1') },
    kind: file === 'view.json' ? 'view' : 'validation',
  };
}
