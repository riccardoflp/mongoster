// Text documents and their editors: vscode.workspace's documents and file systems, vscode.window's
// text editors, vscode.languages' providers. The shell holds the editor (Monaco); the text is mirrored
// here so the extension reads it as it does in VS Code.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CompletionData, LensData, Pos, Span } from '../protocol';
import {
  CancellationTokenSource,
  CodeLens,
  CompletionItem,
  CompletionList,
  Disposable,
  DocumentFilter,
  DocumentSelector,
  Event,
  EventEmitter,
  FilePermission,
  FileSystemProvider,
  FileType,
  Position,
  Range,
  Selection,
  SnippetString,
  Thenable,
  Uri,
  ViewColumn,
} from './base';
import { onRequest, onShell, post } from './bridge';
import { action, keybindings, menu } from './contributions';
import { themeFile } from '../theme';
import { outputText, showErrorMessage, showSaveDialog, showWarningMessage } from './ui';

/** The scheme of the color theme files the app provides. */
export const THEME_SCHEME = 'mongoster-theme';

// ---- file systems

const providers = new Map<string, FileSystemProvider>();

export function registerFileSystemProvider(scheme: string, provider: FileSystemProvider): Disposable {
  providers.set(scheme, provider);
  return new Disposable(() => providers.delete(scheme));
}

export const fileSystem = {
  async readFile(uri: Uri): Promise<Uint8Array> {
    if (uri.scheme === 'file') return fs.promises.readFile(uri.fsPath);
    if (uri.scheme === THEME_SCHEME) return new TextEncoder().encode(themeFile(uri.path.includes('light') ? 'light' : 'dark'));
    const provider = providers.get(uri.scheme);
    if (!provider) throw new Error(`No file system for ${uri.scheme}:`);
    return provider.readFile(uri);
  },

  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    if (uri.scheme === 'file') return fs.promises.writeFile(uri.fsPath, content);
    const provider = providers.get(uri.scheme);
    if (!provider) throw new Error(`No file system for ${uri.scheme}:`);
    await provider.writeFile(uri, content, { create: true, overwrite: true });
  },

  async stat(uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number; permissions?: FilePermission }> {
    if (uri.scheme === 'file') {
      const s = await fs.promises.stat(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    }
    const provider = providers.get(uri.scheme);
    if (!provider) throw new Error(`No file system for ${uri.scheme}:`);
    return provider.stat(uri);
  },
};

// ---- documents

export interface TextLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly range: Range;
  readonly isEmptyOrWhitespace: boolean;
}

const LANGUAGES: Record<string, string> = { '.json': 'json', '.jsonl': 'json', '.js': 'javascript', '.csv': 'plaintext', '.md': 'markdown', '.py': 'python' };
/** VS Code's language ids that the editor names differently. */
const LANGUAGE_ALIASES: Record<string, string> = { shellscript: 'shell', jsonc: 'json', log: 'plaintext' };

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export class TextDocument {
  version = 1;
  isDirty = false;
  isClosed = false;
  /** The text as last saved or loaded: the document is dirty when it differs. */
  saved: string;
  /** Typed in by the user at least once. */
  touched = false;
  private starts: number[] | undefined;

  constructor(
    readonly uri: Uri,
    readonly languageId: string,
    private text: string,
    readonly readOnly: boolean,
    /** A buffer shown for reading (a result, generated code, an output): closing it never asks to save. */
    readonly scratch: boolean,
  ) {
    this.saved = text;
  }

  get isUntitled(): boolean {
    return this.uri.scheme === 'untitled';
  }

  get fileName(): string {
    return this.uri.scheme === 'file' ? this.uri.fsPath : this.uri.path;
  }

  /** The name on the tab. */
  get name(): string {
    return safeDecode(this.uri.path.split('/').pop() || this.uri.path);
  }

  get lineCount(): number {
    return this.lineStarts().length;
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.starts = undefined;
    this.version++;
  }

  getText(range?: Range): string {
    return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text;
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const line = Math.min(Math.max(typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line, 0), this.lineCount - 1);
    const starts = this.lineStarts();
    const end = line + 1 < starts.length ? starts[line + 1] : this.text.length;
    const text = this.text.slice(starts[line], end).replace(/\r?\n$/, '');
    return { lineNumber: line, text, range: new Range(line, 0, line, text.length), isEmptyOrWhitespace: !text.trim() };
  }

  offsetAt(position: Position): number {
    const starts = this.lineStarts();
    if (position.line >= starts.length) return this.text.length;
    if (position.line < 0) return 0;
    return starts[position.line] + Math.min(Math.max(position.character, 0), this.lineAt(position.line).text.length);
  }

  positionAt(offset: number): Position {
    const at = Math.min(Math.max(offset, 0), this.text.length);
    const starts = this.lineStarts();
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= at) low = mid;
      else high = mid - 1;
    }
    return new Position(low, Math.min(at - starts[low], this.lineAt(low).text.length));
  }

  save(): Promise<boolean> {
    return saveDocument(this);
  }

  private lineStarts(): number[] {
    if (!this.starts) {
      this.starts = [0];
      for (let i = this.text.indexOf('\n'); i !== -1; i = this.text.indexOf('\n', i + 1)) this.starts.push(i + 1);
    }
    return this.starts;
  }
}

