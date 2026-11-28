// Copy, Cut, Paste, dragging and Rename Database of the connections view, from the selected nodes to the data in
// the standalone mongod: what is asked and said, what is written, what the rest of Mongoster is told, and the undo
// of a paste. VS Code's windows are scripted: each question takes the next answer, and one nobody expects fails.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GridFSBucket, MongoClient } from 'mongodb';
import { type Mock, afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { ConnectionInfo, ConnectionManager } from '../../src/connections';
import { UndoHistory } from '../../src/history';
import { PasteEvents, TreeClipboard } from '../../src/paste';
import { BucketNode, CollectionNode, ConnectionNode, DatabaseNode, FolderNode, TreeNode } from '../../src/tree';

interface Asked {
  kind: 'pick' | 'input' | 'confirm';
  title?: string;
  items?: string[];
  placeHolder?: string;
  value?: string;
  validate?: (value: string) => string | undefined;
  message?: string;
  detail?: string;
  buttons?: string[];
}
type Answer = string | undefined | ((asked: Asked) => string | undefined);

const ui = vi.hoisted(() => ({
  answers: [] as unknown[],
  asked: [] as unknown[],
  /** Notifications, with their buttons after ` | `. */
  messages: [] as string[],
  status: [] as string[],
  context: {} as Record<string, unknown>,
  commands: [] as string[],
  clipboard: '',
}));

vi.mock('vscode', async (original) => {
  const next = (asked: { kind: string }) => {
    ui.asked.push(asked);
    if (!ui.answers.length) throw new Error(`A question nobody expects: ${JSON.stringify(asked)}`);
    const answer = ui.answers.shift();
    return typeof answer === 'function' ? (answer as (a: unknown) => unknown)(asked) : answer;
  };
  const label = (item: string | { label: string }) => (typeof item === 'string' ? item : item.label);
  const say = async (message: string, ...buttons: unknown[]) => {
    ui.messages.push([message, ...buttons].join(' | '));
    return undefined;
  };
  return {
    ...(await original<object>()),
    ProgressLocation: { Notification: 15 },
    window: {
      showQuickPick: async (items: (string | { label: string })[], options?: { title?: string; placeHolder?: string }) => {
        const answer = next({ kind: 'pick', title: options?.title, placeHolder: options?.placeHolder, items: items.map(label) } as never);
        if (answer === undefined) return undefined;
        const picked = items.find((i) => label(i) === answer);
        if (!picked) throw new Error(`"${String(answer)}" is not offered among ${items.map(label).join(', ')}`);
        return picked;
      },
      showInputBox: async (options: { title?: string; value?: string; validateInput?: (v: string) => string | undefined }) =>
        next({ kind: 'input', title: options.title, value: options.value, validate: options.validateInput } as never),
      showWarningMessage: async (message: string, ...rest: unknown[]) => {
        const options = rest[0] as { modal?: boolean; detail?: string } | undefined;
        if (options && typeof options === 'object' && options.modal) return next({ kind: 'confirm', message, detail: options.detail, buttons: rest.slice(1) } as never);
        return say(message, ...rest);
      },
      showInformationMessage: say,
      showErrorMessage: say,
      withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => unknown) => task({ report: () => undefined }, { isCancellationRequested: false }),
      setStatusBarMessage: (text: string) => void ui.status.push(text),
    },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        if (command === 'setContext') ui.context[args[0] as string] = args[1];
        else ui.commands.push(command);
      },
    },
    env: { clipboard: { writeText: async (text: string) => void (ui.clipboard = text) } },
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    },
  };
});

const SHOP = 'mongoster_clip_shop';
const CRM = 'mongoster_clip_crm';
const STORE = 'mongoster_clip_store';
const DATABASES = [SHOP, CRM, STORE, `${SHOP}_copy`];

let client: MongoClient;
let dir: string;
let connections: ConnectionManager;
let history: UndoHistory;
let clipboard: TreeClipboard;
/** Two connections to the same server, as production and a local copy would be two, a read-only one, one in a folder. */
let a: ConnectionInfo;
let b: ConnectionInfo;
let readOnly: ConnectionInfo;
let events: { [K in keyof PasteEvents]: Mock<PasteEvents[K]> };

