// Playgrounds: *.mongodb.js files run with Ctrl+Enter on a chosen connection, with the result beside,
// a CodeLens and status bar item showing (and changing) the connection, and query completion.
import * as vscode from 'vscode';
import { BSON, Document } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from '../connections';
import { errorMessage } from '../tree';
import { CompletionItem as QueryItem, FieldHint, complete, fieldHints } from '../shared/complete';
import { analyzeSchema } from '../shared/schema';
import { argumentKind, callAt, databaseAt, memberAt } from './context';
import { PlaygroundError, RESULT_LIMIT, runPlayground } from './shell';
import { PlaygroundResultPanel } from './resultPanel';
import { RedisOplog } from '../redisOplog';

const { EJSON } = BSON;

/** Connection and default database of a playground (`use()` in the script takes precedence). */
interface Target {
  connectionId: string;
  database: string;
}

const TARGETS_KEY = 'mongoster.playgroundTargets';
const FIELD_SAMPLE = 300;
const CACHE_MS = 120_000;

export const isPlayground = (doc: vscode.TextDocument) => doc.uri.path.endsWith('.mongodb.js');

const DB_METHODS: [string, string][] = [
  ['getCollection', 'getCollection("$0")'],
  ['getCollectionNames', 'getCollectionNames()'],
  ['getCollectionInfos', 'getCollectionInfos($0)'],
  ['getName', 'getName()'],
  ['getSiblingDB', 'getSiblingDB("$0")'],
  ['aggregate', 'aggregate([$0])'],
  ['runCommand', 'runCommand({ $0 })'],
  ['adminCommand', 'adminCommand({ $0 })'],
  ['stats', 'stats()'],
  ['serverStatus', 'serverStatus()'],
  ['version', 'version()'],
  ['currentOp', 'currentOp()'],
  ['createCollection', 'createCollection("$0")'],
  ['createView', 'createView("$1", "$2", [$0])'],
  ['dropDatabase', 'dropDatabase()'],
];

const COLLECTION_METHODS: [string, string][] = [
  ['find', 'find({ $0 })'],
  ['findOne', 'findOne({ $0 })'],
  ['aggregate', 'aggregate([\n\t{ $0 }\n])'],
  ['countDocuments', 'countDocuments({ $0 })'],
  ['estimatedDocumentCount', 'estimatedDocumentCount()'],
  ['distinct', 'distinct("$0")'],
  ['insertOne', 'insertOne({ $0 })'],
  ['insertMany', 'insertMany([$0])'],
  ['updateOne', 'updateOne({ $1 }, { \\$set: { $0 } })'],
  ['updateMany', 'updateMany({ $1 }, { \\$set: { $0 } })'],
  ['replaceOne', 'replaceOne({ $1 }, { $0 })'],
  ['deleteOne', 'deleteOne({ $0 })'],
  ['deleteMany', 'deleteMany({ $0 })'],
  ['findOneAndUpdate', 'findOneAndUpdate({ $1 }, { \\$set: { $0 } })'],
  ['findOneAndReplace', 'findOneAndReplace({ $1 }, { $0 })'],
  ['findOneAndDelete', 'findOneAndDelete({ $0 })'],
  ['bulkWrite', 'bulkWrite([$0])'],
  ['createIndex', 'createIndex({ $0 })'],
  ['getIndexes', 'getIndexes()'],
  ['dropIndex', 'dropIndex("$0")'],
  ['stats', 'stats()'],
  ['drop', 'drop()'],
  ['renameCollection', 'renameCollection("$0")'],
];

const CURSOR_METHODS: [string, string][] = [
  ['sort', 'sort({ $0 })'],
  ['limit', 'limit($0)'],
  ['skip', 'skip($0)'],
  ['project', 'project({ $0 })'],
  ['toArray', 'toArray()'],
  ['count', 'count()'],
  ['forEach', 'forEach((doc) => $0)'],
  ['map', 'map((doc) => $0)'],
  ['hint', 'hint({ $0 })'],
  ['collation', 'collation({ locale: "$0" })'],
  ['maxTimeMS', 'maxTimeMS($0)'],
  ['explain', 'explain("executionStats")'],
  ['hasNext', 'hasNext()'],
  ['next', 'next()'],
  ['itcount', 'itcount()'],
];