export interface TextEditorEdit {
  insert(position: Position, text: string): void;
  replace(range: Range, text: string): void;
  delete(range: Range): void;
}

export class TextEditor {
  private current = new Selection(0, 0, 0, 0);
  viewColumn: ViewColumn | undefined;

  constructor(
    readonly id: number,
    public document: TextDocument,
  ) {}

  get selection(): Selection {
    return this.current;
  }

  set selection(value: Selection) {
    this.current = value;
    post({ type: 'editorSelect', id: this.id, selection: span(value) });
  }

  /** The selection as the shell reports it. */
  selected(value: Selection): void {
    this.current = value;
  }

  edit(callback: (edit: TextEditorEdit) => void): Promise<boolean> {
    const edits: { range: Range; text: string }[] = [];
    callback({
      insert: (position, text) => edits.push({ range: new Range(position, position), text }),
      replace: (range, text) => edits.push({ range, text }),
      delete: (range) => edits.push({ range, text: '' }),
    });
    if (this.document.readOnly) return Promise.resolve(false);
    const doc = this.document;
    // Applied from the end, so the offsets of the earlier edits stay valid.
    const ordered = edits
      .map((e) => ({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.text, range: e.range }))
      .sort((a, b) => b.start - a.start);
    let text = doc.getText();
    for (const e of ordered) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    // What the app writes into a fresh untitled document is its starting point, not a change to save.
    const clean = doc.isUntitled && !doc.touched && !doc.isDirty;
    doc.setText(text);
    if (clean) doc.saved = text;
    else setDirty(doc, text !== doc.saved);
    post({ type: 'editorEdits', id: this.id, edits: ordered.map((e) => ({ range: span(e.range), text: e.text })), clean });
    changedEmitter.fire({ document: doc, contentChanges: [] });
    return Promise.resolve(true);
  }
}

const span = (range: Range): Span => ({
  start: { line: range.start.line, character: range.start.character },
  end: { line: range.end.line, character: range.end.character },
});
const position = (p: Pos) => new Position(p.line, p.character);

const documents = new Map<string, TextDocument>();
const editors = new Map<number, TextEditor>();
let nextEditor = 1;
let untitledCounter = 0;
let active: TextEditor | undefined;

const openedEmitter = new EventEmitter<TextDocument>();
const closedEmitter = new EventEmitter<TextDocument>();
const savedEmitter = new EventEmitter<TextDocument>();
const changedEmitter = new EventEmitter<{ document: TextDocument; contentChanges: readonly unknown[] }>();
const activeEmitter = new EventEmitter<TextEditor | undefined>();
const renamedEmitter = new EventEmitter<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>();