const answer = (...answers: Answer[]) => ui.answers.push(...answers);
const asked = (index: number) => ui.asked[index] as Asked;
const fresh = (info: ConnectionInfo) => connections.get(info.id)!;
const connectionNode = (info: ConnectionInfo) => new ConnectionNode(fresh(info), true);
const databaseNode = (info: ConnectionInfo, database: string) => new DatabaseNode(fresh(info), database);
const collectionNode = (info: ConnectionInfo, database: string, collection: string, isView = false) => new CollectionNode(fresh(info), database, collection, isView);
const names = async (database: string) =>
  (await client.db(database).listCollections({}, { nameOnly: true }).toArray())
    .filter((c) => !c.name.startsWith('system.'))
    .map((c) => `${c.name}${c.type === 'view' ? ' (view)' : ''}`)
    .sort();
const databases = async () => (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).filter((d) => DATABASES.includes(d));
const ids = async (database: string, collection: string) => (await client.db(database).collection(collection).find().sort({ _id: 1 }).toArray()).map((d) => d._id);

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mongoster-clipboard-'));
});
afterAll(async () => {
  connections?.dispose();
  history?.dispose();
  for (const database of DATABASES) await client?.db(database).dropDatabase();
  await client?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  connections?.dispose();
  history?.dispose();
  Object.assign(ui, { answers: [], asked: [], messages: [], status: [], context: {}, commands: [], clipboard: '' });
  for (const database of DATABASES) await client.db(database).dropDatabase();
  const shop = client.db(SHOP);
  await shop.collection('orders').insertMany([1, 2, 3].map((n) => ({ _id: n as never, status: n === 2 ? 'paid' : 'open' })));
  await shop.collection('orders').createIndex({ status: 1 }, { name: 'byStatus' });
  await shop.collection('people').insertOne({ _id: 'ada' as never, name: 'Ada' });
  await shop.createCollection('open', { viewOn: 'orders', pipeline: [{ $match: { status: 'open' } }] });
  await client.db(CRM).collection('people').insertOne({ _id: 'old' as never, name: 'Old' });

  const state: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const context = {
    globalStorageUri: { fsPath: await fs.mkdtemp(path.join(dir, 'storage-')) },
    globalState: {
      keys: () => Object.keys(state),
      get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) delete state[key];
        else state[key] = value;
      },
    },
    secrets: {
      get: async (key: string) => secrets[key],
      store: async (key: string, value: string) => void (secrets[key] = value),
      delete: async (key: string) => void delete secrets[key],
    },
  } as unknown as ExtensionContext;
  connections = new ConnectionManager(context);
  history = UndoHistory.init(context, connections);
  a = await connections.add('A', inject('mongoUri'));
  b = await connections.add('B', inject('mongoUri'), 'Work');
  readOnly = (await connections.update((await connections.add('Locked', inject('mongoUri'))).id, { readOnly: true }))!;
  events = {
    opened: vi.fn<PasteEvents['opened']>(),
    changed: vi.fn<PasteEvents['changed']>(),
    moved: vi.fn<PasteEvents['moved']>(async () => undefined),
    databaseGone: vi.fn<PasteEvents['databaseGone']>(async () => undefined),
  };
  clipboard = new TreeClipboard(connections, events);
});

describe('Copy', () => {
  it('takes the selected collections, says so, and puts their names on the clipboard of the system', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders'), collectionNode(a, SHOP, 'open', true)]);
    expect(ui.clipboard).toBe('orders\nopen');
    expect(ui.context['mongoster.clipboard']).toBe('collection');
    expect(ui.status).toEqual(['Mongoster: 2 collections copied: paste on a database or a connection']);
  });

  it('refuses nodes that do not go together, and keeps what was copied before', async () => {
    await clipboard.copy([connectionNode(a)]);
    await clipboard.copy([connectionNode(a), databaseNode(a, SHOP)]);
    await clipboard.copy([new FolderNode('Work')]);
    expect(ui.messages).toEqual([
      'Copy only connections, only databases or only collections at a time.',
      'Only connections, databases, collections, views and buckets can be copied.',
    ]);
    expect(ui.context['mongoster.clipboard']).toBe('connection');
    await clipboard.paste(new FolderNode('Work'));
    expect(connections.list().map((c) => `${c.folder ?? ''}/${c.name}`)).toContain('Work/A copy');
  });

  it('says there is nothing to paste before the first one', async () => {
    await clipboard.paste(databaseNode(a, CRM));
    expect(ui.messages).toEqual(['Nothing to paste: copy a connection, a database or collections in the connections view first.']);
  });
});

