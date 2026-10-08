import * as vscode from 'vscode';
import { CONNECTION_COLORS, ConnectionColor, ConnectionInfo, ConnectionManager } from './connections';
import { CollectionNode, ConnectionNode, DatabaseNode, FolderNode, MongoTreeProvider, TreeNode, errorMessage } from './tree';
import { CollectionPanel, CollectionTarget, expandedStateKey, layoutStateKey, moveCollectionState, readOnlyMessage } from './collectionPanel';
import { Manager } from './manage';
import { exportDocuments, importDocuments } from './transfer';
import { CollectionRef, DOC_SCHEME, DocumentFileSystem } from './documentFs';
import { DEF_SCHEME, DefinitionFileSystem } from './definitionFs';
import { Playgrounds } from './playground/playground';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context);
  const tree = new MongoTreeProvider(connections);
  const documents = new DocumentFileSystem(connections);
  const manager = new Manager(connections);
  const definitions = new DefinitionFileSystem(connections);
  /** Definitions of a read-only connection open read-only; views' definitions can be edited otherwise. */
  const definitionRef = (arg: CollectionNode | CollectionRef): CollectionRef =>
    arg instanceof CollectionNode
      ? { connectionId: arg.connection.id, database: arg.database, collection: arg.collection, readOnly: !!arg.connection.readOnly }
      : arg;
  const collectionTarget = (node: CollectionNode): CollectionTarget => ({
    connectionId: node.connection.id,
    connectionName: node.connection.name,
    database: node.database,
    collection: node.collection,
    readOnly: node.isView || !!node.connection.readOnly,
    view: node.isView,
    locked: !!node.connection.readOnly,
    color: node.connection.color,
  });
  /** Saves connection changes and applies them to the open collection tabs. */
  const updateConnection = async (id: string, changes: Partial<Omit<ConnectionInfo, 'id'>>, uri?: string) => {
    const info = await connections.update(id, changes, uri);
    if (info) CollectionPanel.connectionChanged(info);
  };

  context.subscriptions.push(
    connections,
    new Playgrounds(context, connections),
    vscode.window.createTreeView('mongoster.connections', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.workspace.registerFileSystemProvider(DOC_SCHEME, documents, { isCaseSensitive: true }),
    documents.onDidSave((ref) => CollectionPanel.refresh(ref)),
    vscode.workspace.registerFileSystemProvider(DEF_SCHEME, definitions, { isCaseSensitive: true }),
    definitions.onDidSave((ref) => CollectionPanel.refresh(ref)),

    vscode.commands.registerCommand('mongoster.editValidation', (arg?: CollectionNode | CollectionRef) =>
      arg ? definitions.open(definitionRef(arg), 'validation') : undefined,
    ),

    vscode.commands.registerCommand('mongoster.editView', (arg?: CollectionNode | CollectionRef) =>
      arg ? definitions.open(definitionRef(arg), 'view') : undefined,
    ),

    vscode.commands.registerCommand('mongoster.addConnection', (node?: FolderNode) =>
      addConnection(connections, node instanceof FolderNode ? node.folder : undefined),
    ),

    vscode.commands.registerCommand('mongoster.editConnection', async (node?: ConnectionNode) => {
      if (!node) return;
      const edited = await askConnection(connections, node.info);
      if (edited) await updateConnection(node.info.id, { name: edited.name }, edited.uri);
    }),

    vscode.commands.registerCommand('mongoster.copyConnectionString', async (node?: ConnectionNode) => {
      const uri = node && (await connections.uri(node.info.id));
      if (!uri) return;
      await vscode.env.clipboard.writeText(uri);
      vscode.window.setStatusBarMessage('Mongoster: connection string copied (it may contain the password)', 4000);
    }),

    vscode.commands.registerCommand('mongoster.setColor', async (node?: ConnectionNode) => {
      if (!node) return;
      const items = [
        ...CONNECTION_COLORS.map((color) => ({ label: `${COLOR_EMOJI[color]} ${capitalize(color)}`, color: color as ConnectionColor | undefined })),
        { label: '⚪ None', color: undefined },
      ].map((i) => ({ ...i, description: i.color === node.info.color ? 'current' : undefined }));
      const pick = await vscode.window.showQuickPick(items, {
        title: `Color of ${node.info.name}`,
        placeHolder: 'Shown on the tree icon and as a stripe on its collection tabs, e.g. red for production',
      });
      if (pick) await updateConnection(node.info.id, { color: pick.color });
    }),

    vscode.commands.registerCommand('mongoster.setReadOnly', (node?: ConnectionNode) =>
      node ? updateConnection(node.info.id, { readOnly: true }) : undefined,
    ),

    vscode.commands.registerCommand('mongoster.clearReadOnly', async (node?: ConnectionNode) => {
      if (!node) return;
      const answer = await vscode.window.showWarningMessage(
        `Allow changes through ${node.info.name}?`,
        { modal: true, detail: 'Documents, indexes, collections and databases can then be modified from Mongoster.' },
        'Allow Changes',
      );
      if (answer === 'Allow Changes') await updateConnection(node.info.id, { readOnly: false });
    }),

    vscode.commands.registerCommand('mongoster.moveToFolder', async (node?: ConnectionNode) => {
      if (!node) return;
      const current = node.info.folder;
      const NEW = '$(new-folder) New Folder…';
      const NONE = '$(close) No Folder';
      const items = [
        ...connections.folders().filter((f) => f !== current).map((f) => `$(folder) ${f}`),
        NEW,
        ...(current ? [NONE] : []),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: `Move ${node.info.name} to Folder` });
      if (!pick) return;
      let folder: string | undefined = pick.replace(/^\$\(folder\) /, '');
      if (pick === NONE) folder = undefined;
      else if (pick === NEW) {
        folder = (
          await vscode.window.showInputBox({
            title: 'New Folder',
            prompt: 'Folder name',
            validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
          })
        )?.trim();
        if (!folder) return;
      }
      await connections.update(node.info.id, { folder });
    }),

    vscode.commands.registerCommand('mongoster.renameFolder', async (node?: FolderNode) => {
      if (!node) return;
      const name = (
        await vscode.window.showInputBox({
          title: `Rename Folder ${node.folder}`,
          value: node.folder,
          validateInput: (v) =>
            !v.trim() ? 'Enter a name' : v.trim() !== node.folder && connections.folders().includes(v.trim()) ? 'This folder already exists' : undefined,
        })
      )?.trim();
      if (name && name !== node.folder) await connections.renameFolder(node.folder, name);
    }),

    vscode.commands.registerCommand('mongoster.removeFolder', (node?: FolderNode) =>
      node ? connections.renameFolder(node.folder, undefined) : undefined,
    ),

    vscode.commands.registerCommand('mongoster.removeConnection', async (node?: ConnectionNode) => {
      if (!node) return;
      const answer = await vscode.window.showWarningMessage(
        `Remove connection "${node.info.name}"?`,
        { modal: true },
        'Remove',
      );
      if (answer === 'Remove') await connections.remove(node.info.id);
    }),

    vscode.commands.registerCommand('mongoster.disconnect', (node?: ConnectionNode) =>
      node ? connections.disconnect(node.info.id) : undefined,
    ),

    vscode.commands.registerCommand('mongoster.refresh', (node?: TreeNode) => tree.refresh(node)),

    vscode.commands.registerCommand('mongoster.openCollection', (node: CollectionNode) =>
      CollectionPanel.show(context, connections, documents, collectionTarget(node)),
    ),

    vscode.commands.registerCommand('mongoster.insertDocument', (node?: CollectionNode) => {
      if (!node) return undefined;
      const target = collectionTarget(node);
      if (target.readOnly) return vscode.window.showErrorMessage(readOnlyMessage(target));
      return documents.openNew(target);
    }),

    vscode.commands.registerCommand('mongoster.exportCollection', (node?: CollectionNode) => {
      if (!node) return undefined;
      const target = collectionTarget(node);
      return exportDocuments(connections, target, { kind: 'find', filter: '', sort: '', projection: '' }, {
        expanded: context.globalState.get<string[]>(expandedStateKey(target), []),
        layout: context.globalState.get(layoutStateKey(target), {}),
      });
    }),

    vscode.commands.registerCommand('mongoster.createDatabase', async (node?: ConnectionNode) => {
      if (!node) return;
      const created = await manager.createDatabase(node.info);
      if (!created) return;
      tree.refresh();
      CollectionPanel.show(context, connections, documents, {
        connectionId: node.info.id,
        connectionName: node.info.name,
        ...created,
        readOnly: false,
        view: false,
        locked: false,
        color: node.info.color,
      });
    }),

    vscode.commands.registerCommand('mongoster.createCollection', async (node?: DatabaseNode) => {
      if (!node) return;
      const name = await manager.createCollection(node.connection, node.database);
      if (name) tree.refresh();
    }),

    vscode.commands.registerCommand('mongoster.renameCollection', async (node?: CollectionNode) => {
      if (!node || node.isView) return;
      const name = await manager.renameCollection(node.connection, node.database, node.collection);
      if (!name) return;
      const from = collectionTarget(node);
      const to = { ...from, collection: name };
      await moveCollectionState(context.globalState, from, to);
      // The open panel belongs to the old name: reopen it under the new one.
      if (CollectionPanel.close((t) => sameCollection(t, from)).length) {
        CollectionPanel.show(context, connections, documents, to);
      }
      tree.refresh();
    }),

    vscode.commands.registerCommand('mongoster.dropCollection', async (node?: CollectionNode) => {
      if (!node) return;
      if (!(await manager.dropCollection(node.connection, node.database, node.collection, node.isView))) return;
      CollectionPanel.close((t) => sameCollection(t, collectionTarget(node)));
      tree.refresh();
    }),

    vscode.commands.registerCommand('mongoster.dropDatabase', async (node?: DatabaseNode) => {
      if (!node) return;
      if (!(await manager.dropDatabase(node.connection, node.database))) return;
      CollectionPanel.close((t) => t.connectionId === node.connection.id && t.database === node.database);
      tree.refresh();
    }),

    vscode.commands.registerCommand('mongoster.importDocuments', async (node?: CollectionNode) => {
      if (!node) return;
      const target = collectionTarget(node);
      const result = await importDocuments(connections, target);
      if (result?.inserted) {
        CollectionPanel.refresh(target);
        tree.refresh();
      }
    }),
  );
}