export const onDidOpenTextDocument: Event<TextDocument> = openedEmitter.event;
export const onDidCloseTextDocument: Event<TextDocument> = closedEmitter.event;
export const onDidSaveTextDocument: Event<TextDocument> = savedEmitter.event;
export const onDidChangeTextDocument = changedEmitter.event;
export const onDidChangeActiveTextEditor: Event<TextEditor | undefined> = activeEmitter.event;
/** Files aren't renamed from the app: declared for the extension, never fired. */
export const onDidRenameFiles = renamedEmitter.event;

export function textDocuments(): readonly TextDocument[] {
  return [...documents.values()];
}

export function activeTextEditor(): TextEditor | undefined {
  return active;
}

function setActive(editor: TextEditor | undefined): void {
  if (active === editor) return;
  active = editor;
  activeEmitter.fire(editor);
}

/** The shell says which tab is the active one. */
export function tabActivated(kind: string | undefined, id: number | undefined): void {
  setActive(kind === 'editor' && id !== undefined ? editors.get(id) : undefined);
}

function languageOf(uri: Uri): string {
  return LANGUAGES[path.posix.extname(uri.path).toLowerCase()] ?? 'plaintext';
}

const MAX_EDITOR_BYTES = 30 * 1024 * 1024;

export async function openTextDocument(target?: Uri | string | { language?: string; content?: string }): Promise<TextDocument> {
  if (target === undefined || (typeof target === 'object' && !(target instanceof Uri))) {
    const language = target?.language ?? 'plaintext';
    const uri = Uri.from({ scheme: 'untitled', path: `Untitled-${++untitledCounter}` });
    return register(new TextDocument(uri, LANGUAGE_ALIASES[language] ?? language, target?.content ?? '', false, true));
  }
  const uri = typeof target === 'string' ? Uri.file(target) : target;
  const existing = documents.get(uri.toString());
  if (existing) return existing;
  if (uri.scheme === 'untitled') return register(new TextDocument(uri, languageOf(uri), '', false, false));
  if (uri.scheme === 'file' && (await fs.promises.stat(uri.fsPath)).size > MAX_EDITOR_BYTES) {
    throw new Error(`${path.basename(uri.fsPath)} is too large to open in the editor.`);
  }
  const text = new TextDecoder().decode(await fileSystem.readFile(uri));
  const readOnly = uri.scheme !== 'file' && (await fileSystem.stat(uri)).permissions === FilePermission.Readonly;
  // Asked twice at once (a double click): the first one registered wins.
  return documents.get(uri.toString()) ?? register(new TextDocument(uri, languageOf(uri), text, readOnly, false));
}

function register(doc: TextDocument): TextDocument {
  documents.set(doc.uri.toString(), doc);
  openedEmitter.fire(doc);
  return doc;
}

export interface TextDocumentShowOptions {
  viewColumn?: ViewColumn;
  preserveFocus?: boolean;
  preview?: boolean;
  selection?: Range;
}

const column = (c: ViewColumn | undefined) => (c === ViewColumn.Beside ? 'beside' : c === ViewColumn.One ? 1 : c === ViewColumn.Two ? 2 : 'active');

function editorContext(doc: TextDocument) {
  return {
    editorTextFocus: true,
    editorLangId: doc.languageId,
    resourceScheme: doc.uri.scheme,
    resourceFilename: doc.name,
    resourceExtname: path.posix.extname(doc.name),
  };
}

function editorChrome(doc: TextDocument) {
  const context = editorContext(doc);
  return {
    title: doc.name,
    tooltip: doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.isUntitled ? doc.name : doc.uri.path.split('/').filter(Boolean).map(safeDecode).join(' › '),
    actions: menu('editor/title', context).map((e) => action(e.command)),
    keys: keybindings(context),
  };
}

