// Scheduled tasks run without asking anything: a backup and an export written into the task's folder,
// then retention, which deletes the oldest outputs of the task and nothing else.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BSON, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { scanArchive, scanBackup } from '../../src/backup';
import { Scheduler } from '../../src/scheduler';
import { applyRetention, runTask } from '../../src/taskRunner';
import { DEFAULT_PATTERN, type ScheduledTask, type TaskOutput } from '../../src/shared/schedule';

const DB = 'mongoster_scheduled';
let client: MongoClient;
let dir: string;

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoster-tasks-'));
  await client.db(DB).dropDatabase();
  await client.db(DB).collection<{ _id: number }>('orders').insertMany(
    Array.from({ length: 2500 }, (_, i) => ({ _id: i, status: i % 5 === 0 ? 'open' : 'closed', total: new BSON.Decimal128(`${i}.50`), customer: { name: `c${i}` } })),
  );
  await client.db(DB).collection<{ _id: string; name: string }>('customers').insertOne({ _id: 'only', name: 'A' });
});

afterAll(async () => {
  await client?.db(DB).dropDatabase();
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const task = (changes: Partial<ScheduledTask>): ScheduledTask => ({
  id: 't',
  name: 'Task',
  kind: 'backup',
  enabled: true,
  connectionId: 'c',
  database: DB,
  format: 'archive',
  folder: dir,
  pattern: DEFAULT_PATTERN,
  schedule: { kind: 'daily', time: '02:00' },
  keep: 2,
  runMissed: false,
  notifySuccess: false,
  since: 0,
  ...changes,
});

const hooks = { cancelled: () => false };

/** Runs the task at each date, then retention, as the scheduler does. */
async function runs(t: ScheduledTask, dates: Date[]): Promise<{ outputs: TaskOutput[]; deleted: number }> {
  let outputs: TaskOutput[] = [];
  let deleted = 0;
  for (const date of dates) {
    const result = await runTask(t, client, 'Local', hooks, date);
    expect(result.cancelled).toBe(false);
    const retention = await applyRetention([...outputs, result.output!], t.keep);
    expect(retention.errors).toEqual([]);
    outputs = retention.outputs;
    deleted += retention.deleted;
  }
  return { outputs, deleted };
}

const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(2026, 10, 1 + i, 2, 0, 0));

describe('scheduled tasks', () => {
  it('backs up a database to archives, keeping the last two', async () => {
    const backups = path.join(dir, 'archives');
    fs.mkdirSync(backups);
    // Not written by the task: retention leaves it alone.
    fs.writeFileSync(path.join(backups, 'mongoster_scheduled_2020-01-01_02-00-00.agz'), 'mine');
    const { outputs, deleted } = await runs(task({ folder: backups }), days(3));
    expect(deleted).toBe(1);
    expect(fs.readdirSync(backups).sort()).toEqual([
      'mongoster_scheduled_2020-01-01_02-00-00.agz',
      'mongoster_scheduled_2026-11-02_02-00-00.agz',
      'mongoster_scheduled_2026-11-03_02-00-00.agz',
    ]);
    expect(outputs.map((o) => path.basename(o.path))).toEqual(['mongoster_scheduled_2026-11-02_02-00-00.agz', 'mongoster_scheduled_2026-11-03_02-00-00.agz']);
    expect(outputs[1].size).toBe(fs.statSync(outputs[1].path).size);
    const [db] = await scanArchive(outputs[1].path);
    expect(db.collections.map((c) => c.name)).toEqual(['customers', 'orders']);
  });

  it('backs up a collection to folders, deleting whole folders it wrote', async () => {
    const backups = path.join(dir, 'folders');
    fs.mkdirSync(backups);
    const t = task({ folder: backups, collection: 'orders', format: 'gzip', keep: 1, pattern: '{database}-{collection}-{YYYY}{MM}{DD}' });
    const result = await runTask(t, client, 'Local', hooks, days(1)[0]);
    expect(result).toMatchObject({ cancelled: false, documents: 2500, collections: 1 });
    expect(result.output).toMatchObject({ dir: true, path: path.join(backups, 'mongoster_scheduled-orders-20261101') });
    expect(scanBackup(result.output!.path)[0].collections.map((c) => path.basename(c.bson!))).toEqual(['orders.bson.gz']);
    // The same name again: a number is added, nothing is overwritten.
    const again = await runTask(t, client, 'Local', hooks, days(1)[0]);
    expect(path.basename(again.output!.path)).toBe('mongoster_scheduled-orders-20261101_2');
    const retention = await applyRetention([result.output!, again.output!], 1);
    expect(retention.deleted).toBe(1);
    expect(fs.readdirSync(backups)).toEqual(['mongoster_scheduled-orders-20261101_2']);
  });

  it('exports a collection with a filter and a projection, keeping the last two', async () => {
    const exports = path.join(dir, 'exports');
    fs.mkdirSync(exports);
    const t = task({ kind: 'export', folder: exports, collection: 'orders', format: 'jsonl', filter: '{ status: "open" }', projection: '{ total: 1 }' });
    const { outputs } = await runs(t, days(4));
    expect(fs.readdirSync(exports).sort()).toEqual(['orders_2026-11-03_02-00-00.jsonl', 'orders_2026-11-04_02-00-00.jsonl']);
    const lines = fs.readFileSync(outputs[1].path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(500);
    expect(BSON.EJSON.parse(lines[1], { relaxed: false })).toEqual({ _id: new BSON.Int32(5), total: new BSON.Decimal128('5.50') });
  });

  it('exports CSV with the columns given, and fails without leaving a file', async () => {
    const exports = path.join(dir, 'csv');
    fs.mkdirSync(exports);
    const t = task({ kind: 'export', folder: exports, collection: 'orders', format: 'csv', filter: '{ _id: { $lt: 2 } }' });
    const result = await runTask(t, client, 'Local', { ...hooks, columns: { expanded: ['customer'] } }, days(1)[0]);
    expect(fs.readFileSync(result.output!.path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0]).toBe('_id,status,total,customer.name');
    await expect(runTask({ ...t, filter: '{ $bad: 1 }' }, client, 'Local', hooks, days(2)[0])).rejects.toThrow();
    expect(fs.readdirSync(exports)).toHaveLength(1);
    await expect(runTask({ ...t, folder: path.join(dir, 'missing') }, client, 'Local', hooks)).rejects.toThrow(/doesn't exist/);
  });

  it('deletes what it wrote so far when cancelled', async () => {
    const backups = path.join(dir, 'cancelled');
    fs.mkdirSync(backups);
    let calls = 0;
    const result = await runTask(task({ folder: backups, format: 'plain' }), client, 'Local', { cancelled: () => ++calls > 1 });
    expect(result.cancelled).toBe(true);
    expect(fs.readdirSync(backups)).toEqual([]);
  });
});

describe('two windows', () => {
  it('runs a due task once, records it for both, and refuses a second run at the same time', async () => {
    const storage = path.join(dir, 'storage');
    const out = path.join(dir, 'windows');
    fs.mkdirSync(out);
    // What the scheduler uses of VS Code: the global storage folder, and the connections.
    const context = { globalStorageUri: { fsPath: storage } } as never;
    const connections = { get: (id: string) => (id === 'c' ? { id, name: 'Local' } : undefined), getClient: async () => client } as never;
    const windows = [new Scheduler(context, connections, () => undefined), new Scheduler(context, connections, () => undefined)];
    const folder = path.join(storage, 'scheduledTasks');
    const state = () => JSON.parse(fs.readFileSync(path.join(folder, 'hourly.json'), 'utf8'));
    try {
      // Every hour, at the minute before now: due, less than the grace period late.
      const minute = new Date(Date.now() - 60_000);
      const time = `${String(minute.getHours()).padStart(2, '0')}:${String(minute.getMinutes()).padStart(2, '0')}`;
      windows[0].save(task({ id: 'hourly', folder: out, collection: 'customers', schedule: { kind: 'hours', every: 1, time } }));
      // Created two hours ago.
      const tasks = JSON.parse(fs.readFileSync(path.join(folder, 'tasks.json'), 'utf8')) as ScheduledTask[];
      fs.writeFileSync(path.join(folder, 'tasks.json'), JSON.stringify(tasks.map((t) => ({ ...t, since: Date.now() - 2 * 3_600_000 }))));
      await Promise.all(windows.map((w) => w.tick()));
      for (let i = 0; i < 100 && !(fs.existsSync(path.join(folder, 'hourly.json')) && state().runs.length); i++) await new Promise((r) => setTimeout(r, 50));
      // Both windows see it done, and neither runs it again.
      await Promise.all(windows.map((w) => w.tick()));
      await new Promise((r) => setTimeout(r, 300));
      expect(fs.readdirSync(out)).toHaveLength(1);
      expect(state().runs).toHaveLength(1);
      expect(state().runs[0]).toMatchObject({ status: 'ok', trigger: 'schedule', documents: 1, collections: 1 });
      expect(state().running).toBeUndefined();
      expect(fs.existsSync(path.join(folder, 'hourly.lock'))).toBe(false);
      windows[1].load();
      expect(windows[1].list()[0]).toMatchObject({ task: { id: 'hourly' }, running: undefined });
      expect(windows[1].list()[0].next).toBeGreaterThan(Date.now());
      // Run Now in one window while it runs in the other: refused.
      const first = windows[0].runNow('hourly');
      expect(await windows[1].runNow('hourly')).toBe('busy');
      expect(await first).toBe('done');
      expect(state().runs.map((r: { trigger: string }) => r.trigger)).toEqual(['manual', 'schedule']);
    } finally {
      windows.forEach((w) => w.dispose());
    }
  });
});