describe('Paste of connections', () => {
  it('makes a second connection in the folder pasted on, of the connection pasted on, or of the copied one', async () => {
    await clipboard.copy([connectionNode(a)]);
    await clipboard.paste(new FolderNode('Work'));
    await clipboard.paste(connectionNode(b));
    await clipboard.paste(undefined);
    expect(connections.list().map((c) => `${c.folder ?? ''}/${c.name}`)).toEqual(['/A', 'Work/B', '/Locked', 'Work/A copy', 'Work/A copy 2', '/A copy 3']);
    expect(ui.status.slice(1)).toEqual(['Mongoster: pasted the connection A copy', 'Mongoster: pasted the connection A copy 2', 'Mongoster: pasted the connection A copy 3']);
    const copy = connections.list().find((c) => c.name === 'A copy')!;
    expect(await connections.uri(copy.id)).toBe(inject('mongoUri'));
    // A copy can be pasted again: Copy is not used up.
    expect(ui.context['mongoster.clipboard']).toBe('connection');
  });

  it('moves a cut connection to the folder, once', async () => {
    await clipboard.copy([connectionNode(a), connectionNode(readOnly)], true);
    expect(ui.status).toEqual(['Mongoster: 2 connections cut: paste on a folder or a connection']);
    await clipboard.paste(new FolderNode('Work'));
    expect(connections.list().map((c) => `${c.folder ?? ''}/${c.name}`)).toEqual(['Work/A', 'Work/B', 'Work/Locked']);
    expect(ui.status[1]).toBe('Mongoster: 2 connections moved to Work');
    expect(ui.context['mongoster.clipboard']).toBeUndefined();
    await clipboard.paste(new FolderNode('Other'));
    expect(ui.messages).toEqual(['Nothing to paste: copy a connection, a database or collections in the connections view first.']);
  });
});

