import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { CollectionNode, ConnectionNode, MongoTreeProvider, TreeNode, errorMessage } from './tree';
import { CollectionPanel } from './collectionPanel';
import { DOC_SCHEME, DocumentFileSystem } from './documentFs';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context);
  const tree = new MongoTreeProvider(connections);
  const documents = new DocumentFileSystem(connections);
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
  );
}

export function deactivate(): void {}

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