export async function showTextDocument(target: TextDocument | Uri, optionsOrColumn?: TextDocumentShowOptions | ViewColumn): Promise<TextEditor> {
  const doc = target instanceof TextDocument ? target : await openTextDocument(target);
  const options = typeof optionsOrColumn === 'object' ? optionsOrColumn : { viewColumn: optionsOrColumn };
  let editor = [...editors.values()].find((e) => e.document === doc);
  if (editor) {
    post({ type: 'editorReveal', id: editor.id, selection: options.selection && span(options.selection), preserveFocus: !!options.preserveFocus });
  } else {
    editor = new TextEditor(nextEditor++, doc);
    editors.set(editor.id, editor);
    post({
      type: 'editorOpen',
      id: editor.id,
      uri: doc.uri.toString(),
      language: doc.languageId,
      text: doc.getText(),
      readOnly: doc.readOnly,
      dirty: doc.isDirty,
      column: column(options.viewColumn),
      preserveFocus: !!options.preserveFocus,
      selection: options.selection && span(options.selection),
      ...editorChrome(doc),
    });
  }
  if (options.selection) editor.selected(new Selection(options.selection.start, options.selection.end));
  if (!options.preserveFocus) setActive(editor);
  return editor;
}

/** Shows an output channel as a read-only document. */
export async function showOutput(name: string): Promise<void> {
  const uri = Uri.from({ scheme: 'output', path: name });
  const existing = documents.get(uri.toString());
  const text = outputText(name);
  if (existing) {
    existing.setText(text);
    existing.saved = text;
    const editor = [...editors.values()].find((e) => e.document === existing);
    if (editor) post({ type: 'editorUpdate', id: editor.id, text });
    await showTextDocument(existing);
    return;
  }
  await showTextDocument(register(new TextDocument(uri, 'plaintext', text, true, true)));
}

// ---- saving and closing

function setDirty(doc: TextDocument, dirty: boolean): void {
  if (doc.isDirty === dirty) return;
  doc.isDirty = dirty;
  for (const editor of editors.values()) if (editor.document === doc) post({ type: 'editorUpdate', id: editor.id, dirty });
}

const saving = new Set<TextDocument>();
let lastSaveFolder: string | undefined;