describe('Paste of collections', () => {
  it('copies them on the database after a confirmation that says what is pasted, and tells the open tabs', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders'), collectionNode(a, SHOP, 'open', true)]);
    answer('Paste');
    await clipboard.paste(databaseNode(b, STORE));
    expect(asked(0)).toMatchObject({ kind: 'confirm', message: `Paste 2 collections of ${SHOP} from A into B › ${STORE}?`, buttons: ['Paste'] });
    expect(asked(0).detail!.split('\n')).toEqual([
      'orders, open.',
      '1 collection with 3 documents, the indexes and the collection options.',
      '1 view, created with its definition.',
      'It can be undone from the Undo History.',
    ]);
    expect(await names(STORE)).toEqual(['open (view)', 'orders']);
    expect((await client.db(STORE).collection('orders').listIndexes().toArray()).map((i) => i.name)).toEqual(['_id_', 'byStatus']);
    expect(ui.messages[0]).toMatch(new RegExp(`^Pasted 1 collection \\(3 documents\\) and 1 view into B › ${STORE} in [\\d.]+ s\\. \\| Undo$`));
    expect(events.changed.mock.calls.map(([ref]) => ref)).toEqual([
      { connectionId: b.id, database: STORE, collection: 'orders' },
      { connectionId: b.id, database: STORE, collection: 'open' },
    ]);
    expect(events.moved).not.toHaveBeenCalled();
    expect(ui.commands).toContain('mongoster.refresh');
    // The source is as it was.
    expect(await names(SHOP)).toEqual(['open (view)', 'orders', 'people']);
  });

  it('writes nothing when the confirmation is dismissed', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders')]);
    answer(undefined);
    await clipboard.paste(databaseNode(a, STORE));
    expect(await names(STORE)).toEqual([]);
    expect(ui.messages).toEqual([]);
    expect(events.changed).not.toHaveBeenCalled();
  });

  it('names the copy _copy in its own database, pasted on a collection of it, and offers to open it', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders')]);
    answer((q) => {
      expect(q.message).toBe(`Paste ${SHOP}.orders from A into A › ${SHOP}?`);
      expect(q.detail).toContain('orders → orders_copy.');
      return 'Paste';
    });
    await clipboard.paste(collectionNode(a, SHOP, 'people'));
    expect(await ids(SHOP, 'orders_copy')).toEqual([1, 2, 3]);
    expect(ui.messages[0]).toMatch(/ \| Open \| Undo$/);
  });

  it('asks once what to do with those that exist, and says what the choice does', async () => {
    await client.db(CRM).collection('orders').insertOne({ _id: 2 as never, status: 'old' });
    await clipboard.copy([collectionNode(a, SHOP, 'orders'), collectionNode(a, SHOP, 'people')]);
    answer('Append', 'Paste');
    await clipboard.paste(databaseNode(a, CRM));
    expect(asked(0)).toMatchObject({
      kind: 'pick',
      title: `2 of the 2 collections exist in A › ${CRM}`,
      placeHolder: 'orders, people',
      items: ['Skip', 'Append', 'Replace matching', 'Drop and recreate'],
    });
    expect(asked(1).detail).toContain('Existing collections get the documents whose _id they lack.');
    expect(await ids(CRM, 'orders')).toEqual([1, 2, 3]);
    expect(await ids(CRM, 'people')).toEqual(['ada', 'old']);
    expect(ui.messages[0]).toContain('1 document skipped (their _id already existed)');
  });

  it('says so when Skip leaves nothing to paste, without asking more', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'people')]);
    answer('Skip');
    await clipboard.paste(databaseNode(a, CRM));
    expect(ui.messages).toEqual([`Nothing to paste: everything exists in A › ${CRM}.`]);
    expect(await ids(CRM, 'people')).toEqual(['old']);
  });

  it('warns that a dropped collection cannot be undone, and records nothing for it', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'people')]);
    answer('Drop and recreate', (q) => {
      expect(q.detail).toContain("Dropped first: people. That can't be undone.");
      expect(q.detail).not.toContain('Undo History');
      return 'Paste';
    });
    await clipboard.paste(databaseNode(a, CRM));
    expect(await ids(CRM, 'people')).toEqual(['ada']);
    expect(await history.list()).toEqual([]);
    expect(ui.messages[0]).toMatch(/ \| Open$/);
  });

  it('asks for the database when pasted on a connection, also a new one', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'people')]);
    answer(
      (q) => {
        expect(q.title).toBe('Paste on B: database');
        // The database they come from is first; the server's own are not offered.
        expect(q.items![0]).toBe(SHOP);
        expect(q.items).not.toContain('admin');
        return '$(add) New database…';
      },
      (q) => {
        expect(q.validate!(CRM)).toBe('This database already exists');
        expect(q.validate!('a b')).toMatch(/cannot contain spaces/);
        return STORE;
      },
      'Paste',
    );
    await clipboard.paste(connectionNode(b));
    expect(await ids(STORE, 'people')).toEqual(['ada']);
  });

  it('refuses a read-only connection, and a folder or nothing to paste on', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'people')]);
    await clipboard.paste(databaseNode(readOnly, CRM));
    await clipboard.paste(new FolderNode('Work'));
    await clipboard.paste(undefined);
    expect(ui.messages).toEqual([
      'The connection Locked is read-only: nothing can be pasted on it.',
      'Select the connection or the database to paste on.',
      'Select the connection or the database to paste on.',
    ]);
  });

  it('says the connection of what was copied is gone', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'people')]);
    await connections.remove(a.id);
    await clipboard.paste(databaseNode(b, CRM));
    expect(ui.messages).toEqual(['The connection of what was copied has been removed.']);
  });

  it('copies a bucket as a bucket, whose files can be read', async () => {
    const upload = new GridFSBucket(client.db(SHOP), { bucketName: 'photos' }).openUploadStream('a.txt');
    await new Promise((resolve, reject) => upload.on('finish', resolve).on('error', reject).end(Buffer.from('hello')));
    await clipboard.copy([new BucketNode(fresh(a), SHOP, 'photos')]);
    expect(ui.clipboard).toBe('photos.files\nphotos.chunks');
    answer((q) => {
      expect(q.detail).toContain('photos.files → photos_copy.files, photos.chunks → photos_copy.chunks.');
      return 'Paste';
    });
    await clipboard.paste(databaseNode(a, SHOP));
    const chunks: Buffer[] = [];
    for await (const chunk of new GridFSBucket(client.db(SHOP), { bucketName: 'photos_copy' }).openDownloadStreamByName('a.txt')) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});

