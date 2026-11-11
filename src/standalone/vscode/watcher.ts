// vscode.workspace.createFileSystemWatcher on Node's fs.watch: the folder before the first wildcard of
// the pattern is watched with its subfolders; while it doesn't exist, it is looked for every 2 seconds.
import * as fs from 'fs';
import * as path from 'path';
import { Event, EventEmitter, Uri } from './base';

/** A glob pattern relative to a folder. */
export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;

  constructor(
    base: Uri | string | { readonly uri: Uri },
    readonly pattern: string,
  ) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
    this.base = this.baseUri.fsPath;
  }
}

export type GlobPattern = string | RelativePattern;

export interface FileSystemWatcher {
  dispose(): void;
  readonly ignoreCreateEvents: boolean;
  readonly ignoreChangeEvents: boolean;
  readonly ignoreDeleteEvents: boolean;
  readonly onDidCreate: Event<Uri>;
  readonly onDidChange: Event<Uri>;
  readonly onDidDelete: Event<Uri>;
}

/** A glob (`*`, `**`, `?`, `{a,b}`) as a regular expression on paths with `/`. */
export function globRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '/' && pattern.slice(i + 1) === '**') {
      re += '(?:/.*)?';
      break;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '');
}

const POLL_MS = 2000;

class Watcher implements FileSystemWatcher {
  private readonly created = new EventEmitter<Uri>();
  private readonly changed = new EventEmitter<Uri>();
  private readonly deleted = new EventEmitter<Uri>();
  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;
  private watcher: fs.FSWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /** The folder watched: the pattern's part before its first wildcard. */
  private readonly root: string;
  private readonly matcher: RegExp;

  constructor(
    private readonly base: string,
    pattern: string,
    readonly ignoreCreateEvents: boolean,
    readonly ignoreChangeEvents: boolean,
    readonly ignoreDeleteEvents: boolean,
  ) {
    const segments = pattern.split('/');
    const fixed = segments.findIndex((s) => /[*?{[]/.test(s));
    this.root = path.join(base, ...segments.slice(0, fixed < 0 ? segments.length : fixed));
    this.matcher = globRegExp(pattern);
    this.start();
  }

  private start(): void {
    if (this.disposed) return;
    if (!fs.existsSync(this.root)) return this.poll();
    try {
      try {
        this.watcher = fs.watch(this.root, { recursive: true }, (event, name) => this.onEvent(event, name));
      } catch {
        // Recursive watching isn't available everywhere: then only the folder itself.
        this.watcher = fs.watch(this.root, (event, name) => this.onEvent(event, name));
      }
    } catch {
      return this.poll();
    }
    // The folder was deleted or can no longer be watched: wait for it again.
    this.watcher.on('error', () => {
      this.closeWatcher();
      this.fire(this.deleted, this.ignoreDeleteEvents, this.root);
      this.poll();
    });
  }

  private poll(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      if (!fs.existsSync(this.root)) return;
      clearInterval(this.timer);
      this.timer = undefined;
      this.start();
      this.fire(this.created, this.ignoreCreateEvents, this.root);
    }, POLL_MS);
    this.timer.unref?.();
  }

  private onEvent(event: string, name: string | Buffer | null): void {
    if (!this.watcher) return;
    // The folder itself was deleted (Windows then names it oddly, again and again): wait for it again.
    if (!fs.existsSync(this.root)) {
      this.closeWatcher();
      this.fire(this.deleted, this.ignoreDeleteEvents, this.root);
      return this.poll();
    }
    const full = name ? path.join(this.root, name.toString()) : this.root;
    if (event === 'change') return this.fire(this.changed, this.ignoreChangeEvents, full);
    if (fs.existsSync(full)) this.fire(this.created, this.ignoreCreateEvents, full);
    else this.fire(this.deleted, this.ignoreDeleteEvents, full);
  }

  private fire(emitter: EventEmitter<Uri>, ignored: boolean, full: string): void {
    if (ignored) return;
    const relative = path.relative(this.base, full).split(path.sep).join('/');
    if (this.matcher.test(relative)) emitter.fire(Uri.file(full));
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.closeWatcher();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.created.dispose();
    this.changed.dispose();
    this.deleted.dispose();
  }
}

export function createFileSystemWatcher(pattern: GlobPattern, ignoreCreateEvents = false, ignoreChangeEvents = false, ignoreDeleteEvents = false): FileSystemWatcher {
  // An absolute glob: its folder is the base.
  const relative = typeof pattern === 'string' ? new RelativePattern(path.parse(pattern).root || '/', path.relative(path.parse(pattern).root || '/', pattern).split(path.sep).join('/')) : pattern;
  return new Watcher(relative.base, relative.pattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents);
}
