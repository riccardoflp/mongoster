// The store of the project's saved queries on a temporary folder, with a fake vscode module.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  folders: [] as { uri: { scheme: string; fsPath: string }; name: string }[],
  setting: '.mongoster/queries',
  warnings: [] as string[],
  quickPick: undefined as unknown,
}));

vi.mock('vscode', async () => {
  const stub = await vi.importActual<typeof import('../stubs/vscode')>('../stubs/vscode');
  const disposable = { dispose: () => undefined };
  return {
    ...stub,
    Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
    RelativePattern: class {
      constructor(
        readonly base: unknown,
        readonly pattern: string,
      ) {}
    },
    workspace: {
      get workspaceFolders() {
        return fake.folders;
      },
      getConfiguration: () => ({ get: () => fake.setting }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
      createFileSystemWatcher: () => ({ ...disposable, onDidCreate: () => disposable, onDidChange: () => disposable, onDidDelete: () => disposable }),
    },
    window: {
      showWarningMessage: (text: string) => {
        fake.warnings.push(text);
        return Promise.resolve(undefined);
      },
      showQuickPick: (items: { folder: unknown }[]) => Promise.resolve(fake.quickPick ?? items[0]),
    },
  };
});

const { ProjectQueries } = await import('../../src/projectQueries');

let dir: string;
const context = () => ({ globalState: { get: () => undefined, update: () => Promise.resolve() } }) as never;
const scope = { connectionName: 'Local', database: 'shop', collection: 'orders' };
const find = (filter: string) => ({ filter, sort: '', projection: '' });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoster-queries-'));
  fake.folders = [{ uri: { scheme: 'file', fsPath: dir }, name: 'repo' }];
  fake.setting = '.mongoster/queries';
  fake.warnings = [];
  fake.quickPick = undefined;
});

afterEach(() => {
  ProjectQueries.instance?.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProjectQueries', () => {
  it('saves, replaces, renames and deletes query files', async () => {
    const store = ProjectQueries.init(context());
    expect(await store.save(scope, 'Late orders', find('{ late: true }'))).toBe('.mongoster/queries/shop/orders/late-orders.json');
    const file = path.join(dir, '.mongoster', 'queries', 'shop', 'orders', 'late-orders.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ name: 'Late orders', database: 'shop', collection: 'orders', filter: '{ late: true }' });

    // The same name replaces the file; another collection doesn't see it.
    await store.save(scope, 'Late orders', find('{ late: 1 }'));
    expect(store.list(scope).map((q) => [q.name, q.filter, q.source, q.file])).toEqual([['Late orders', '{ late: 1 }', 'project', '.mongoster/queries/shop/orders/late-orders.json']]);
    expect(store.list({ ...scope, collection: 'users' })).toEqual([]);

    const [saved] = store.list(scope);
    await store.rename(saved.id, 'Very late');
    expect(fs.existsSync(file)).toBe(false);
    const [renamed] = store.list(scope);
    expect([renamed.name, renamed.file]).toEqual(['Very late', '.mongoster/queries/shop/orders/very-late.json']);

    await store.remove(renamed.id);
    expect(store.list(scope)).toEqual([]);
    // The emptied folders go too, not the queries folder.
    expect(fs.existsSync(path.join(dir, '.mongoster', 'queries', 'shop'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.mongoster', 'queries'))).toBe(true);
  });

  it('reads files written by hand, skips invalid ones with a warning once, and matches the connection by name', async () => {
    const folder = path.join(dir, '.mongoster', 'queries');
    fs.mkdirSync(path.join(folder, 'any'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'any', 'a.json'), JSON.stringify({ name: 'Prod only', connection: 'Production', database: 'shop', collection: 'orders', filter: '{}' }));
    fs.writeFileSync(path.join(folder, 'b.json'), JSON.stringify({ name: 'Everywhere', database: 'shop', collection: 'orders', sort: '{ at: -1 }' }));
    fs.writeFileSync(path.join(folder, 'broken.json'), '{ "name": ');
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a query');
    const store = ProjectQueries.init(context());
    await store.reload();
    expect(store.list(scope).map((q) => q.name)).toEqual(['Everywhere']);
    expect(store.list({ ...scope, connectionName: 'Production' }).map((q) => q.name).sort()).toEqual(['Everywhere', 'Prod only']);
    expect(fake.warnings).toHaveLength(1);
    expect(fake.warnings[0]).toMatch(/^Mongoster skipped the saved query \.mongoster\/queries\/broken\.json: not valid JSON/);

    await store.reload();
    expect(fake.warnings).toHaveLength(1);
  });

  it('uses an absolute folder as it is, and asks the folder when there are several', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoster-other-'));
    try {
      fake.folders.push({ uri: { scheme: 'file', fsPath: other }, name: 'api' });
      const store = ProjectQueries.init(context());
      fake.quickPick = { folder: store.folders()[1] };
      expect(await store.save(scope, 'Q', find('{}'))).toBe('api: .mongoster/queries/shop/orders/q.json');

      fake.setting = path.join(other, 'shared');
      expect(store.folders()).toEqual([{ folder: path.join(other, 'shared'), label: 'shared' }]);
      expect(await store.save(scope, 'Q', find('{}'))).toBe(path.join(other, 'shared', 'shop', 'orders', 'q.json'));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
