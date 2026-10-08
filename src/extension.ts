import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { CollectionNode, ConnectionNode, DatabaseNode, MongoTreeProvider, TreeNode, errorMessage } from './tree';
import { CollectionPanel, expandedStateKey, layoutStateKey, moveCollectionState } from './collectionPanel';
import { Manager } from './manage';
import { exportDocuments, importDocuments } from './transfer';
import { CollectionRef, DOC_SCHEME, DocumentFileSystem } from './documentFs';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context);
  const tree = new MongoTreeProvider(connections);
  const documents = new DocumentFileSystem(connections);
  const manager = new Manager(connections);
  const collectionTarget = (node: CollectionNode) => ({
    connectionId: node.connection.id,
    connectionName: node.connection.name,
    database: node.database,
    collection: node.collection,
    readOnly: node.isView,
  });

  context.subscriptions.push(
    connections,
    vscode.window.createTreeView('mongoster.connections', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.workspace.registerFileSystemProvider(DOC_SCHEME, documents, { isCaseSensitive: true }),
    documents.onDidSave((ref) => CollectionPanel.refresh(ref)),

    vscode.commands.registerCommand('mongoster.addConnection', () => addConnection(connections)),

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

    vscode.commands.registerCommand('mongoster.insertDocument', (node?: CollectionNode) =>
      node ? documents.openNew(collectionTarget(node)) : undefined,
    ),

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

async function addConnection(connections: ConnectionManager): Promise<void> {
  const uri = (
    await vscode.window.showInputBox({
      title: 'Add MongoDB Connection (1/2)',
      prompt: 'Connection string',
      value: 'mongodb://localhost:27017',
      ignoreFocusOut: true,
      validateInput: (v) =>
        /^mongodb(\+srv)?:\/\//.test(v.trim()) ? undefined : 'Must start with mongodb:// or mongodb+srv://',
    })
  )?.trim();
  if (!uri) return;

  const fallbackName = hostOf(uri);
  const name = await vscode.window.showInputBox({
    title: 'Add MongoDB Connection (2/2)',
    prompt: 'Display name',
    value: fallbackName,
    ignoreFocusOut: true,
  });
  if (name === undefined) return;

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
    if (choice !== 'Save Anyway') return;
  }
  await connections.add(name.trim() || fallbackName, uri);
}

/** Host part of a connection string, without credentials. */
function hostOf(uri: string): string {
  return /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1] ?? 'MongoDB';
}
