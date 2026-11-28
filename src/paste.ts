// `Copy`, `Cut` and `Paste` in the connections view, dragging its nodes, and `Rename Database…`. Copy and Cut
// remember the selected connections, databases, collections or buckets; Paste puts them where it is used: a
// connection becomes another connection with the same settings (cut: it changes folder), a database is copied or
// moved to a connection, collections and views to a database. The data is copied or moved by `pasteCollections`
// (`src/copy.ts`); renaming a database is moving its collections to a new one.
import * as vscode from 'vscode';
import type { MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { CollectionRef } from './documentFs';
import { existingNames, pasteCollections, pasteSources } from './copy';
import { databaseNameError } from './manage';
import { BucketNode, CollectionNode, ConnectionNode, DatabaseNode, FolderNode, TreeNode, errorMessage } from './tree';
import { UndoHistory } from './history';
import { RedisOplog } from './redisOplog';
import { Clipboard, CopiedNode, ExistingMode, PasteItem, PasteSource, clipboardOf, copyName, pasteAction, planPaste } from './shared/paste';

type Pick<T> = vscode.QuickPickItem & { value: T };

/** The names shown in a confirmation before `and N more`. */
const LISTED = 8;
/** Databases of the server itself: they are neither moved nor renamed. */
const SERVER_DATABASES = ['admin', 'local', 'config'];

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function copiedNode(node: TreeNode): CopiedNode {
  if (node instanceof ConnectionNode) return { kind: 'connection', connectionId: node.info.id };
  if (node instanceof DatabaseNode) return { kind: 'database', connectionId: node.connection.id, database: node.database };
  if (node instanceof CollectionNode) {
    return { kind: 'collection', connectionId: node.connection.id, database: node.database, collection: node.collection, isView: node.isView };
  }
  if (node instanceof BucketNode) return { kind: 'bucket', connectionId: node.connection.id, database: node.database, bucket: node.bucket };
  return { kind: 'other' };
}

/** The connection of a node below a folder. */
function connectionOf(node: TreeNode | undefined): ConnectionInfo | undefined {
  if (node instanceof ConnectionNode) return node.info;
  if (node instanceof DatabaseNode || node instanceof CollectionNode || node instanceof BucketNode) return node.connection;
  return undefined;
}

/** What the rest of Mongoster does after a paste or a move. */
export interface PasteEvents {
  /** `Open` in the result: the tab of the pasted collection. */
  opened(ref: CollectionRef, isView: boolean): void;
  /** A collection got documents: its open tab shows them. */
  changed(ref: CollectionRef): void;
  /** A collection or view is now elsewhere: its columns, queries, color and tab follow it or go. */
  moved(from: CollectionRef, to: CollectionRef): Promise<void>;
  /** A database emptied by a move was dropped. */
  databaseGone(connectionId: string, database: string): Promise<void>;
}

/** How a copy, a move and a rename of a database say what they do. */
type Wording = 'paste' | 'move' | 'rename';
const WORDS = {
  paste: { button: 'Paste', doing: 'Pasting', done: 'Pasted', noun: 'Paste' },
  move: { button: 'Move', doing: 'Moving', done: 'Moved', noun: 'Move' },
  rename: { button: 'Rename', doing: 'Moving', done: 'Moved', noun: 'Rename' },
} as const;

interface Ends {
  source: ConnectionInfo;
  src: MongoClient;
  destination: ConnectionInfo;
  dst: MongoClient;
}

export class TreeClipboard {
  private clipboard: Clipboard | undefined;
  /** `Cut` took it: Paste moves it, once. */
  private cut = false;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly events: PasteEvents,
  ) {}

  /** Remembers the nodes, to copy them or (`cut`) to move them, and puts their names on the system's clipboard. */
  async copy(nodes: readonly TreeNode[], cut = false): Promise<void> {
    const clipboard = clipboardOf(nodes.map(copiedNode));
    if (typeof clipboard === 'string') {
      void vscode.window.showWarningMessage(clipboard);
      return;
    }
    if (cut && clipboard.kind !== 'connection' && this.connections.get(clipboard.connectionId)?.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${this.connections.get(clipboard.connectionId)?.name} is read-only: nothing can be moved from it.`);
      return;
    }
    this.clipboard = clipboard;
    this.cut = cut;
    void vscode.commands.executeCommand('setContext', 'mongoster.clipboard', clipboard.kind);
    const names =
      clipboard.kind === 'connection'
        ? clipboard.connectionIds.map((id) => this.connections.get(id)?.name ?? '')
        : clipboard.kind === 'database'
          ? clipboard.databases
          : clipboard.collections.map((c) => c.name);
    await vscode.env.clipboard.writeText(names.join('\n'));
    const taken = cut ? 'cut' : 'copied';
    const what =
      clipboard.kind === 'connection'
        ? `${count(names.length, 'connection')} ${taken}: paste on a folder or a connection`
        : clipboard.kind === 'database'
          ? `${count(names.length, 'database')} ${taken}: paste on a connection`
          : `${count(names.length, 'collection')} ${taken}: paste on a database or a connection`;
    vscode.window.setStatusBarMessage(`Mongoster: ${what}`, 5000);
  }

  async paste(target: TreeNode | undefined): Promise<void> {
    const clipboard = this.clipboard;
    if (!clipboard) {
      void vscode.window.showInformationMessage('Nothing to paste: copy a connection, a database or collections in the connections view first.');
      return;
    }
    // What was cut is pasted once: after it, it is where it was pasted.
    if ((await this.put(clipboard, target, this.cut)) && this.cut && this.clipboard === clipboard) {
      this.clipboard = undefined;
      this.cut = false;
      void vscode.commands.executeCommand('setContext', 'mongoster.clipboard', undefined);
    }
  }

  /**
   * Nodes dragged onto another: connections change folder, databases and collections are copied there as by
   * Copy and Paste, after the same confirmation.
   */
  async drop(nodes: readonly TreeNode[], target: TreeNode | undefined): Promise<void> {
    const clipboard = clipboardOf(nodes.map(copiedNode));
    if (typeof clipboard === 'string') {
      void vscode.window.showWarningMessage(clipboard.replace(/^Copy /, 'Drag ').replace(/can be copied\.$/, 'can be dragged.').replace(/to copy it\.$/, 'to drag it.'));
      return;
    }
    await this.put(clipboard, target, clipboard.kind === 'connection');
  }

  /** Moves the collections and views of a database to a new one and drops it: MongoDB has no rename of a database. */
  async renameDatabase(node: DatabaseNode): Promise<void> {
    const info = this.connections.get(node.connection.id) ?? node.connection;
    const database = node.database;
    if (info.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${info.name} is read-only: the database ${database} can't be renamed.`);
      return;
    }
    if (SERVER_DATABASES.includes(database)) {
      void vscode.window.showErrorMessage(`The database ${database} is the server's own: it can't be renamed.`);
      return;
    }
    let client: MongoClient;
    let databases: string[];
    let sources: PasteSource[];
    try {
      client = await this.connections.getClient(info.id);
      databases = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      sources = await pasteSources(client, database);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${info.name}: ${errorMessage(err)}`);
      return;
    }
    const name = (
      await vscode.window.showInputBox({
        title: `Rename the database ${database}`,
        prompt: 'New name',
        value: database,
        ignoreFocusOut: true,
        validateInput: (v) =>
          databaseNameError(v.trim()) ?? (v.trim() === database ? 'Enter another name' : databases.includes(v.trim()) ? 'This database already exists' : undefined),
      })
    )?.trim();
    if (!name) return;
    if (!sources.length) {
      void vscode.window.showInformationMessage(`The database ${database} has no collections: there is nothing to rename.`);
      return;
    }
    const ends = { source: info, src: client, destination: info, dst: client };
    const run = await this.pasteInto(ends, database, sources, name, `the database ${database}`, 'rename');
    if (run?.clean) await this.dropMoved(ends, database);
  }

  /** Puts the clipboard on the target, copying or moving. False when nothing was done or the user gave up. */
  private async put(clipboard: Clipboard, target: TreeNode | undefined, move: boolean): Promise<boolean> {
    if (clipboard.kind === 'connection') return move ? this.moveConnections(clipboard.connectionIds, target) : this.pasteConnections(clipboard.connectionIds, target);

    const verb = move ? 'move' : 'paste';
    const source = this.connections.get(clipboard.connectionId);
    if (!source) {
      void vscode.window.showErrorMessage('The connection of what was copied has been removed.');
      return false;
    }
    const node = connectionOf(target);
    const destination = node && (this.connections.get(node.id) ?? node);
    if (!destination) {
      void vscode.window.showWarningMessage(`Select the connection${clipboard.kind === 'collection' ? ' or the database' : ''} to ${verb} on.`);
      return false;
    }
    if (destination.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${destination.name} is read-only: nothing can be ${move ? 'moved to' : 'pasted on'} it.`);
      return false;
    }
    if (move && source.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${source.name} is read-only: nothing can be moved from it.`);
      return false;
    }
    let src: MongoClient;
    let dst: MongoClient;
    try {
      src = await this.connections.getClient(source.id);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${source.name}: ${errorMessage(err)}`);
      return false;
    }
    let databases: string[];
    try {
      dst = await this.connections.getClient(destination.id);
      databases = (await dst.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${destination.name}: ${errorMessage(err)}`);
      return false;
    }
    const ends: Ends = { source, src, destination, dst };
    const same = source.id === destination.id;

    if (clipboard.kind === 'database') {
      for (const database of clipboard.databases) {
        if (move && SERVER_DATABASES.includes(database)) {
          void vscode.window.showErrorMessage(`The database ${database} is the server's own: it can't be moved.`);
          return false;
        }
        const name = (
          await vscode.window.showInputBox({
            title: `${move ? 'Move' : 'Paste'} the database ${database} ${move ? 'to' : 'on'} ${destination.name}`,
            prompt: `Name of the ${move ? 'database there' : 'copy'} (an existing database receives the collections)`,
            value: databases.includes(database) ? copyName(database, databases, 'identifier') : database,
            ignoreFocusOut: true,
            validateInput: (v) => databaseNameError(v.trim()) ?? (same && v.trim() === database ? `That is the database being ${move ? 'moved' : 'copied'}` : undefined),
          })
        )?.trim();
        if (!name) return false;
        let sources: PasteSource[];
        try {
          sources = await pasteSources(src, database);
        } catch (err) {
          void vscode.window.showErrorMessage(errorMessage(err));
          return false;
        }
        if (!sources.length) {
          void vscode.window.showInformationMessage(`The database ${database} has no collections to ${move ? 'move' : 'copy'}.`);
          continue;
        }
        const run = await this.pasteInto(ends, database, sources, name, `the database ${database}`, verb);
        if (!run || run.cancelled) return false;
        if (move && run.clean) await this.dropMoved(ends, database);
        if (!databases.includes(name)) databases.push(name);
      }
      return true;
    }

    let database = target instanceof ConnectionNode ? undefined : (target as DatabaseNode | CollectionNode | BucketNode).database;
    if (database === undefined) {
      const NEW = '$(add) New database…';
      const ordered = [...databases.filter((d) => d === clipboard.database), ...databases.filter((d) => d !== clipboard.database && !SERVER_DATABASES.includes(d))];
      const pick = await vscode.window.showQuickPick([...ordered, NEW], { title: `${move ? 'Move to' : 'Paste on'} ${destination.name}: database`, ignoreFocusOut: true });
      if (!pick) return false;
      database =
        pick === NEW
          ? (
              await vscode.window.showInputBox({
                title: `${move ? 'Move to' : 'Paste on'} ${destination.name}: new database`,
                prompt: `Database name on ${destination.name}`,
                ignoreFocusOut: true,
                validateInput: (v) => databaseNameError(v.trim()) ?? (databases.includes(v.trim()) ? 'This database already exists' : undefined),
              })
            )?.trim()
          : pick;
      if (!database) return false;
    }
    if (move && same && database === clipboard.database) {
      void vscode.window.showInformationMessage(`${clipboard.collections.length === 1 ? `${clipboard.collections[0].name} is` : 'They are'} already in ${destination.name} › ${database}.`);
      return false;
    }
    const names = clipboard.collections.map((c) => c.name);
    const what = names.length === 1 ? `${clipboard.database}.${names[0]}` : `${count(names.length, 'collection')} of ${clipboard.database}`;
    const run = await this.pasteInto(ends, clipboard.database, clipboard.collections, database, what, verb);
    return !!run && !run.cancelled;
  }

  /** The folder a node stands for: its own, or the one of its connection; `null` when the node gives none. */
  private folderOf(target: TreeNode | undefined): string | undefined | null {
    if (target instanceof FolderNode) return target.folder;
    const on = connectionOf(target);
    return on ? this.connections.get(on.id)?.folder : null;
  }

  /** Each connection again, with its settings and secrets, in the folder pasted on. */
  private async pasteConnections(ids: string[], target: TreeNode | undefined): Promise<boolean> {
    const folder = this.folderOf(target);
    const pasted: string[] = [];
    for (const id of ids) {
      const source = this.connections.get(id);
      if (!source) continue;
      const name = copyName(
        source.name,
        this.connections.list().map((c) => c.name),
        'label',
      );
      if (await this.connections.duplicate(id, name, folder === null ? source.folder : folder)) pasted.push(name);
    }
    if (!pasted.length) void vscode.window.showErrorMessage('The copied connection has been removed.');
    else vscode.window.setStatusBarMessage(`Mongoster: pasted ${pasted.length === 1 ? `the connection ${pasted[0]}` : count(pasted.length, 'connection')}`, 5000);
    return pasted.length > 0;
  }

  /** The connections go to the folder of the target; with no target, out of their folders. */
  private async moveConnections(ids: string[], target: TreeNode | undefined): Promise<boolean> {
    const folder = this.folderOf(target) ?? undefined;
    let moved = 0;
    for (const id of ids) {
      const info = this.connections.get(id);
      if (!info || info.folder === folder) continue;
      await this.connections.update(id, { folder });
      moved++;
    }
    if (moved) vscode.window.setStatusBarMessage(`Mongoster: ${count(moved, 'connection')} moved ${folder ? `to ${folder}` : 'out of its folder'}`, 5000);
    return moved > 0;
  }

  /** After a move that left nothing behind: drops the database, which would stay with its `system.` collections. */
  private async dropMoved({ source, src }: Ends, database: string): Promise<void> {
    try {
      if ((await pasteSources(src, database)).length) return;
      await src.db(database).dropDatabase();
      await this.events.databaseGone(source.id, database);
    } catch (err) {
      void vscode.window.showWarningMessage(`The database ${database} is empty but could not be dropped: ${errorMessage(err)}`);
    }
    void vscode.commands.executeCommand('mongoster.refresh');
  }

  /**
   * Asks what to do with what exists, confirms and copies or moves `sources` of the database `from` into the
   * database `to`. Undefined when the user gave up; `clean` when everything asked was done.
   */
  private async pasteInto(ends: Ends, from: string, sources: PasteSource[], to: string, what: string, wording: Wording): Promise<{ cancelled: boolean; clean: boolean } | undefined> {
    const { source, src, destination, dst } = ends;
    const move = wording !== 'paste';
    const words = WORDS[wording];
    const sameConnection = source.id === destination.id;
    const where = `${destination.name} › ${to}`;
    let items: PasteItem[];
    try {
      items = planPaste(sources, await existingNames(dst, to), sameConnection && from === to);
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return undefined;
    }

    let mode: ExistingMode = 'skip';
    const existing = items.filter((i) => i.exists);
    if (existing.length) {
      const pick = await vscode.window.showQuickPick<Pick<ExistingMode>>(
        [
          { label: 'Skip', description: `what exists stays as it is; only the others are ${move ? 'moved' : 'pasted'}`, value: 'skip' },
          { label: 'Append', description: 'insert the documents; those whose _id already exists are skipped', value: 'append' },
          { label: 'Replace matching', description: 'documents with the same _id are replaced, the others inserted', value: 'upsert' },
          { label: 'Drop and recreate', description: 'the documents and indexes of what exists are deleted first', value: 'drop' },
        ],
        {
          title: existing.length === 1 ? `${existing[0].target} exists in ${where}` : `${existing.length} of the ${items.length} collections exist in ${where}`,
          placeHolder: existing.map((i) => i.target).join(', '),
          ignoreFocusOut: true,
        },
      );
      if (!pick) return undefined;
      mode = pick.value;
    }

    const going = items.filter((i) => pasteAction(i, mode).do !== 'skip');
    if (!going.length) {
      void vscode.window.showInformationMessage(`Nothing to ${move ? 'move' : 'paste'}: everything exists in ${where}.`);
      return { cancelled: false, clean: false };
    }
    // The number of documents of each collection: for the progress and for what the undo history can keep.
    const counts = new Map<string, number>();
    try {
      for (const item of going) if (!item.isView) counts.set(item.source, await src.db(from).collection(item.source).estimatedDocumentCount());
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return undefined;
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const collections = going.filter((i) => !i.isView);
    const views = going.filter((i) => i.isView);
    const dropped = going.filter((i) => pasteAction(i, mode).do === 'drop');
    const listed = going.slice(0, LISTED).map((i) => (i.target === i.source ? i.source : `${i.source} → ${i.target}`));
    const question = wording === 'rename' ? `Rename the database ${from} of ${source.name} to ${to}?` : `${words.button} ${what} from ${source.name} into ${where}?`;
    const answer = await vscode.window.showWarningMessage(
      question,
      {
        modal: true,
        detail: [
          `${listed.join(', ')}${going.length > LISTED ? ` and ${going.length - LISTED} more` : ''}.`,
          collections.length ? `${count(collections.length, 'collection')} with ${count(total, 'document')}, the indexes and the collection options.` : '',
          views.length ? `${count(views.length, 'view')}, created with ${views.length === 1 ? 'its definition' : 'their definitions'}.` : '',
          items.length > going.length ? `${count(items.length - going.length, 'existing one')} skipped.` : '',
          mode === 'append' && existing.length ? 'Existing collections get the documents whose _id they lack.' : '',
          mode === 'upsert' && existing.length ? 'In existing collections the documents with the same _id are replaced.' : '',
          dropped.length ? `Dropped first: ${dropped.map((i) => i.target).join(', ')}. That can't be undone.` : '',
          wording === 'rename' ? `MongoDB can't rename a database: its collections are moved to the new database ${to}, then ${from} is dropped.` : '',
          move && sameConnection ? 'The server moves each collection whole; one it cannot move is copied, then dropped.' : '',
          move && !sameConnection ? `Each one is copied, then dropped from ${source.name} › ${from}.` : '',
          move
            ? `Open tabs of what is moved are closed. A move can't be undone from the Undo History.`
            : collections.length > dropped.filter((i) => !i.isView).length
              ? UndoHistory.note(destination.id, Math.max(0, ...counts.values()))
              : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      words.button,
    );
    if (answer !== words.button) return undefined;

    const started = Date.now();
    let run: Awaited<ReturnType<typeof pasteCollections>>;
    try {
      run = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${words.doing} into ${where}`, cancellable: true }, (progress, token) => {
        let reported = 0;
        let current = '';
        return pasteCollections(
          src,
          from,
          dst,
          to,
          items,
          mode,
          {
            starting: (item) => {
              reported = 0;
              current = `${item.target} (${going.indexOf(item) + 1} of ${going.length})`;
              progress.report({ message: current });
            },
            progress: (item, done) => {
              const size = counts.get(item.source) ?? 0;
              progress.report({
                increment: total ? ((Math.min(done, size) - Math.min(reported, size)) / total) * 100 : undefined,
                message: `${current}: ${done.toLocaleString('en-US')} of ${size.toLocaleString('en-US')} documents`,
              });
              reported = done;
            },
            cancelled: () => token.isCancellationRequested,
            published: (item, events) => RedisOplog.sink({ connectionId: destination.id, database: to, collection: item.target })?.publish(events),
            // Undoing the copy of a move would delete the only documents left: a move isn't recorded.
            recorder: move
              ? undefined
              : (item) => UndoHistory.start({ connectionId: destination.id, database: to, collection: item.target }, `Paste ${source.name} › ${from}.${item.source}`, counts.get(item.source) ?? 0),
          },
          undefined,
          move ? { sameDeployment: sameConnection } : undefined,
        );
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`${words.noun} failed: ${errorMessage(err)}`);
      void vscode.commands.executeCommand('mongoster.refresh');
      return undefined;
    }
    for (const o of run.outcomes) {
      if (o.action === 'skip') continue;
      const target = { connectionId: destination.id, database: to, collection: o.item.target };
      if (o.moved) await this.events.moved({ connectionId: source.id, database: from, collection: o.item.source }, target);
      this.events.changed(target);
    }
    void vscode.commands.executeCommand('mongoster.refresh');

    const done = run.outcomes.filter((o) => o.action !== 'skip' && !o.error && (!move || o.moved));
    const copied = done.reduce((n, o) => n + (o.result?.copied ?? (o.moved === 'renamed' ? (counts.get(o.item.source) ?? 0) : 0)), 0);
    const sum = (of: 'skipped' | 'failed') => run.outcomes.reduce((n, o) => n + (o.result?.[of] ?? 0), 0);
    const entries = run.outcomes.flatMap((o) => (o.entry ? [o.entry] : []));
    const details = [
      ...run.outcomes.filter((o) => o.error).map((o) => `${o.item.target} failed: ${o.error}`),
      ...run.outcomes.filter((o) => o.kept).map((o) => `${o.item.source} stays in ${source.name} › ${from}: ${o.kept}`),
      sum('skipped') ? `${count(sum('skipped'), 'document')} skipped (their _id already existed)` : '',
      sum('failed') ? `${count(sum('failed'), 'document')} failed: ${run.outcomes.find((o) => o.result?.firstError)?.result?.firstError}` : '',
      ...run.outcomes.flatMap((o) => (o.result?.indexErrors ?? []).map((e) => `Index of ${o.item.target} not created — ${e}`)),
      ...run.outcomes.filter((o) => o.recorderOverflow).map((o) => `${o.item.target} can't be undone: ${o.recorderOverflow}, too many for the undo history`),
      entries.length > 1 ? `Each collection can be undone from the Undo History` : '',
    ].filter(Boolean);
    const pastedViews = done.filter((o) => o.item.isView).length;
    const parts = [
      done.length - pastedViews ? `${count(done.length - pastedViews, 'collection')} (${count(copied, 'document')})` : '',
      pastedViews ? count(pastedViews, 'view') : '',
    ].filter(Boolean);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const tail = details.length ? ` ${details.join('. ')}.` : '';
    const message = run.cancelled
      ? `${words.noun} cancelled after ${parts.join(' and ') || 'nothing'}; what was ${move ? 'moved' : 'copied'} stays in ${where}.${tail}`
      : `${wording === 'rename' ? `Renamed the database ${from} to ${to}: moved` : words.done} ${parts.join(' and ') || 'nothing'}${wording === 'rename' ? '' : ` into ${where}`} in ${seconds} s.${tail}`;
    const failed = run.outcomes.some((o) => o.error || o.kept || o.result?.failed);
    const problems = run.cancelled || failed || run.outcomes.some((o) => o.result?.indexErrors.length || o.recorderOverflow);
    const show = problems ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const single = done.length === 1 ? done[0] : undefined;
    const buttons = [...(single ? ['Open'] : []), ...(entries.length === 1 ? ['Undo'] : [])];
    // The answer comes when the notification is dismissed: the next database of a paste doesn't wait for it.
    void show(message, ...buttons).then((next) => {
      if (next === 'Open' && single) this.events.opened({ connectionId: destination.id, database: to, collection: single.item.target }, single.item.isView);
      if (next === 'Undo') void UndoHistory.get()?.undoAndReport(entries[0].id);
    });
    return { cancelled: run.cancelled, clean: !run.cancelled && !failed && going.length === items.length };
  }
}
