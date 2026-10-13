// The value types of the `vscode` API that Mongoster uses, for the standalone app: the same names and
// behavior as VS Code's, without the editor behind them.
import * as nodePath from 'path';

export type Thenable<T> = PromiseLike<T>;

declare global {
  /** VS Code declares it as a global: the extension's code names it without importing it. */
  interface Thenable<T> extends PromiseLike<T> {}
}

// ---- disposables and events

/** What each disposable calls; kept outside the class, so anything with a dispose() is a Disposable. */
const disposers = new WeakMap<object, () => unknown>();

export class Disposable {
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }

  constructor(callOnDispose: () => unknown) {
    disposers.set(this, callOnDispose);
  }

  dispose(): void {
    const call = disposers.get(this);
    disposers.delete(this);
    call?.();
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    const disposable = new Disposable(() => this.listeners.delete(bound));
    disposables?.push(disposable);
    return disposable;
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch (err) {
        console.error(err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

export class CancellationTokenSource {
  private cancelled = false;
  private readonly emitter = new EventEmitter<void>();
  readonly token: CancellationToken;

  constructor() {
    const source = this;
    this.token = {
      get isCancellationRequested() {
        return source.cancelled;
      },
      onCancellationRequested: this.emitter.event,
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

// ---- Uri

interface UriComponents {
  scheme: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

const encodePath = (s: string) => s.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/g, encodeURIComponent);
const encodeQuery = (s: string) => s.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/?]/g, encodeURIComponent);
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export class Uri {
  static file(path: string): Uri {
    let p = path.replace(/\\/g, '/');
    let authority = '';
    // UNC paths: //server/share/…
    if (p.startsWith('//')) {
      const end = p.indexOf('/', 2);
      authority = end === -1 ? p.slice(2) : p.slice(2, end);
      p = end === -1 ? '/' : p.slice(end);
    }
    if (!p.startsWith('/')) p = `/${p}`;
    return new Uri('file', authority, p, '', '');
  }

  static parse(value: string): Uri {
    const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(value);
    if (!m) throw new Error(`Invalid URI: ${value}`);
    return new Uri(m[1] ?? '', decode(m[2] ?? ''), decode(m[3] ?? ''), decode(m[4] ?? ''), decode(m[5] ?? ''));
  }

  static from(c: UriComponents): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return base.with({ path: nodePath.posix.join(base.path || '/', ...segments) });
  }

  static isUri(thing: unknown): thing is Uri {
    return thing instanceof Uri;
  }

  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  /** The path of a file: URI as the operating system writes it. */
  get fsPath(): string {
    let p = this.path;
    if (this.authority && this.scheme === 'file') p = `//${this.authority}${p}`;
    else if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  }

  with(change: Partial<UriComponents>): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    let out = this.scheme ? `${this.scheme}:` : '';
    if (this.authority || this.scheme === 'file') out += `//${encodeURIComponent(this.authority)}`;
    out += encodePath(this.path);
    if (this.query) out += `?${encodeQuery(this.query)}`;
    if (this.fragment) out += `#${encodeQuery(this.fragment)}`;
    return out;
  }

  toJSON(): UriComponents {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

// ---- positions

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    let start = typeof a === 'number' ? new Position(a, b as number) : a;
    let end = typeof a === 'number' ? new Position(c!, d!) : (b as Position);
    if (end.isBefore(start)) [start, end] = [end, start];
    this.start = start;
    this.end = end;
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const anchor = typeof a === 'number' ? new Position(a, b as number) : a;
    const active = typeof a === 'number' ? new Position(c!, d!) : (b as Position);
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

// ---- enums

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FilePermission {
  Readonly = 1,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24,
}

// ---- tree items

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');

  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

export class TreeItem {
  id?: string;
  label?: string;
  description?: string | boolean;
  tooltip?: string;
  iconPath?: ThemeIcon | Uri;
  contextValue?: string;
  command?: Command;
  collapsibleState?: TreeItemCollapsibleState;

  constructor(label: string, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export interface TreeDataProvider<T> {
  onDidChangeTreeData?: Event<T | undefined | null | void>;
  getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
  getChildren(element?: T): T[] | undefined | null | Thenable<T[] | undefined | null>;
}

// ---- files

export interface FileStat {
  type: FileType;
  ctime: number;
  mtime: number;
  size: number;
  permissions?: FilePermission;
}

export interface FileChangeEvent {
  readonly type: number;
  readonly uri: Uri;
}

export interface FileSystemProvider {
  readonly onDidChangeFile: Event<FileChangeEvent[]>;
  watch(uri: Uri, options: { recursive: boolean; excludes: string[] }): Disposable;
  stat(uri: Uri): FileStat | Thenable<FileStat>;
  readDirectory(uri: Uri): [string, FileType][] | Thenable<[string, FileType][]>;
  createDirectory(uri: Uri): void | Thenable<void>;
  readFile(uri: Uri): Uint8Array | Thenable<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void | Thenable<void>;
  delete(uri: Uri, options: { recursive: boolean }): void | Thenable<void>;
  rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): void | Thenable<void>;
}

export class FileSystemError extends Error {
  static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileNotFound', 'The file was not found');
  }

  static FileExists(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileExists', 'The file already exists');
  }

  static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'NoPermissions', 'Not allowed');
  }

  static Unavailable(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'Unavailable', 'Not available');
  }

  readonly code: string;

  constructor(messageOrUri?: string | Uri, code = 'Unknown', fallback = 'File system error') {
    super(typeof messageOrUri === 'string' ? messageOrUri : messageOrUri ? `${fallback}: ${messageOrUri.toString()}` : fallback);
    this.code = code;
    this.name = 'FileSystemError';
  }
}

// ---- language features

export class SnippetString {
  constructor(readonly value: string = '') {}
}

export interface CompletionItemLabel {
  label: string;
  detail?: string;
  description?: string;
}

export class CompletionItem {
  insertText?: string | SnippetString;
  range?: Range;
  sortText?: string;
  filterText?: string;
  detail?: string;
  documentation?: string;
  command?: Command;

  constructor(
    readonly label: string | CompletionItemLabel,
    readonly kind?: CompletionItemKind,
  ) {}
}

export class CompletionList {
  constructor(
    readonly items: CompletionItem[] = [],
    readonly isIncomplete = false,
  ) {}
}

export class CodeLens {
  constructor(
    readonly range: Range,
    public command?: Command,
  ) {}

  get isResolved(): boolean {
    return !!this.command;
  }
}

export interface DocumentFilter {
  language?: string;
  scheme?: string;
  pattern?: string;
}

export type DocumentSelector = DocumentFilter | string | readonly (DocumentFilter | string)[];
