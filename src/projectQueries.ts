// The saved queries kept in the project's repository (setting mongoster.savedQueries.folder, by default
// .mongoster/queries in each workspace folder), one JSON file per query. The files are watched, so
// queries pulled from git or edited by hand show in the open tabs; invalid files are skipped with a
// warning. The desktop app has no workspace folders: there the project folder is chosen once and
// remembered.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { QueryText, SavedQuery } from './shared/messages';
import {
  DEFAULT_QUERIES_FOLDER,
  ProjectQuery,
  QueryScope,
  matchesCollection,
  parseProjectQuery,
  projectSavedQuery,
  queryFileName,
  queryFilePath,
  serializeProjectQuery,
} from './shared/savedQueries';

/** The project folder chosen when there are no workspace folders (the desktop app). */
const PROJECT_FOLDER_KEY = 'mongoster.savedQueries.projectFolder';
const MAX_FILES = 2000;
const MAX_BYTES = 1_000_000;
const MAX_DEPTH = 6;
const ID_PREFIX = 'project:';

/** A folder of project queries. */
export interface QueriesFolder {
  /** Absolute path of the folder with the queries. */
  folder: string;
  /** The project (workspace) folder it is in, when the setting is relative. */
  root?: string;
  /** The workspace folder's name. */
  label: string;
}

/** A query file that was read. */
export interface ProjectQueryEntry {
  id: string;
  /** Absolute path of the file. */
  path: string;
  /** The path shown: relative to the project folder. */
  display: string;
  query: ProjectQuery;
  /** When the file last changed, epoch ms. */
  at: number;
}

export const isProjectQueryId = (id: string) => id.startsWith(ID_PREFIX);

/** Whether `file` is in `folder` (or is it). */
function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

const exists = (p: string) => fs.promises.stat(p).then(
  () => true,
  () => false,
);

export class ProjectQueries implements vscode.Disposable {
  private static current: ProjectQueries | undefined;

  static init(context: vscode.ExtensionContext): ProjectQueries {
    ProjectQueries.current = new ProjectQueries(context);
    return ProjectQueries.current;
  }

  static get instance(): ProjectQueries | undefined {
    return ProjectQueries.current;
  }