describe('the undo of a paste', () => {
  it('takes the pasted documents out of a collection that had its own, and keeps those', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'people')]);
    answer('Append', 'Paste');
    await clipboard.paste(databaseNode(a, CRM));
    expect(await ids(CRM, 'people')).toEqual(['ada', 'old']);
    const entries = await history.list();
    expect(entries).toMatchObject([{ label: `Paste A › ${SHOP}.people`, connectionId: a.id, database: CRM, collection: 'people', inserted: 1 }]);

    answer((q) => {
      expect(q.message).toBe(`Undo "Paste A › ${SHOP}.people" in A › ${CRM}.people?`);
      return 'Undo';
    });
    expect(await history.undo(entries[0].id)).toMatchObject({ ok: true });
    expect(await ids(CRM, 'people')).toEqual(['old']);
  });

  it('puts back the documents Replace matching replaced', async () => {
    await client.db(CRM).collection('orders').insertOne({ _id: 2 as never, status: 'old' });
    await clipboard.copy([collectionNode(a, SHOP, 'orders')]);
    answer('Replace matching', 'Paste');
    await clipboard.paste(databaseNode(a, CRM));
    expect((await client.db(CRM).collection('orders').findOne({ _id: 2 as never }))!.status).toBe('paid');
    const [entry] = await history.list();
    answer('Undo');
    expect(await history.undo(entry.id)).toMatchObject({ ok: true });
    expect(await client.db(CRM).collection('orders').find().toArray()).toEqual([{ _id: 2, status: 'old' }]);
  });

  it('is one operation per collection, and none for a view', async () => {
    await clipboard.copy([databaseNode(a, SHOP)]);
    answer(STORE, 'Paste');
    await clipboard.paste(connectionNode(a));
    expect((await history.list()).map((e) => `${e.collection}:${e.inserted}`).sort()).toEqual(['orders:3', 'people:1']);
    expect(ui.messages[0]).toContain('Each collection can be undone from the Undo History');
    expect(ui.messages[0]).not.toContain(' | ');
  });
});

describe('Paste of a database', () => {
  it('proposes a free name on its own connection, refuses its own, and copies collections and views', async () => {
    await clipboard.copy([databaseNode(a, SHOP)]);
    expect(ui.status).toEqual(['Mongoster: 1 database copied: paste on a connection']);
    answer(
      (q) => {
        expect(q).toMatchObject({ kind: 'input', title: `Paste the database ${SHOP} on A`, value: `${SHOP}_copy` });
        expect(q.validate!(SHOP)).toBe('That is the database being copied');
        expect(q.validate!(CRM)).toBeUndefined();
        return q.value;
      },
      (q) => {
        expect(q.message).toBe(`Paste the database ${SHOP} from A into A › ${SHOP}_copy?`);
        return 'Paste';
      },
    );
    await clipboard.paste(databaseNode(a, CRM));
    expect(await names(`${SHOP}_copy`)).toEqual(['open (view)', 'orders', 'people']);
    expect(await client.db(`${SHOP}_copy`).collection('open').countDocuments()).toBe(2);
    expect(await names(SHOP)).toEqual(['open (view)', 'orders', 'people']);
  });

  it('stops at the first database whose name is not given', async () => {
    await clipboard.copy([databaseNode(a, SHOP), databaseNode(a, CRM)]);
    answer(undefined);
    await clipboard.paste(connectionNode(b));
    expect(ui.asked).toHaveLength(1);
    expect(await databases()).toEqual(expect.not.arrayContaining([STORE, `${SHOP}_copy`]));
  });
});