export class Playgrounds implements vscode.Disposable {
  private readonly targets = new Map<string, Target>();
  private readonly output = vscode.window.createOutputChannel('Mongoster Playground');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fieldCache = new Map<string, { at: number; hints: Promise<FieldHint[]> }>();
  private readonly collectionCache = new Map<string, { at: number; names: Promise<string[]> }>();
  private running = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
  ) {
    for (const [uri, target] of Object.entries(context.workspaceState.get<Record<string, Target>>(TARGETS_KEY) ?? {})) {
      this.targets.set(uri, target);
    }
    this.status.command = 'mongoster.changePlaygroundConnection';
    this.disposables.push(
      this.output,
      this.status,
      this.lensChanged,
      vscode.commands.registerCommand('mongoster.newPlayground', (node?: unknown) => this.create(node)),
      vscode.commands.registerCommand('mongoster.runPlayground', () => this.run()),
      vscode.commands.registerCommand('mongoster.changePlaygroundConnection', () => this.change()),
      vscode.languages.registerCodeLensProvider(
        { language: 'javascript', pattern: '**/*.mongodb.js' },
        { onDidChangeCodeLenses: this.lensChanged.event, provideCodeLenses: (doc) => this.lenses(doc) },
      ),
      vscode.languages.registerCompletionItemProvider(
        [
          { language: 'javascript', pattern: '**/*.mongodb.js' },
          { language: 'javascript', scheme: 'untitled' },
        ],
        { provideCompletionItems: (doc, pos) => this.completions(doc, pos) },
        '.', '$', '"', "'", '{', ':', '[', ',',
      ),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.updateStatus();
      }),
      connections.onDidChange(() => {
        this.lensChanged.fire();
        this.updateStatus();
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.isUntitled) this.targets.delete(doc.uri.toString());
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          const target = this.targets.get(oldUri.toString());
          if (target) void this.setTarget(newUri, target);
        }
      }),
      // Saving an untitled playground keeps its connection.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isPlayground(doc) && !this.targets.has(doc.uri.toString())) {
          const untitled = [...this.targets.keys()].find((k) => k.startsWith('untitled:') && k.endsWith(doc.uri.path.split('/').pop()!));
          if (untitled) void this.setTarget(doc.uri, this.targets.get(untitled)!);
        }
      }),
    );
    this.updateStatus();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- creating and targeting

  /** Opens a new playground on the connection / database / collection of a tree node, if any. */
  private async create(node?: unknown): Promise<void> {
    const n = node as { connection?: ConnectionInfo; info?: ConnectionInfo; database?: string; collection?: string } | undefined;
    const connection = n?.connection ?? n?.info;
    const database = n?.database;
    const collection = n?.collection;
    const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
    let i = 1;
    let uri: vscode.Uri;
    do uri = vscode.Uri.from({ scheme: 'untitled', path: `playground-${i++}.mongodb.js` });
    while (open.has(uri.toString()));
    const ref = collection
      ? /^[A-Za-z_$][\w$]*$/.test(collection) && !['getCollection', 'getName', 'aggregate', 'stats', 'version'].includes(collection)
        ? `db.${collection}`
        : `db.getCollection(${JSON.stringify(collection)})`
      : undefined;
    const lines = [
      '// Mongoster playground: Ctrl+Enter runs the script (or the selected lines) on the connection shown above.',
      '// mongosh syntax; the value of the last expression is shown beside, print() and printjson() write to the output.',
      '',
      ...(database ? [`use(${JSON.stringify(database)});`, ''] : []),
      ref ? `${ref}.find({}).limit(20);` : database ? 'db.getCollectionNames();' : 'db.getMongo().getDBNames();',
      '',
    ];
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), lines.join('\n')));
    const last = doc.lineCount - 2;
    editor.selection = new vscode.Selection(last, doc.lineAt(last).text.length, last, doc.lineAt(last).text.length);
    if (connection) await this.setTarget(uri, { connectionId: connection.id, database: database ?? 'test' });
    this.updateStatus();
  }

  private async setTarget(uri: vscode.Uri, target: Target): Promise<void> {
    this.targets.set(uri.toString(), target);
    if (uri.scheme !== 'untitled') {
      const saved = this.context.workspaceState.get<Record<string, Target>>(TARGETS_KEY) ?? {};
      await this.context.workspaceState.update(TARGETS_KEY, { ...saved, [uri.toString()]: target });
    }
    this.lensChanged.fire();
    this.updateStatus();
  }

  /** The playground's target, if its connection still exists. */
  private target(doc: vscode.TextDocument): Target | undefined {
    const t = this.targets.get(doc.uri.toString());
    return t && this.connections.get(t.connectionId) ? t : undefined;
  }

  /** Asks for the connection and default database of the active playground. */
  private async change(doc = vscode.window.activeTextEditor?.document): Promise<Target | undefined> {
    if (!doc) return undefined;
    const list = this.connections.list();
    if (!list.length) {
      void vscode.window.showInformationMessage('Add a connection in the Mongoster view first.');
      return undefined;
    }
    const current = this.target(doc);
    const picked = await vscode.window.showQuickPick(
      list.map((c) => ({
        label: `$(${c.readOnly ? 'lock' : 'server'}) ${c.name}`,
        description: [c.id === current?.connectionId ? 'current' : '', this.connections.isConnected(c.id) ? 'connected' : '', c.readOnly ? 'read-only' : '']
          .filter(Boolean)
          .join(' · '),
        detail: c.folder,
        info: c,
      })),
      { title: 'Playground Connection', placeHolder: 'Connection the playground runs on' },
    );
    if (!picked) return undefined;
    let names: string[] = [];
    try {
      const client = await this.connections.getClient(picked.info.id);
      names = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${picked.info.name}: ${errorMessage(err)}`);
      return undefined;
    }
    const other = '$(edit) Other database…';
    const db = await vscode.window.showQuickPick([...names, other], {
      title: `Default database on ${picked.info.name}`,
      placeHolder: 'Used until the script calls use("…")',
    });
    if (!db) return undefined;
    const database =
      db === other
        ? (await vscode.window.showInputBox({ title: 'Default database', prompt: 'Database name', validateInput: (v) => (v.trim() ? undefined : 'Required') }))?.trim()
        : db;
    if (!database) return undefined;
    const target = { connectionId: picked.info.id, database };
    await this.setTarget(doc.uri, target);
    return target;
  }

  private label(doc: vscode.TextDocument): string | undefined {
    const t = this.target(doc);
    if (!t) return undefined;
    const info = this.connections.get(t.connectionId)!;
    return `${info.name} › ${databaseAt(doc.getText(), doc.getText().length) ?? t.database}${info.readOnly ? ' (read-only)' : ''}`;
  }

  private updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isPlayground(doc)) {
      this.status.hide();
      return;
    }
    const label = this.label(doc);
    this.status.text = `$(database) ${label ?? 'Choose a connection'}`;
    this.status.tooltip = 'Mongoster: connection and database of this playground — click to change';
    this.status.show();
  }

  private lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const top = new vscode.Range(0, 0, 0, 0);
    const label = this.label(doc);
    return [
      new vscode.CodeLens(top, { title: '▶ Run (Ctrl+Enter)', command: 'mongoster.runPlayground', tooltip: 'Run the playground, or the selection' }),
      new vscode.CodeLens(top, {
        title: label ? `$(database) ${label}` : '$(database) Choose a connection',
        command: 'mongoster.changePlaygroundConnection',
        tooltip: 'Connection and default database of this playground',
      }),
    ];
  }

  // ---- running

  private async run(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isPlayground(editor.document)) {
      void vscode.window.showInformationMessage('Open a playground (.mongodb.js) to run it: Mongoster: New Playground creates one.');
      return;
    }
    if (this.running) {
      void vscode.window.showInformationMessage('A playground is already running.');
      return;
    }
    const doc = editor.document;
    const target = this.target(doc) ?? (await this.change(doc));
    if (!target) return;
    const info = this.connections.get(target.connectionId)!;
    const selection = editor.selection;
    const partial = !selection.isEmpty;
    const code = partial ? doc.getText(selection) : doc.getText();
    const lineOffset = partial ? selection.start.line : 0;
    // A selection runs on the database selected by the use() calls above it.
    const database = (partial ? databaseAt(doc.getText(), doc.offsetAt(selection.start)) : undefined) ?? target.database;
    const [first, last] = [selection.start.line + 1, selection.end.line + 1];
    const title = doc.uri.path.split('/').pop()! + (partial ? (first === last ? ` (line ${first})` : ` (lines ${first}–${last})`) : '');
    const targetLabel = `${info.name} › ${database}`;
    const output: string[] = [];
    this.output.appendLine(`\n▶ ${title} on ${targetLabel} — ${new Date().toLocaleTimeString()}`);
    PlaygroundResultPanel.show(this.context, { type: 'running', title, target: targetLabel });

    this.running = true;
    const started = Date.now();
    try {
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running ${title}…`, cancellable: true },
        async (_progress, token) => {
          const client = await this.connections.getClient(info.id);
          const run = runPlayground(code, {
            client,
            database,
            readOnly: !!info.readOnly,
            oplog: (db, collection) => RedisOplog.sink({ connectionId: info.id, database: db, collection }),
            print: (line) => {
              output.push(line);
              this.output.appendLine(line);
            },
          });
          const cancelled = new Promise<'cancelled'>((resolve) => token.onCancellationRequested(() => resolve('cancelled')));
          return Promise.race([run, cancelled]);
        },
      );
      const durationMs = Date.now() - started;
      if (outcome === 'cancelled') {
        const message = 'Cancelled. Operations already sent may still complete on the server.';
        PlaygroundResultPanel.show(
          this.context,
          { type: 'result', title, target: targetLabel, durationMs, kind: 'none', limit: RESULT_LIMIT, output, error: { message } },
          { uri: doc.uri, lineOffset },
        );
        return;
      }
      PlaygroundResultPanel.show(
        this.context,
        {
          type: 'result',
          title,
          target: `${info.name} › ${outcome.database}`,
          durationMs,
          kind: outcome.kind,
          value: outcome.value,
          more: outcome.more,
          limit: RESULT_LIMIT,
          output,
        },
        { uri: doc.uri, lineOffset },
      );
      // Writes may have changed what the tree and the collection tabs show.
      if (/\b(insert|update|replace|delete|drop|create|rename|bulkWrite|findOneAnd)/.test(code)) {
        void vscode.commands.executeCommand('mongoster.refresh');
      }
    } catch (err) {
      const line = err instanceof PlaygroundError ? err.line : undefined;
      const message = errorMessage(err);
      this.output.appendLine(`✖ ${message}${line ? ` (line ${line + lineOffset})` : ''}`);
      PlaygroundResultPanel.show(
        this.context,
        {
          type: 'result',
          title,
          target: targetLabel,
          durationMs: Date.now() - started,
          kind: 'none',
          limit: RESULT_LIMIT,
          output,
          error: { message, line: line !== undefined ? line + lineOffset : undefined },
        },
        { uri: doc.uri, lineOffset: 0 },
      );
    } finally {
      this.running = false;
    }
  }

  // ---- completion

  private async completions(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionList | undefined> {
    if (!isPlayground(doc)) return undefined;
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const target = this.target(doc);
    const database = databaseAt(text, offset) ?? target?.database;

    const member = memberAt(text, offset);
    if (member) {
      const range = new vscode.Range(doc.positionAt(member.start), pos);
      const methods = (list: [string, string][], detail: string) =>
        list.map(([name, snippet], i) => {
          const item = new vscode.CompletionItem({ label: name, description: detail }, vscode.CompletionItemKind.Method);
          item.insertText = new vscode.SnippetString(snippet);
          item.range = range;
          item.sortText = `1${String(i).padStart(3, '0')}`;
          return item;
        });
      if (member.kind === 'cursor') return new vscode.CompletionList(methods(CURSOR_METHODS, 'cursor'));
      if (member.kind === 'collection') return new vscode.CompletionList(methods(COLLECTION_METHODS, 'collection'));
      const names = target && database ? await this.collections(target.connectionId, database) : [];
      const collections = names.map((name, i) => {
        const item = new vscode.CompletionItem({ label: name, description: 'collection' }, vscode.CompletionItemKind.Field);
        item.insertText = /^[A-Za-z_$][\w$]*$/.test(name) ? name : `getCollection(${JSON.stringify(name)})`;
        item.filterText = name;
        item.range = range;
        item.sortText = `0${String(i).padStart(4, '0')}`;
        return item;
      });
      return new vscode.CompletionList([...collections, ...methods(DB_METHODS, 'database')]);
    }

    const call = callAt(text, offset);
    if (!call) return undefined;
    const kind = argumentKind(call, text.slice(call.argStart, offset));
    if (!kind) return undefined;
    const hints = target && database && call.collection !== undefined ? await this.fields(target.connectionId, database, call.collection) : [];
    const result = complete(text.slice(call.argStart), offset - call.argStart, kind, hints);
    if (!result || !result.items.length) return undefined;
    const range = new vscode.Range(doc.positionAt(call.argStart + result.from), doc.positionAt(call.argStart + result.to));
    const kinds: Record<QueryItem['kind'], vscode.CompletionItemKind> = {
      field: vscode.CompletionItemKind.Field,
      operator: vscode.CompletionItemKind.Operator,
      stage: vscode.CompletionItemKind.Function,
      value: vscode.CompletionItemKind.Value,
    };
    const items = result.items.map((q, i) => {
      const item = new vscode.CompletionItem({ label: q.label, description: q.detail }, kinds[q.kind]);
      const cursor = q.cursor ?? q.insert.length;
      item.insertText = new vscode.SnippetString(snippetEscape(q.insert.slice(0, cursor)) + '$0' + snippetEscape(q.insert.slice(cursor)));
      item.range = range;
      // Our ranking decides the order; the list is asked again on each keystroke.
      item.filterText = result.prefix + q.label;
      item.sortText = String(i).padStart(4, '0');
      if (result.position === 'key' && q.cursor !== undefined) item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
      return item;
    });
    return new vscode.CompletionList(items, true);
  }

  private collections(connectionId: string, database: string): Promise<string[]> {
    const key = `${connectionId}/${database}`;
    const cached = this.collectionCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.names;
    const names = (async () => {
      try {
        const client = await this.connections.getClient(connectionId);
        return (await client.db(database).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
      } catch {
        return [];
      }
    })();
    this.collectionCache.set(key, { at: Date.now(), names });
    return names;
  }

  private fields(connectionId: string, database: string, collection: string): Promise<FieldHint[]> {
    const key = `${connectionId}/${database}/${collection}`;
    const cached = this.fieldCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.hints;
    const hints = (async () => {
      try {
        const client = await this.connections.getClient(connectionId);
        const docs: Document[] = await client
          .db(database)
          .collection(collection)
          .aggregate([{ $sample: { size: FIELD_SAMPLE } }], { promoteValues: false, maxTimeMS: 10_000 })
          .toArray();
        return fieldHints(analyzeSchema(docs.map((d) => EJSON.serialize(d, { relaxed: false }))));
      } catch {
        return [];
      }
    })();
    this.fieldCache.set(key, { at: Date.now(), hints });
    return hints;
  }
}

function snippetEscape(s: string): string {
  return s.replace(/[\\$}]/g, (c) => `\\${c}`);
}