  private readonly changed = new vscode.EventEmitter<void>();
  /** The queries were read again (a file changed, the setting or the folders changed). */
  readonly onDidChange = this.changed.event;
  private entries: ProjectQueryEntry[] = [];
  /** The invalid files already reported, with their error: reported again only when it changes. */
  private reported = new Map<string, string>();
  private watchers: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | undefined;
  private again = false;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mongoster.savedQueries')) this.restart();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.restart()),
    ];
    this.restart();
  }

  /** The folders of the project's queries: from the setting, in each workspace folder (or the chosen project folder) when it is relative. */
  folders(): QueriesFolder[] {
    let setting = vscode.workspace.getConfiguration('mongoster.savedQueries').get<string>('folder', DEFAULT_QUERIES_FOLDER)?.trim() || DEFAULT_QUERIES_FOLDER;
    if (setting === '~' || setting.startsWith('~/') || setting.startsWith('~\\')) setting = path.join(os.homedir(), setting.slice(1));
    if (path.isAbsolute(setting)) return [{ folder: path.normalize(setting), label: path.basename(setting) }];
    const workspace = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const roots = workspace.length
      ? workspace.map((f) => ({ root: f.uri.fsPath, label: f.name }))
      : [this.context.globalState.get<string>(PROJECT_FOLDER_KEY)].filter((r): r is string => !!r).map((r) => ({ root: r, label: path.basename(r) }));
    return roots.map(({ root, label }) => ({ folder: path.join(root, setting), root, label }));
  }

  /** Whether the project folder comes from the workspace or the setting (rather than being chosen in Mongoster). */
  private get folderFromWorkspace(): boolean {
    const setting = vscode.workspace.getConfiguration('mongoster.savedQueries').get<string>('folder', DEFAULT_QUERIES_FOLDER)?.trim() || DEFAULT_QUERIES_FOLDER;
    return path.isAbsolute(setting) || /^~([/\\]|$)/.test(setting) || !!vscode.workspace.workspaceFolders?.some((f) => f.uri.scheme === 'file');
  }

  /** The project's saved queries of a collection. */
  list(scope: QueryScope): SavedQuery[] {
    return this.entries.filter((e) => matchesCollection(e.query, scope)).map((e) => projectSavedQuery(e.query, e.id, e.display, e.at));
  }

  find(id: string): ProjectQueryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Saves a query in the project: a query of the collection with the same name (and no connection) is
   * replaced, otherwise a new file is written, in the folder the user picks when there are several.
   * Returns the file's path as shown, or undefined when cancelled.
   */
  async save(scope: QueryScope, name: string, query: QueryText, description?: string): Promise<string | undefined> {
    await this.loading;
    const folders = this.folders();
    const same = this.entries.find(
      (e) => !e.query.connection && e.query.name === name && matchesCollection(e.query, scope) && folders.some((f) => inside(f.folder, e.path)),
    );
    const q: ProjectQuery = {
      name,
      ...((description ?? same?.query.description) && { description: description ?? same?.query.description }),
      database: scope.database,
      collection: scope.collection,
      query,
    };
    let file = same?.path;
    if (!file) {
      const folder = await this.pickFolder();
      if (!folder) return undefined;
      // `database/collection/name.json`, or name-2.json… when that file exists.
      const taken = new Set<string>();
      const next = () => queryFilePath(scope.database, scope.collection, name, (r) => taken.has(r));
      let candidate = next();
      while (await exists(path.join(folder.folder, candidate))) {
        taken.add(candidate);
        candidate = next();
      }
      file = path.join(folder.folder, candidate);
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, serializeProjectQuery(q), 'utf8');
    await this.reload();
    return this.find(ID_PREFIX + file)?.display ?? file;
  }

  /** Renames a project query: its name in the file, and the file after it. */
  async rename(id: string, name: string): Promise<void> {
    const entry = this.find(id);
    if (!entry) return;
    let file = entry.path;
    const dir = path.dirname(file);
    const wanted = queryFileName(name);
    if (path.basename(file) !== wanted) {
      const base = wanted.slice(0, -'.json'.length);
      for (let i = 1; ; i++) {
        const candidate = path.join(dir, i === 1 ? wanted : `${base}-${i}.json`);
        if (candidate === file) break;
        if (!(await exists(candidate))) {
          await fs.promises.rename(file, candidate);
          file = candidate;
          break;
        }
      }
    }
    await fs.promises.writeFile(file, serializeProjectQuery({ ...entry.query, name }), 'utf8');
    await this.reload();
  }

  /** Deletes a project query's file (and the folders it leaves empty). */
  async remove(id: string): Promise<void> {
    const entry = this.find(id);
    if (!entry) return;
    await fs.promises.unlink(entry.path);
    const top = this.folders().find((f) => inside(f.folder, entry.path))?.folder;
    for (let dir = path.dirname(entry.path); top && dir.length > top.length && dir.startsWith(top); dir = path.dirname(dir)) {
      try {
        await fs.promises.rmdir(dir);
      } catch {
        break;
      }
    }
    await this.reload();
  }

  /** Opens the file of a project query in the editor. */
  async openFile(id: string): Promise<void> {
    const entry = this.find(id);
    if (entry) await vscode.window.showTextDocument(vscode.Uri.file(entry.path), { preview: false });
  }

  /** The folder a new query goes to: asked when there are several; when there is none, the project folder can be chosen. */
  private async pickFolder(): Promise<QueriesFolder | undefined> {
    let folders = this.folders();
    if (!folders.length) {
      const choose = 'Choose Folder…';
      const answer = await vscode.window.showInformationMessage(
        'Choose the project folder for the saved queries.',
        { modal: true, detail: `They are saved as files in ${this.relativeSetting()} inside it, to be shared and versioned with git.` },
        choose,
      );
      if (answer !== choose || !(await this.chooseProjectFolder())) return undefined;
      folders = this.folders();
    }
    if (folders.length === 1) return folders[0];
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.label, description: f.folder, folder: f })),
      { title: 'Save Query in the Project', placeHolder: 'The workspace folder to save the query in' },
    );
    return picked?.folder;
  }

  private relativeSetting(): string {
    return vscode.workspace.getConfiguration('mongoster.savedQueries').get<string>('folder', DEFAULT_QUERIES_FOLDER)?.trim() || DEFAULT_QUERIES_FOLDER;
  }

  /** Asks for the project folder (the repository) and remembers it; false when cancelled. */
  async chooseProjectFolder(): Promise<boolean> {
    if (this.folderFromWorkspace) {
      const folders = this.folders();
      const open = 'Open Setting';
      const answer = await vscode.window.showInformationMessage(
        `The project's saved queries are in ${folders.map((f) => f.folder).join(', ')}.`,
        { detail: 'They follow the workspace folders and the setting mongoster.savedQueries.folder: set it to an absolute path to use another folder.' },
        open,
      );
      if (answer === open) await vscode.commands.executeCommand('workbench.action.openSettings', 'mongoster.savedQueries.folder');
      return false;
    }
    const current = this.context.globalState.get<string>(PROJECT_FOLDER_KEY);
    const [picked] =
      (await vscode.window.showOpenDialog({
        title: 'Project Folder for Saved Queries',
        openLabel: 'Choose',
        canSelectFiles: false,
        canSelectFolders: true,
        defaultUri: vscode.Uri.file(current ?? os.homedir()),
      })) ?? [];
    if (!picked) return false;
    await this.context.globalState.update(PROJECT_FOLDER_KEY, picked.fsPath);
    this.restart();
    await this.loading;
    void vscode.window.showInformationMessage(`Queries saved in the project go to ${path.join(picked.fsPath, this.relativeSetting())}.`);
    return true;
  }

  /** Watches the folders again and reads the queries. */
  private restart(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    for (const f of this.folders()) {
      // The base must exist for the watcher: the project folder, or the parent of an absolute folder.
      const relative = f.root ? path.relative(f.root, f.folder) : '';
      const [base, pattern] =
        f.root && inside(f.root, f.folder)
          ? [f.root, relative ? `${relative.split(path.sep).join('/')}/**` : '**']
          : [path.dirname(f.folder), `${path.basename(f.folder)}/**`];
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
      const schedule = () => this.schedule();
      this.watchers.push(watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule));
    }
    void this.reload();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reload();
    }, 250);
  }

  /** Reads every query file again; one read at a time, and once more if asked meanwhile. */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        await this.read();
      } while (this.again);
    })().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async read(): Promise<void> {
    const folders = this.folders();
    const entries: ProjectQueryEntry[] = [];
    const errors = new Map<string, { display: string; message: string }>();
    for (const f of folders) {
      const display = (file: string) => {
        const shown = f.root ? path.relative(f.root, file).split(path.sep).join('/') : file;
        return f.root && folders.length > 1 ? `${f.label}: ${shown}` : shown;
      };
      for (const file of await jsonFiles(f.folder)) {
        try {
          const stat = await fs.promises.stat(file);
          if (stat.size > MAX_BYTES) throw new Error(`the file is larger than ${MAX_BYTES / 1_000_000} MB.`);
          const query = parseProjectQuery(await fs.promises.readFile(file, 'utf8'));
          entries.push({ id: ID_PREFIX + file, path: file, display: display(file), query, at: stat.mtimeMs });
        } catch (err) {
          errors.set(file, { display: display(file), message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    this.entries = entries;
    this.report(errors);
    this.changed.fire();
  }

  /** Warns about the invalid files not reported yet (or with another error now). */
  private report(errors: Map<string, { display: string; message: string }>): void {
    const fresh = [...errors].filter(([file, e]) => this.reported.get(file) !== e.message);
    this.reported = new Map([...errors].map(([file, e]) => [file, e.message]));
    if (!fresh.length) return;
    const [file, first] = fresh[0];
    const text =
      fresh.length === 1
        ? `Mongoster skipped the saved query ${first.display}: ${first.message}`
        : `Mongoster skipped ${fresh.length} saved query files that aren't valid, such as ${first.display}: ${first.message}`;
    const open = 'Open File';
    void vscode.window.showWarningMessage(text, open).then((answer) => {
      if (answer === open) void vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watchers.forEach((w) => w.dispose());
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
    if (ProjectQueries.current === this) ProjectQueries.current = undefined;
  }
}

/** The .json files in a folder and its subfolders (none when it doesn't exist). */
async function jsonFiles(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let items: fs.Dirent[];
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return;
      const full = path.join(dir, item.name);
      if (item.isDirectory() && depth < MAX_DEPTH) await walk(full, depth + 1);
      else if (item.isFile() && item.name.toLowerCase().endsWith('.json')) found.push(full);
    }
  };
  await walk(folder, 0);
  return found;
}
