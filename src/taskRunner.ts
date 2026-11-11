// Runs a scheduled task without asking anything: a backup (archive or folder, of a connection, a
// database or a collection) or an export (JSON, JSON Lines or CSV of a collection, with a filter),
// written as a new file or folder in the task's folder. Then retention deletes the oldest outputs
// of the task beyond the number kept; only outputs it recorded, i.e. that the task wrote itself.
import * as fs from 'fs';
import * as path from 'path';
import type { MongoClient } from 'mongodb';
import { planBackup, uniquePath, writeBackup } from './backup';
import { exportSource, FileWriter, writeExport, type ExportFormat } from './transfer';
import type { ColumnLayout } from './shared/columns';
import { outputExtension, outputName, outputsToDelete, type BackupFormat, type ScheduledTask, type TaskOutput } from './shared/schedule';

export interface TaskRunHooks {
  cancelled(): boolean;
  /** What is being done, for a progress message. */
  progress?(message: string): void;
  /** The CSV columns: the layout of the collection's tab. */
  columns?: { expanded: string[]; layout?: ColumnLayout };
}

export interface TaskRunResult {
  cancelled: boolean;
  output?: TaskOutput;
  documents: number;
  collections?: number;
  note?: string;
}

/** Bytes of a file, or of all the files in a folder. */
export async function pathSize(target: string): Promise<number> {
  const stat = await fs.promises.stat(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.promises.readdir(target)) total += await pathSize(path.join(target, entry));
  return total;
}

/** Runs the task once at `now`: writes its output, or throws. Nothing is left behind when it fails or is cancelled. */
export async function runTask(task: ScheduledTask, client: MongoClient, connectionName: string, hooks: TaskRunHooks, now = new Date()): Promise<TaskRunResult> {
  const stat = await fs.promises.stat(task.folder).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`The folder ${task.folder} doesn't exist (is the drive connected?)`);
  const extension = outputExtension(task.format);
  const target = uniquePath(path.join(task.folder, outputName(task, now, connectionName)), extension);

  if (task.kind === 'backup') {
    const { plan, skipped } = await planBackup(client, task.database, task.collection);
    if (!plan.some((p) => p.collections.length)) {
      throw new Error(skipped.length ? "Nothing to back up: time series collections aren't supported (use mongodump)." : 'Nothing to back up: there are no collections.');
    }
    const stats = await writeBackup(client, plan, task.format as BackupFormat, target, (database, c) => ({
      progress: (n) => hooks.progress?.(`${database}.${c.name}: ${n.toLocaleString('en-US')} documents`),
      cancelled: () => hooks.cancelled(),
    }));
    if (stats.cancelled) return { cancelled: true, documents: stats.documents, collections: stats.collections };
    return {
      cancelled: false,
      output: { path: target, at: now.getTime(), size: await pathSize(target), dir: task.format !== 'archive' },
      documents: stats.documents,
      collections: stats.collections,
      note: skipped.length ? `Time series collections left out (use mongodump): ${skipped.join(', ')}` : undefined,
    };
  }

  if (!task.database || !task.collection) throw new Error('An export needs a database and a collection.');
  const coll = client.db(task.database).collection(task.collection);
  const open = exportSource(coll, { kind: 'find', filter: task.filter ?? '', sort: '', projection: task.projection ?? '' });
  const written = await writeExport(await open(), task.format as ExportFormat, new FileWriter(target), hooks.columns ?? { expanded: [] }, {
    progress: (n) => hooks.progress?.(`${n.toLocaleString('en-US')} documents`),
    cancelled: () => hooks.cancelled(),
  });
  if (written === undefined) return { cancelled: true, documents: 0 };
  return { cancelled: false, output: { path: target, at: now.getTime(), size: await pathSize(target), dir: false }, documents: written };
}

/**
 * Deletes the outputs beyond the newest `keep` (0 keeps them all). Returns the outputs still there:
 * those deleted or already gone are dropped, those that couldn't be deleted stay, to try again next time.
 */
export async function applyRetention(outputs: TaskOutput[], keep: number): Promise<{ outputs: TaskOutput[]; deleted: number; errors: string[] }> {
  const remove = new Set(outputsToDelete(outputs, keep));
  const errors: string[] = [];
  let deleted = 0;
  const kept: TaskOutput[] = [];
  for (const output of outputs) {
    if (!remove.has(output)) {
      kept.push(output);
      continue;
    }
    const stat = await fs.promises.stat(output.path).catch(() => undefined);
    if (!stat) continue;
    // Something else is there now: it isn't the task's to delete.
    if (stat.isDirectory() !== output.dir) continue;
    try {
      await fs.promises.rm(output.path, { recursive: output.dir, force: true });
      deleted++;
    } catch (err) {
      errors.push(`${output.path}: ${err instanceof Error ? err.message : String(err)}`);
      kept.push(output);
    }
  }
  return { outputs: kept, deleted, errors };
}
