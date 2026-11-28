// `Copy` and `Paste` in the connections view. Copy remembers the selected connections, databases or collections;
// Paste puts them where it is used: a connection becomes another connection with the same settings, a database is
// copied to a connection, collections and views to a database. The data is copied by `pasteCollections` (`src/copy.ts`).
import * as vscode from 'vscode';
import type { MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { CollectionRef } from './documentFs';
import { existingNames, pasteCollections, pasteSources } from './copy';
import { databaseNameError } from './manage';
import { BucketNode, CollectionNode, ConnectionNode, DatabaseNode, FolderNode, TreeNode, errorMessage } from './tree';
import { UndoHistory } from './history';
import { Clipboard, CopiedNode, ExistingMode, PasteItem, PasteSource, clipboardOf, copyName, pasteAction, planPaste } from './shared/paste';

type Pick<T> = vscode.QuickPickItem & { value: T };

/** The names shown in a confirmation before `and N more`. */
const LISTED = 8;

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function copiedNode(node: TreeNode): CopiedNode {
  if (node instanceof ConnectionNode) return { kind: 'connection', connectionId: node.info.id };
  if (node instanceof DatabaseNode) return { kind: 'database', connectionId: node.connection.id, database: node.database };
  if (node instanceof CollectionNode) {
    return { kind: 'collection', connectionId: node.connection.id, database: node.database, collection: node.collection, isView: node.isView };
  }
  return { kind: 'other' };
}

export class TreeClipboard {
  private clipboard: Clipboard | undefined;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly opened: (ref: CollectionRef, isView: boolean) => void,
    /** A collection got documents: its open tab shows them. */
    private readonly changed: (ref: CollectionRef) => void,
  ) {}

  /** Remembers the nodes, and puts their names on the system's clipboard. */
  async copy(nodes: readonly TreeNode[]): Promise<void> {
    const clipboard = clipboardOf(nodes.map(copiedNode));
    if (typeof clipboard === 'string') {
      void vscode.window.showWarningMessage(clipboard);
      return;
    }
    this.clipboard = clipboard;
    void vscode.commands.executeCommand('setContext', 'mongoster.clipboard', clipboard.kind);
    const names =
      clipboard.kind === 'connection'
        ? clipboard.connectionIds.map((id) => this.connections.get(id)?.name ?? '')
        : clipboard.kind === 'database'
          ? clipboard.databases
          : clipboard.collections.map((c) => c.name);
    await vscode.env.clipboard.writeText(names.join('\n'));
    const what =
      clipboard.kind === 'connection'
        ? `${count(names.length, 'connection')} copied: paste on a folder or a connection`
        : clipboard.kind === 'database'
          ? `${count(names.length, 'database')} copied: paste on a connection`
          : `${count(names.length, 'collection')} copied: paste on a database or a connection`;
    vscode.window.setStatusBarMessage(`Mongoster: ${what}`, 5000);
  }

  async paste(target: TreeNode | undefined): Promise<void> {
    const clipboard = this.clipboard;
    if (!clipboard) {
      void vscode.window.showInformationMessage('Nothing to paste: copy a connection, a database or collections in the connections view first.');
      return;
    }
    if (clipboard.kind === 'connection') return this.pasteConnections(clipboard.connectionIds, target);

    const source = this.connections.get(clipboard.connectionId);
    if (!source) {
      void vscode.window.showErrorMessage('The connection of what was copied has been removed.');
      return;
    }
    const node = target instanceof ConnectionNode ? target.info : target instanceof DatabaseNode || target instanceof CollectionNode || target instanceof BucketNode ? target.connection : undefined;
    const destination = node && (this.connections.get(node.id) ?? node);
    if (!destination) {
      void vscode.window.showWarningMessage(`Select the connection${clipboard.kind === 'collection' ? ' or the database' : ''} to paste on.`);
      return;
    }
    if (destination.readOnly) {
      void vscode.window.showErrorMessage(`The connection ${destination.name} is read-only: nothing can be pasted on it.`);
      return;
    }
    let src: MongoClient;
    let dst: MongoClient;
    try {
      src = await this.connections.getClient(source.id);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${source.name}: ${errorMessage(err)}`);
      return;
    }
    let databases: string[];
    try {
      dst = await this.connections.getClient(destination.id);
      databases = (await dst.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${destination.name}: ${errorMessage(err)}`);
      return;
    }
    const ends = { source, src, destination, dst };

    if (clipboard.kind === 'database') {
      for (const database of clipboard.databases) {
        const same = source.id === destination.id;
        const name = (
          await vscode.window.showInputBox({
            title: `Paste the database ${database} on ${destination.name}`,
            prompt: 'Name of the copy (an existing database receives the collections)',
            value: databases.includes(database) ? copyName(database, databases, 'identifier') : database,
            ignoreFocusOut: true,
            validateInput: (v) => databaseNameError(v.trim()) ?? (same && v.trim() === database ? 'That is the database being copied' : undefined),
          })
        )?.trim();
        if (!name) return;
        let sources: PasteSource[];
        try {
          sources = await pasteSources(src, database);
        } catch (err) {
          void vscode.window.showErrorMessage(errorMessage(err));
          return;
        }
        if (!sources.length) {
          void vscode.window.showInformationMessage(`The database ${database} has no collections to copy.`);
          continue;
        }
        if (!(await this.pasteInto(ends, database, sources, name, `the database ${database}`))) return;
        if (!databases.includes(name)) databases.push(name);
      }
      return;
    }

    let database = target instanceof ConnectionNode ? undefined : (target as DatabaseNode | CollectionNode | BucketNode).database;
    if (database === undefined) {
      const NEW = '$(add) New database…';
      const ordered = [...databases.filter((d) => d === clipboard.database), ...databases.filter((d) => d !== clipboard.database && !['admin', 'local', 'config'].includes(d))];
      const pick = await vscode.window.showQuickPick([...ordered, NEW], { title: `Paste on ${destination.name}: database`, ignoreFocusOut: true });
      if (!pick) return;
      database =
        pick === NEW
          ? (
              await vscode.window.showInputBox({
                title: `Paste on ${destination.name}: new database`,
                prompt: `Database name on ${destination.name}`,
                ignoreFocusOut: true,
                validateInput: (v) => databaseNameError(v.trim()) ?? (databases.includes(v.trim()) ? 'This database already exists' : undefined),
              })
            )?.trim()
          : pick;
      if (!database) return;
    }
    const names = clipboard.collections.map((c) => c.name);
    await this.pasteInto(ends, clipboard.database, clipboard.collections, database, names.length === 1 ? `${clipboard.database}.${names[0]}` : `${count(names.length, 'collection')} of ${clipboard.database}`);
  }

  /** Each connection again, with its settings and secrets, in the folder pasted on. */
  private async pasteConnections(ids: string[], target: TreeNode | undefined): Promise<void> {
    const on = target instanceof ConnectionNode ? target.info : target instanceof DatabaseNode || target instanceof CollectionNode || target instanceof BucketNode ? target.connection : undefined;
    const pasted: string[] = [];
    for (const id of ids) {
      const source = this.connections.get(id);
      if (!source) continue;
      const folder = target instanceof FolderNode ? target.folder : on ? this.connections.get(on.id)?.folder : source.folder;
      const name = copyName(
        source.name,
        this.connections.list().map((c) => c.name),
        'label',
      );
      if (await this.connections.duplicate(id, name, folder)) pasted.push(name);
    }
    if (!pasted.length) void vscode.window.showErrorMessage('The copied connection has been removed.');
    else vscode.window.setStatusBarMessage(`Mongoster: pasted ${pasted.length === 1 ? `the connection ${pasted[0]}` : count(pasted.length, 'connection')}`, 5000);
  }

  /**
   * Asks what to do with what exists, confirms and copies `sources` of the database `from` into the database `to`.
   * False when the user gave up.
   */
  private async pasteInto(
    ends: { source: ConnectionInfo; src: MongoClient; destination: ConnectionInfo; dst: MongoClient },
    from: string,
    sources: PasteSource[],
    to: string,
    what: string,
  ): Promise<boolean> {
    const { source, src, destination, dst } = ends;
    const where = `${destination.name} › ${to}`;
    let items: PasteItem[];
    try {
      items = planPaste(sources, await existingNames(dst, to), source.id === destination.id && from === to);
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return false;
    }

    let mode: ExistingMode = 'skip';
    const existing = items.filter((i) => i.exists);
    if (existing.length) {
      const pick = await vscode.window.showQuickPick<Pick<ExistingMode>>(
        [
          { label: 'Skip', description: 'what exists stays as it is; only the others are pasted', value: 'skip' },
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
      if (!pick) return false;
      mode = pick.value;
    }

    const going = items.filter((i) => pasteAction(i, mode).do !== 'skip');
    if (!going.length) {
      void vscode.window.showInformationMessage(`Nothing to paste: everything exists in ${where}.`);
      return true;
    }
    // The number of documents of each collection: for the progress and for what the undo history can keep.
    const counts = new Map<string, number>();
    try {
      for (const item of going) if (!item.isView) counts.set(item.source, await src.db(from).collection(item.source).estimatedDocumentCount());
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return false;
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const collections = going.filter((i) => !i.isView);
    const views = going.filter((i) => i.isView);
    const dropped = going.filter((i) => pasteAction(i, mode).do === 'drop');
    const listed = going.slice(0, LISTED).map((i) => (i.target === i.source ? i.source : `${i.source} → ${i.target}`));
    const answer = await vscode.window.showWarningMessage(
      `Paste ${what} from ${source.name} into ${where}?`,
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
          collections.length > dropped.filter((i) => !i.isView).length ? UndoHistory.note(destination.id, Math.max(0, ...counts.values())) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      'Paste',
    );
    if (answer !== 'Paste') return false;

    const started = Date.now();
    let run: Awaited<ReturnType<typeof pasteCollections>>;
    try {
      run = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pasting into ${where}`, cancellable: true }, (progress, token) => {
        let reported = 0;
        let current = '';
        return pasteCollections(src, from, dst, to, items, mode, {
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
          recorder: (item) => UndoHistory.start({ connectionId: destination.id, database: to, collection: item.target }, `Paste ${source.name} › ${from}.${item.source}`, counts.get(item.source) ?? 0),
        });
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`Paste failed: ${errorMessage(err)}`);
      void vscode.commands.executeCommand('mongoster.refresh');
      return false;
    }
    void vscode.commands.executeCommand('mongoster.refresh');
    for (const o of run.outcomes) if (o.action !== 'skip') this.changed({ connectionId: destination.id, database: to, collection: o.item.target });

    const done = run.outcomes.filter((o) => o.action !== 'skip' && !o.error);
    const copied = done.reduce((n, o) => n + (o.result?.copied ?? 0), 0);
    const sum = (of: 'skipped' | 'failed') => run.outcomes.reduce((n, o) => n + (o.result?.[of] ?? 0), 0);
    const entries = run.outcomes.flatMap((o) => (o.entry ? [o.entry] : []));
    const details = [
      ...run.outcomes.filter((o) => o.error).map((o) => `${o.item.target} failed: ${o.error}`),
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
    const message = run.cancelled
      ? `Paste cancelled after ${parts.join(' and ') || 'nothing'}; what was copied stays in ${where}.${details.length ? ` ${details.join('. ')}.` : ''}`
      : `Pasted ${parts.join(' and ') || 'nothing'} into ${where} in ${seconds} s.${details.length ? ` ${details.join('. ')}.` : ''}`;
    const problems = run.cancelled || run.outcomes.some((o) => o.error || o.result?.failed || o.result?.indexErrors.length || o.recorderOverflow);
    const show = problems ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const single = done.length === 1 ? done[0] : undefined;
    const buttons = [...(single ? ['Open'] : []), ...(entries.length === 1 ? ['Undo'] : [])];
    // The answer comes when the notification is dismissed: the next database of a paste doesn't wait for it.
    void show(message, ...buttons).then((next) => {
      if (next === 'Open' && single) this.opened({ connectionId: destination.id, database: to, collection: single.item.target }, single.item.isView);
      if (next === 'Undo') void UndoHistory.get()?.undoAndReport(entries[0].id);
    });
    return !run.cancelled;
  }
}