async function saveDocument(doc: TextDocument): Promise<boolean> {
  if (doc.readOnly) {
    void showWarningMessage(`${doc.name} is read-only.`);
    return false;
  }
  if (saving.has(doc)) return false;
  saving.add(doc);
  try {
    if (doc.isUntitled) return await saveAs(doc);
    const text = doc.getText();
    await fileSystem.writeFile(doc.uri, new TextEncoder().encode(text));
    doc.saved = text;
    setDirty(doc, doc.getText() !== text);
    savedEmitter.fire(doc);
    return true;
  } catch (err) {
    void showErrorMessage(`Failed to save '${doc.name}': ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    saving.delete(doc);
  }
}

/** Saves an untitled document to a file: the file's document takes its place in the editor. */
async function saveAs(doc: TextDocument): Promise<boolean> {
  const extension = path.posix.extname(doc.name).slice(1) || Object.entries(LANGUAGES).find(([, l]) => l === doc.languageId)?.[0].slice(1) || 'txt';
  const name = path.posix.extname(doc.name) ? doc.name : `${doc.name}.${extension}`;
  const target = await showSaveDialog({
    title: `Save ${doc.name}`,
    defaultUri: Uri.file(path.join(lastSaveFolder ?? os.homedir(), name)),
    filters: { [extension.toUpperCase()]: [extension], 'All files': ['*'] },
  });
  if (!target) return false;
  lastSaveFolder = path.dirname(target.fsPath);
  const text = doc.getText();
  await fs.promises.writeFile(target.fsPath, text);

  const other = documents.get(target.toString());
  const saved = other ?? new TextDocument(target, languageOf(target), text, false, false);
  saved.setText(text);
  saved.saved = text;
  saved.isDirty = false;
  documents.set(target.toString(), saved);
  for (const editor of editors.values()) {
    if (editor.document !== doc) continue;
    editor.document = saved;
    post({ type: 'editorUpdate', id: editor.id, uri: target.toString(), language: saved.languageId, dirty: false, ...editorChrome(saved) });
  }
  if (!other) openedEmitter.fire(saved);
  savedEmitter.fire(saved);
  documents.delete(doc.uri.toString());
  doc.isClosed = true;
  closedEmitter.fire(doc);
  // The active editor shows another document now.
  if (active?.document === saved) activeEmitter.fire(active);
  post({ type: 'lensesChanged' });
  return true;
}

async function revert(doc: TextDocument): Promise<void> {
  if (doc.isUntitled || doc.scratch) return;
  try {
    const text = new TextDecoder().decode(await fileSystem.readFile(doc.uri));
    doc.setText(text);
    doc.saved = text;
    for (const editor of editors.values()) if (editor.document === doc) post({ type: 'editorUpdate', id: editor.id, text });
    setDirty(doc, false);
    changedEmitter.fire({ document: doc, contentChanges: [] });
  } catch (err) {
    void showErrorMessage(`Could not reload '${doc.name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Asks what to do with the unsaved changes; false when the close is cancelled. */
async function confirmClose(doc: TextDocument): Promise<boolean> {
  if (!doc.isDirty || doc.scratch) return true;
  const answer = await showWarningMessage(
    `Do you want to save the changes you made to ${doc.name}?`,
    { modal: true, detail: "Your changes will be lost if you don't save them." },
    'Save',
    "Don't Save",
  );
  if (answer === 'Save') return saveDocument(doc);
  return answer === "Don't Save";
}

function closeEditor(editor: TextEditor): void {
  editors.delete(editor.id);
  post({ type: 'editorClose', id: editor.id });
  if (active === editor) setActive(undefined);
  const doc = editor.document;
  if ([...editors.values()].some((e) => e.document === doc)) return;
  documents.delete(doc.uri.toString());
  doc.isClosed = true;
  closedEmitter.fire(doc);
}

/** Before the window closes: false when the user wants to keep working on an unsaved document. */
export async function confirmCloseAll(): Promise<boolean> {
  for (const editor of [...editors.values()]) {
    if (!editor.document.isDirty || editor.document.scratch) continue;
    post({ type: 'editorReveal', id: editor.id, preserveFocus: false });
    if (!(await confirmClose(editor.document))) return false;
    // Saved or discarded: not asked again if the close is cancelled later on.
    editor.document.saved = editor.document.getText();
    setDirty(editor.document, false);
  }
  return true;
}

onShell('editorChanged', (m) => {
  const editor = editors.get(m.id);
  if (!editor) return;
  const doc = editor.document;
  if (m.text === doc.getText()) return;
  doc.touched = true;
  doc.setText(m.text);
  setDirty(doc, m.text !== doc.saved);
  changedEmitter.fire({ document: doc, contentChanges: [] });
});

onShell('editorSelection', (m) => {
  editors.get(m.id)?.selected(new Selection(position(m.selection.start), position(m.selection.end)));
});

onShell('editorSave', (m) => {
  const editor = editors.get(m.id);
  if (editor) void saveDocument(editor.document);
});

onShell('editorRevert', (m) => {
  const editor = editors.get(m.id);
  if (editor) void revert(editor.document);
});

onShell('editorCloseRequest', (m) => {
  const editor = editors.get(m.id);
  if (!editor) return;
  void confirmClose(editor.document).then((ok) => {
    if (ok && editors.has(editor.id)) closeEditor(editor);
  });
});

// ---- language features

interface CompletionItemProvider {
  provideCompletionItems(document: TextDocument, position: Position, token: unknown, context: unknown): CompletionItem[] | CompletionList | undefined | null | Thenable<CompletionItem[] | CompletionList | undefined | null>;
}

interface CodeLensProvider {
  onDidChangeCodeLenses?: Event<void>;
  provideCodeLenses(document: TextDocument, token: unknown): CodeLens[] | undefined | null | Thenable<CodeLens[] | undefined | null>;
}

const completionProviders = new Map<number, { selector: DocumentSelector; provider: CompletionItemProvider; triggers: string[] }>();
const lensProviders = new Map<number, { selector: DocumentSelector; provider: CodeLensProvider }>();
let nextProvider = 1;

function glob(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${source}$`);
}

function matches(selector: DocumentSelector, doc: TextDocument): boolean {
  const filters: readonly (DocumentFilter | string)[] = Array.isArray(selector) ? selector : [selector as DocumentFilter | string];
  return filters.some((f) => {
    if (typeof f === 'string') return f === '*' || f === doc.languageId;
    if (f.language && f.language !== doc.languageId) return false;
    if (f.scheme && f.scheme !== doc.uri.scheme) return false;
    if (f.pattern && !glob(f.pattern).test(doc.uri.path)) return false;
    return true;
  });
}

/**
 * The languages a selector is about, `*` for any. The editor asks the providers of a language before
 * those of any language, and only them if they answer: ours must stand beside its own.
 */
function languagesOf(selector: DocumentSelector): string[] {
  const filters: readonly (DocumentFilter | string)[] = Array.isArray(selector) ? selector : [selector as DocumentFilter | string];
  return [...new Set(filters.map((f) => (typeof f === 'string' ? f : f.language ?? '*')))];
}

/** Tells the shell which providers there are (again when its window reloads). */
export function announceLanguages(): void {
  post({
    type: 'languages',
    providers: {
      completion: [...completionProviders].map(([id, p]) => ({ id, languages: languagesOf(p.selector), triggers: p.triggers })),
      lens: [...lensProviders].map(([id, p]) => ({ id, languages: languagesOf(p.selector) })),
    },
  });
}

export function registerCompletionItemProvider(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): Disposable {
  const id = nextProvider++;
  completionProviders.set(id, { selector, provider, triggers: triggerCharacters });
  announceLanguages();
  return new Disposable(() => {
    completionProviders.delete(id);
    announceLanguages();
  });
}

export function registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable {
  const id = nextProvider++;
  lensProviders.set(id, { selector, provider });
  const subscription = provider.onDidChangeCodeLenses?.(() => post({ type: 'lensesChanged' }));
  announceLanguages();
  return new Disposable(() => {
    lensProviders.delete(id);
    subscription?.dispose();
    announceLanguages();
  });
}

onRequest('completions', async (args): Promise<CompletionData | undefined> => {
  const registered = completionProviders.get(args.provider);
  const editor = editors.get(args.editor);
  if (!registered || !editor || !matches(registered.selector, editor.document)) return undefined;
  const doc = editor.document;
  // The request carries the text it was asked for: the change may still be on its way here.
  if (args.text !== doc.getText()) {
    doc.touched = true;
    doc.setText(args.text);
    setDirty(doc, args.text !== doc.saved);
  }
  const source = new CancellationTokenSource();
  const result = await registered.provider.provideCompletionItems(doc, position(args.position), source.token, { triggerKind: 0 });
  if (!result) return undefined;
  const list = Array.isArray(result) ? new CompletionList(result) : result;
  return {
    incomplete: list.isIncomplete,
    items: list.items.map((item) => {
      const label = typeof item.label === 'string' ? item.label : item.label.label;
      const insert = item.insertText ?? label;
      return {
        label,
        description: typeof item.label === 'string' ? undefined : item.label.description,
        kind: item.kind ?? 0,
        insert: insert instanceof SnippetString ? insert.value : insert,
        snippet: insert instanceof SnippetString,
        range: item.range && span(item.range),
        sortText: item.sortText,
        filterText: item.filterText,
        detail: item.detail,
        command: item.command?.command,
      };
    }),
  };
});

onRequest('lenses', async (args): Promise<LensData[]> => {
  const registered = lensProviders.get(args.provider);
  const editor = editors.get(args.editor);
  if (!registered || !editor || !matches(registered.selector, editor.document)) return [];
  const source = new CancellationTokenSource();
  const lenses = (await registered.provider.provideCodeLenses(editor.document, source.token)) ?? [];
  return lenses
    .filter((l) => l.command)
    .map((l) => ({ range: span(l.range), title: l.command!.title, tooltip: l.command!.tooltip, command: l.command!.command }));
});
