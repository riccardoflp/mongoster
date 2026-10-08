// Creating, renaming and dropping databases and collections from the tree.
import * as vscode from 'vscode';
import type { ConnectionInfo, ConnectionManager } from './connections';
import { errorMessage } from './tree';
import { toBson } from './queries';

/** Names MongoDB rejects, checked before asking the server (which gives less helpful messages). */
export function databaseNameError(name: string): string | undefined {
  if (!name) return 'Enter a name';
  if (/[/\\. "$*<>:|?\0]/.test(name)) return 'A database name cannot contain spaces or / \\ . " $ * < > : | ?';
  if (Buffer.byteLength(name) > 63) return 'A database name is at most 63 bytes';
  return undefined;
}

export function collectionNameError(name: string): string | undefined {
  if (!name) return 'Enter a name';
  if (name.includes('$') || name.includes('\0')) return 'A collection name cannot contain $';
  if (name.startsWith('system.')) return 'Names starting with "system." are reserved';
  if (name.startsWith('.') || name.endsWith('.')) return 'A collection name cannot start or end with a dot';
  return undefined;
}

export class Manager {
  constructor(private readonly connections: ConnectionManager) {}

  /** Read-only connections: refuse before asking anything. */
  private locked(info: ConnectionInfo): boolean {
    if (!info.readOnly) return false;
    void vscode.window.showErrorMessage(`The connection ${info.name} is read-only.`);
    return true;
  }

  /** A database exists only with a collection in it, so this asks for both. */
  async createDatabase(info: ConnectionInfo): Promise<{ database: string; collection: string } | undefined> {
    if (this.locked(info)) return undefined;
    const client = await this.connections.getClient(info.id);
    const existing = await client
      .db('admin')
      .admin()
      .listDatabases({ nameOnly: true, authorizedDatabases: true })
      .then((r) => r.databases.map((d) => d.name))
      .catch(() => [] as string[]);
    const database = await vscode.window.showInputBox({
      title: 'Create Database (1/2)',
      prompt: `Database name on ${info.name}`,
      ignoreFocusOut: true,
      validateInput: (v) => databaseNameError(v.trim()) ?? (existing.includes(v.trim()) ? 'This database already exists' : undefined),
    });
    if (!database) return undefined;
    const collection = await vscode.window.showInputBox({
      title: 'Create Database (2/2)',
      prompt: 'Name of its first collection (MongoDB creates a database together with a collection)',
      ignoreFocusOut: true,
      validateInput: (v) => collectionNameError(v.trim()),
    });
    if (!collection) return undefined;
    return (await this.run(() => client.db(database.trim()).createCollection(collection.trim())))
      ? { database: database.trim(), collection: collection.trim() }
      : undefined;
  }

  async createCollection(info: ConnectionInfo, database: string): Promise<string | undefined> {
    if (this.locked(info)) return undefined;
    const db = (await this.connections.getClient(info.id)).db(database);
    const existing = await this.collectionNames(info, database);
    const name = (
      await vscode.window.showInputBox({
        title: `Create Collection in ${database} (1/2)`,
        prompt: 'Collection name',
        ignoreFocusOut: true,
        validateInput: (v) => collectionNameError(v.trim()) ?? (existing.includes(v.trim()) ? 'This collection already exists' : undefined),
      })
    )?.trim();
    if (!name) return undefined;
    const optionsText = await vscode.window.showInputBox({
      title: `Create Collection ${database}.${name} (2/2)`,
      prompt: 'Options, optional: leave empty for a regular collection',
      placeHolder: '{ capped: true, size: 1048576 }  or  { timeseries: { timeField: "ts" } }',
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          toBson(v, 'Options');
          return undefined;
        } catch (err) {
          return errorMessage(err);
        }
      },
    });
    if (optionsText === undefined) return undefined;
    return (await this.run(() => db.createCollection(name, toBson(optionsText, 'Options')))) ? name : undefined;
  }

  /** Renames within the same database; returns the new name. */
  async renameCollection(info: ConnectionInfo, database: string, collection: string): Promise<string | undefined> {
    if (this.locked(info)) return undefined;
    const db = (await this.connections.getClient(info.id)).db(database);
    const existing = await this.collectionNames(info, database);
    const name = (
      await vscode.window.showInputBox({
        title: `Rename Collection ${database}.${collection}`,
        prompt: 'New name',
        value: collection,
        ignoreFocusOut: true,
        validateInput: (v) =>
          collectionNameError(v.trim()) ??
          (v.trim() !== collection && existing.includes(v.trim()) ? 'A collection with this name already exists' : undefined),
      })
    )?.trim();
    if (!name || name === collection) return undefined;
    return (await this.run(() => db.renameCollection(collection, name))) ? name : undefined;
  }

  async dropCollection(info: ConnectionInfo, database: string, collection: string, isView: boolean): Promise<boolean> {
    if (this.locked(info)) return false;
    const db = (await this.connections.getClient(info.id)).db(database);
    if (isView) {
      const answer = await vscode.window.showWarningMessage(
        `Drop view ${database}.${collection}?`,
        { modal: true, detail: 'The documents of its source collection are not affected.' },
        'Drop',
      );
      return answer === 'Drop' && this.run(() => db.dropCollection(collection));
    }
    const coll = db.collection(collection);
    const [count, indexes] = await Promise.all([
      coll.estimatedDocumentCount().catch(() => undefined),
      coll.listIndexes().toArray().then((l) => l.length, () => undefined),
    ]);
    const what = [
      count !== undefined && plural(count, 'document'),
      indexes !== undefined && plural(indexes, 'index', 'indexes'),
    ].filter(Boolean);
    const confirmed = await this.typeToConfirm(
      `Drop Collection ${database}.${collection}`,
      `${what.length ? `Deletes ${what.join(' and ')}. ` : ''}This cannot be undone.`,
      collection,
    );
    return confirmed && this.run(() => db.dropCollection(collection));
  }

  async dropDatabase(info: ConnectionInfo, database: string): Promise<boolean> {
    if (this.locked(info)) return false;
    const db = (await this.connections.getClient(info.id)).db(database);
    const names = await this.collectionNames(info, database).then(
      (all) => all.filter((n) => !n.startsWith('system.')),
      () => undefined,
    );
    const confirmed = await this.typeToConfirm(
      `Drop Database ${database}`,
      `${names ? `Deletes ${plural(names.length, 'collection')} with all their documents. ` : ''}This cannot be undone.`,
      database,
    );
    return confirmed && this.run(() => db.dropDatabase());
  }

  private async collectionNames(info: ConnectionInfo, database: string): Promise<string[]> {
    const db = (await this.connections.getClient(info.id)).db(database);
    const list = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
    return list.map((c) => c.name);
  }

  /** Destructive operations: the name must be typed, a click is too easy to get wrong. */
  private async typeToConfirm(title: string, detail: string, name: string): Promise<boolean> {
    const typed = await vscode.window.showInputBox({
      title,
      prompt: `${detail} Type "${name}" to confirm.`,
      placeHolder: name,
      ignoreFocusOut: true,
      validateInput: (v) => (v === name ? undefined : `Type "${name}" to confirm`),
    });
    return typed === name;
  }

  private async run(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return false;
    }
  }
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
}