export function deactivate(): void {}

function sameCollection(a: CollectionRef, b: CollectionRef): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && a.collection === b.collection;
}

const COLOR_EMOJI: Record<ConnectionColor, string> = { red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢', blue: '🔵', purple: '🟣' };
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

async function addConnection(connections: ConnectionManager, folder?: string): Promise<void> {
  const answer = await askConnection(connections);
  if (answer) await connections.add(answer.name, answer.uri, folder);
}

/** Asks for connection string and name (prefilled from `existing`) and tests a new connection string. */
async function askConnection(connections: ConnectionManager, existing?: ConnectionInfo): Promise<{ uri: string; name: string } | undefined> {
  const verb = existing ? `Edit Connection ${existing.name}` : 'Add MongoDB Connection';
  const currentUri = existing ? await connections.uri(existing.id) : undefined;
  const uri = (
    await vscode.window.showInputBox({
      title: `${verb} (1/2)`,
      prompt: 'Connection string',
      value: currentUri ?? 'mongodb://localhost:27017',
      ignoreFocusOut: true,
      validateInput: (v) =>
        /^mongodb(\+srv)?:\/\//.test(v.trim()) ? undefined : 'Must start with mongodb:// or mongodb+srv://',
    })
  )?.trim();
  if (!uri) return undefined;

  const fallbackName = hostOf(uri);
  const name = await vscode.window.showInputBox({
    title: `${verb} (2/2)`,
    prompt: 'Display name',
    value: existing?.name ?? fallbackName,
    ignoreFocusOut: true,
  });
  if (name === undefined) return undefined;
  if (uri === currentUri) return { uri, name: name.trim() || existing!.name };

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${fallbackName}…` },
      () => ConnectionManager.test(uri),
    );
  } catch (err) {
    const choice = await vscode.window.showWarningMessage(
      `Could not connect: ${errorMessage(err)}`,
      'Save Anyway',
    );
    if (choice !== 'Save Anyway') return undefined;
  }
  return { uri, name: name.trim() || existing?.name || fallbackName };
}

/** Host part of a connection string, without credentials. */
function hostOf(uri: string): string {
  return /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1] ?? 'MongoDB';
}