describe('Cut and Paste', () => {
  it('refuses to cut from a read-only connection, keeping the clipboard', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'people')]);
    await clipboard.copy([collectionNode(readOnly, SHOP, 'orders')], true);
    expect(ui.messages).toEqual(['The connection Locked is read-only: nothing can be moved from it.']);
    answer('Paste');
    await clipboard.paste(databaseNode(a, STORE));
    expect(await names(STORE)).toEqual(['people']);
  });

  it('moves collections and views to another database, says it cannot be undone, and tells what moved', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders'), collectionNode(a, SHOP, 'open', true)], true);
    expect(ui.status).toEqual(['Mongoster: 2 collections cut: paste on a database or a connection']);
    answer('Move');
    await clipboard.paste(databaseNode(a, STORE));
    expect(asked(0)).toMatchObject({ message: `Move 2 collections of ${SHOP} from A into A › ${STORE}?`, buttons: ['Move'] });
    expect(asked(0).detail!.split('\n').slice(-2)).toEqual([
      'The server moves each collection whole; one it cannot move is copied, then dropped.',
      "Open tabs of what is moved are closed. A move can't be undone from the Undo History.",
    ]);
    expect(await names(SHOP)).toEqual(['people']);
    expect(await names(STORE)).toEqual(['open (view)', 'orders']);
    expect((await client.db(STORE).collection('orders').listIndexes().toArray()).map((i) => i.name)).toEqual(['_id_', 'byStatus']);
    expect(events.moved.mock.calls).toEqual([
      [
        { connectionId: a.id, database: SHOP, collection: 'orders' },
        { connectionId: a.id, database: STORE, collection: 'orders' },
      ],
      [
        { connectionId: a.id, database: SHOP, collection: 'open' },
        { connectionId: a.id, database: STORE, collection: 'open' },
      ],
    ]);
    expect(ui.messages[0]).toMatch(new RegExp(`^Moved 1 collection \\(3 documents\\) and 1 view into A › ${STORE} in [\\d.]+ s\\.$`));
    expect(await history.list()).toEqual([]);
    // What was cut is pasted once.
    expect(ui.context['mongoster.clipboard']).toBeUndefined();
    await clipboard.paste(databaseNode(a, CRM));
    expect(ui.messages[1]).toMatch(/^Nothing to paste/);
  });

  it('copies and drops when the destination is another connection', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders')], true);
    answer((q) => {
      expect(q.detail).toContain(`Each one is copied, then dropped from A › ${SHOP}.`);
      return 'Move';
    });
    await clipboard.paste(databaseNode(b, STORE));
    expect(await ids(STORE, 'orders')).toEqual([1, 2, 3]);
    expect(await names(SHOP)).toEqual(['open (view)', 'people']);
    expect(events.moved.mock.calls[0]).toEqual([
      { connectionId: a.id, database: SHOP, collection: 'orders' },
      { connectionId: b.id, database: STORE, collection: 'orders' },
    ]);
  });

  it('keeps the clipboard when the move is given up, and leaves what is already there', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders')], true);
    answer(undefined);
    await clipboard.paste(databaseNode(a, STORE));
    expect(ui.context['mongoster.clipboard']).toBe('collection');
    await clipboard.paste(collectionNode(a, SHOP, 'people'));
    expect(ui.messages).toEqual([`orders is already in A › ${SHOP}.`]);
    expect(await names(SHOP)).toEqual(['open (view)', 'orders', 'people']);
  });

  it('refuses to move to or from a read-only connection', async () => {
    await clipboard.copy([collectionNode(a, SHOP, 'orders')], true);
    await clipboard.paste(databaseNode(readOnly, STORE));
    // Made read-only after the cut.
    await connections.update(a.id, { readOnly: true });
    await clipboard.paste(databaseNode(b, STORE));
    expect(ui.messages).toEqual(['The connection Locked is read-only: nothing can be moved to it.', 'The connection A is read-only: nothing can be moved from it.']);
    expect(await names(SHOP)).toEqual(['open (view)', 'orders', 'people']);
  });

  it('moves a database to another connection and drops it where it was', async () => {
    await clipboard.copy([databaseNode(a, SHOP)], true);
    answer(
      (q) => {
        expect(q.title).toBe(`Move the database ${SHOP} to B`);
        return STORE;
      },
      'Move',
    );
    await clipboard.paste(connectionNode(b));
    expect(await names(STORE)).toEqual(['open (view)', 'orders', 'people']);
    expect(await databases()).not.toContain(SHOP);
    expect(events.databaseGone.mock.calls).toEqual([[a.id, SHOP]]);
  });

  it('keeps the database when something of it stayed', async () => {
    await client.db(STORE).collection('people').insertOne({ _id: 'kept' as never });
    await clipboard.copy([databaseNode(a, SHOP)], true);
    answer(STORE, 'Skip', 'Move');
    await clipboard.paste(connectionNode(a));
    expect(await names(SHOP)).toEqual(['people']);
    expect(await names(STORE)).toEqual(['open (view)', 'orders', 'people']);
    expect(events.databaseGone).not.toHaveBeenCalled();
  });
});

describe('Rename Database', () => {
  it('asks for a free name, moves everything to it and drops the old database', async () => {
    answer(
      (q) => {
        expect(q).toMatchObject({ kind: 'input', title: `Rename the database ${SHOP}`, value: SHOP });
        expect(q.validate!(SHOP)).toBe('Enter another name');
        expect(q.validate!(CRM)).toBe('This database already exists');
        expect(q.validate!('')).toBe('Enter a name');
        return STORE;
      },
      (q) => {
        expect(q).toMatchObject({ message: `Rename the database ${SHOP} of A to ${STORE}?`, buttons: ['Rename'] });
        expect(q.detail).toContain(`MongoDB can't rename a database: its collections are moved to the new database ${STORE}, then ${SHOP} is dropped.`);
        return 'Rename';
      },
    );
    await clipboard.renameDatabase(databaseNode(a, SHOP));
    expect(await databases()).toEqual(expect.not.arrayContaining([SHOP]));
    expect(await names(STORE)).toEqual(['open (view)', 'orders', 'people']);
    expect(await client.db(STORE).collection('open').countDocuments()).toBe(2);
    expect(events.moved).toHaveBeenCalledTimes(3);
    expect(events.databaseGone.mock.calls).toEqual([[a.id, SHOP]]);
    expect(ui.messages[0]).toMatch(new RegExp(`^Renamed the database ${SHOP} to ${STORE}: moved 2 collections \\(4 documents\\) and 1 view in [\\d.]+ s\\.$`));
  });

  it('changes nothing when the name or the confirmation is not given', async () => {
    answer(undefined);
    await clipboard.renameDatabase(databaseNode(a, SHOP));
    answer(STORE, undefined);
    await clipboard.renameDatabase(databaseNode(a, SHOP));
    expect(await names(SHOP)).toEqual(['open (view)', 'orders', 'people']);
    expect(await databases()).not.toContain(STORE);
    expect(events.databaseGone).not.toHaveBeenCalled();
  });

  it("refuses a read-only connection and the server's own databases, before asking", async () => {
    await clipboard.renameDatabase(databaseNode(readOnly, SHOP));
    await clipboard.renameDatabase(databaseNode(a, 'admin'));
    expect(ui.messages).toEqual([
      `The connection Locked is read-only: the database ${SHOP} can't be renamed.`,
      "The database admin is the server's own: it can't be renamed.",
    ]);
    expect(ui.asked).toEqual([]);
  });
});

describe('dragging', () => {
  const folders = () => connections.list().map((c) => `${c.folder ?? ''}/${c.name}`);

  it('moves connections to the folder dropped on, to that of a connection, and out of their folder', async () => {
    await clipboard.drop([connectionNode(a)], new FolderNode('Work'));
    expect(folders()).toEqual(['Work/A', 'Work/B', '/Locked']);
    await clipboard.drop([connectionNode(readOnly)], connectionNode(b));
    expect(folders()).toEqual(['Work/A', 'Work/B', 'Work/Locked']);
    await clipboard.drop([connectionNode(a), connectionNode(b)], undefined);
    expect(folders()).toEqual(['/A', '/B', 'Work/Locked']);
    expect(ui.status).toEqual(['Mongoster: 1 connection moved to Work', 'Mongoster: 1 connection moved to Work', 'Mongoster: 2 connections moved out of its folder']);
  });

  it('says nothing when the connection is already there', async () => {
    await clipboard.drop([connectionNode(b)], new FolderNode('Work'));
    expect(ui.status).toEqual([]);
    expect(folders()).toEqual(['/A', 'Work/B', '/Locked']);
  });

  it('copies collections onto a database after the confirmation of Paste, without touching the clipboard', async () => {
    await clipboard.copy([connectionNode(a)]);
    answer((q) => {
      expect(q.message).toBe(`Paste ${SHOP}.orders from A into B › ${STORE}?`);
      return 'Paste';
    });
    await clipboard.drop([collectionNode(a, SHOP, 'orders')], databaseNode(b, STORE));
    expect(await ids(STORE, 'orders')).toEqual([1, 2, 3]);
    expect(await names(SHOP)).toEqual(['open (view)', 'orders', 'people']);
    expect(ui.context['mongoster.clipboard']).toBe('connection');
  });

  it('refuses nodes that do not go together, and a read-only connection', async () => {
    await clipboard.drop([collectionNode(a, SHOP, 'orders'), databaseNode(a, CRM)] as TreeNode[], databaseNode(a, STORE));
    await clipboard.drop([new FolderNode('Work')], databaseNode(a, STORE));
    await clipboard.drop([collectionNode(a, SHOP, 'orders')], databaseNode(readOnly, STORE));
    expect(ui.messages).toEqual([
      'Drag only connections, only databases or only collections at a time.',
      'Only connections, databases, collections, views and buckets can be dragged.',
      'The connection Locked is read-only: nothing can be pasted on it.',
    ]);
  });
});
