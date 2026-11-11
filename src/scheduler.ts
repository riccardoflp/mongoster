// Scheduled tasks: runs them when they are due, in whichever VS Code window (extension host) gets
// there first, but only once. Everything shared lives in files in the extension's global storage
// folder, which all the windows (and the desktop app, in its own folder) read again each time:
//   scheduledTasks/tasks.json     the tasks
//   scheduledTasks/<id>.json      the state of a task: the last scheduled time handled, the run log, its outputs
//   scheduledTasks/<id>.lock      held while a run (or the recording of a missed run) is in progress
//   scheduledTasks/<id>.cancel    asks the window running the task to cancel it
// A window takes the task's lock (fileLock.ts), reads its state again and runs it only if it's still
// due: the window that runs it records the scheduled time, so the others skip it.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionManager } from './connections';
import { FileLock, lockHeld } from './fileLock';
import { errorMessage } from './tree';
import { applyRetention, runTask, type TaskRunHooks } from './taskRunner';
import { formatSize } from './backup';
import { addRun, dueRun, emptyState, nextTaskRun, previousRun, type RunTrigger, type ScheduledTask, type TaskRun, type TaskState } from './shared/schedule';

const TICK_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
const CANCEL_CHECK_MS = 2_000;

/** A task with what the Scheduled Tasks tab shows about it. */
export interface TaskInfo {
  task: ScheduledTask;
  state: TaskState;
  next?: number;
  /** Running in this window, or in another one. */
  running?: 'here' | 'elsewhere';
  /** What the run in this window is doing. */
  progress?: string;
}

interface ActiveRun {
  cancelled: boolean;
  progress?: string;
}

export type RunOutcome = 'done' | 'busy' | 'gone';

const plural = (n: number, what: string) => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

/** Writes a file at once: a reader never sees half of it. */
function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (err) {
      // Windows: the file is being read by another window for a moment.
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        fs.rmSync(temp, { force: true });
        throw err;
      }
      // A short wait: rare, and the write must be done before going on.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export class Scheduler implements vscode.Disposable {
  /** The scheduler of this window, for the desktop app's tray. */
  static current: Scheduler | undefined;

  private readonly dir: string;
  private tasks: ScheduledTask[] = [];
  private states = new Map<string, TaskState>();
  private readonly active = new Map<string, ActiveRun>();
  private signature = '';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly ran = new vscode.EventEmitter<{ task: ScheduledTask; run: TaskRun }>();
  /** After each run (not after a missed run that is only recorded). */
  readonly onDidRun = this.ran.event;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly first: ReturnType<typeof setTimeout>;
  private watcher?: fs.FSWatcher;
  private reload?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    /** The CSV columns of a collection: the layout of its tab. */
    private readonly columns: (task: ScheduledTask) => TaskRunHooks['columns'],
  ) {
    this.dir = path.join(context.globalStorageUri.fsPath, 'scheduledTasks');
    fs.mkdirSync(this.dir, { recursive: true });
    this.load();
    // Changes made by the other windows show up at once where the file system says so, at the next tick otherwise.
    try {
      this.watcher = fs.watch(this.dir, () => {
        clearTimeout(this.reload);
        this.reload = setTimeout(() => this.load(), 300);
      });
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      // The ticks are enough.
    }
    this.first = setTimeout(() => void this.tick(), 3_000);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    Scheduler.current = this;
  }

  private file(id: string, suffix: 'json' | 'lock' | 'cancel'): string {
    return path.join(this.dir, `${id}.${suffix}`);
  }

  private get tasksFile(): string {
    return path.join(this.dir, 'tasks.json');
  }

  private readTasks(): ScheduledTask[] {
    const tasks = readJson<ScheduledTask[]>(this.tasksFile);
    return Array.isArray(tasks) ? tasks : [];
  }

  private readState(id: string): TaskState {
    return { ...emptyState(), ...readJson<TaskState>(this.file(id, 'json')) };
  }

  private writeState(id: string, state: TaskState): void {
    writeAtomic(this.file(id, 'json'), state);
    this.states.set(id, state);
  }

  /** Reads the tasks and their states again; tells the tab if something changed. */
  load(): void {
    if (this.disposed) return;
    this.tasks = this.readTasks();
    this.states = new Map(this.tasks.map((t) => [t.id, this.readState(t.id)]));
    this.notifyIfChanged();
  }

  private notifyIfChanged(): void {
    const signature = JSON.stringify(this.list());
    if (signature === this.signature) return;
    this.signature = signature;
    this.changed.fire();
  }

  private runningWhere(task: ScheduledTask, state: TaskState): TaskInfo['running'] {
    if (this.active.has(task.id)) return 'here';
    return state.running && lockHeld(this.file(task.id, 'lock'), STALE_MS) ? 'elsewhere' : undefined;
  }

  list(): TaskInfo[] {
    return this.tasks.map((task) => {
      const state = this.states.get(task.id) ?? emptyState();
      return { task, state, next: nextTaskRun(task, state), running: this.runningWhere(task, state), progress: this.active.get(task.id)?.progress };
    });
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  hasEnabledTasks(): boolean {
    return this.tasks.some((t) => t.enabled);
  }

  /** Changes the list of tasks, read again first: another window may have changed it. */
  private updateTasks(change: (tasks: ScheduledTask[]) => ScheduledTask[]): void {
    writeAtomic(this.tasksFile, change(this.readTasks()));
    this.load();
  }

  /** Adds a task or replaces the one with its id. Its runs count from now when it is new, enabled or rescheduled. */
  save(task: ScheduledTask): void {
    this.updateTasks((tasks) => {
      const old = tasks.find((t) => t.id === task.id);
      const restart = !old || (!old.enabled && task.enabled) || JSON.stringify(old.schedule) !== JSON.stringify(task.schedule);
      const saved = { ...task, since: restart ? Date.now() : old.since };
      return old ? tasks.map((t) => (t.id === task.id ? saved : t)) : [...tasks, saved];
    });
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateTasks((tasks) => tasks.map((t) => (t.id === id && t.enabled !== enabled ? { ...t, enabled, since: enabled ? Date.now() : t.since } : t)));
  }

  /** Deletes the task and its run log; the files it wrote stay. */
  remove(id: string): void {
    this.cancel(id);
    this.updateTasks((tasks) => tasks.filter((t) => t.id !== id));
    for (const suffix of ['json', 'cancel'] as const) fs.rmSync(this.file(id, suffix), { force: true });
  }

  /** Cancels the run of a task, in this window or in the one running it. */
  cancel(id: string): void {
    const run = this.active.get(id);
    if (run) {
      run.cancelled = true;
      return;
    }
    const state = this.readState(id);
    if (state.running && lockHeld(this.file(id, 'lock'), STALE_MS)) fs.writeFileSync(this.file(id, 'cancel'), String(Date.now()));
  }

  /** Runs a task now, unless it is already running (here or in another window). */
  async runNow(id: string): Promise<RunOutcome> {
    const task = this.readTasks().find((t) => t.id === id);
    if (!task) return 'gone';
    return this.execute(task, 'manual');
  }

  /** Runs the tasks that are due, and records those missed. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    this.load();
    const now = Date.now();
    for (const task of this.tasks) {
      if (this.active.has(task.id)) continue;
      const due = dueRun(task, this.states.get(task.id) ?? emptyState(), now);
      if (due.kind === 'none') continue;
      if (due.kind === 'missed' && !task.runMissed) this.recordMissed(task, due.slot);
      else void this.execute(task, due.kind === 'missed' ? 'missed' : 'schedule');
    }
  }

  /** A run that came due while Mongoster wasn't running, not to be run late: recorded once. */
  private recordMissed(task: ScheduledTask, slot: number): void {
    const lock = FileLock.acquire(this.file(task.id, 'lock'), { staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS });
    if (!lock) return;
    try {
      const current = this.readTasks().find((t) => t.id === task.id);
      const state = this.readState(task.id);
      if (!current || dueRun(current, state, Date.now()).kind !== 'missed') return;
      this.writeState(
        task.id,
        addRun(
          { ...state, lastSlot: slot },
          { start: slot, end: slot, trigger: 'schedule', status: 'missed', error: "Mongoster wasn't running (or the computer was asleep) at that time" },
        ),
      );
    } catch (err) {
      console.error(`Mongoster: scheduled task ${task.name}: ${errorMessage(err)}`);
    } finally {
      lock.release();
      this.notifyIfChanged();
    }
  }

  /**
   * Runs a task once, holding its lock. A scheduled run checks again, with the lock, that it's still due:
   * another window may have just run it.
   */
  private async execute(task: ScheduledTask, trigger: RunTrigger): Promise<RunOutcome> {
    if (this.active.has(task.id)) return 'busy';
    const run: ActiveRun = { cancelled: false };
    const lock = FileLock.acquire(this.file(task.id, 'lock'), {
      staleMs: STALE_MS,
      heartbeatMs: HEARTBEAT_MS,
      onLost: () => (run.cancelled = true),
    });
    if (!lock) return 'busy';
    this.active.set(task.id, run);
    let state: TaskState | undefined;
    let record: TaskRun | undefined;
    const start = Date.now();
    const checkCancel = setInterval(() => {
      if (fs.existsSync(this.file(task.id, 'cancel'))) run.cancelled = true;
    }, CANCEL_CHECK_MS);
    try {
      fs.rmSync(this.file(task.id, 'cancel'), { force: true });
      const current = this.readTasks().find((t) => t.id === task.id);
      if (!current) return 'gone';
      task = current;
      state = this.readState(task.id);
      let slot: number | undefined;
      if (trigger !== 'manual') {
        const due = dueRun(task, state, start);
        if (due.kind === 'none') return 'done';
        slot = due.slot;
      }
      // A run of a window closed in the middle of it.
      if (state.running) state = addRun(state, { start: state.running.start, end: start, trigger: state.running.trigger, status: 'failed', error: 'Interrupted: VS Code or the app was closed during the run' });
      state = { ...state, ...(slot !== undefined && { lastSlot: slot }), running: { pid: process.pid, start, trigger } };
      this.writeState(task.id, state);
      this.notifyIfChanged();

      record = await this.perform(task, run, start, trigger);
      const latest = previousRun(task.schedule, Date.now());
      // Times that came while it ran are skipped: never two runs at once.
      if (latest !== undefined && latest > start && latest > (state.lastSlot ?? 0)) {
        record.note = [record.note, `The run due at ${new Date(latest).toLocaleTimeString()} was skipped: this one was still going`].filter(Boolean).join('. ');
        state.lastSlot = latest;
      }
      return 'done';
    } catch (err) {
      record = { start, end: Date.now(), trigger, status: 'failed', error: errorMessage(err) };
      return 'done';
    } finally {
      clearInterval(checkCancel);
      if (state && record) {
        try {
          // Read again: retention recorded the outputs.
          const fresh = this.readState(task.id);
          const saved = addRun({ ...fresh, lastSlot: Math.max(fresh.lastSlot ?? 0, state.lastSlot ?? 0) || undefined, running: undefined }, record);
          // Unless the task was deleted meanwhile.
          if (this.readTasks().some((t) => t.id === task.id)) this.writeState(task.id, saved);
        } catch (err) {
          console.error(`Mongoster: scheduled task ${task.name}: ${errorMessage(err)}`);
        }
      }
      fs.rmSync(this.file(task.id, 'cancel'), { force: true });
      lock.release();
      this.active.delete(task.id);
      if (!this.disposed) {
        this.load();
        this.changed.fire();
        if (record) {
          this.ran.fire({ task, run: record });
          this.report(task, record);
        }
      }
    }
  }

  /** The run itself: connects, writes the output, applies retention. */
  private async perform(task: ScheduledTask, run: ActiveRun, start: number, trigger: RunTrigger): Promise<TaskRun> {
    const info = this.connections.get(task.connectionId);
    if (!info) return { start, end: Date.now(), trigger, status: 'skipped', error: 'The connection was removed' };
    let client;
    try {
      client = await this.connections.getClient(info.id);
    } catch (err) {
      return { start, end: Date.now(), trigger, status: 'skipped', error: `Connection unavailable: ${errorMessage(err)}` };
    }
    let shown = 0;
    const progress = (message: string) => {
      run.progress = message;
      // The tab follows once a second.
      if (Date.now() - shown < 1000) return;
      shown = Date.now();
      this.notifyIfChanged();
    };
    const result = await runTask(task, client, info.name, { cancelled: () => run.cancelled, progress, columns: this.columns(task) });
    if (result.cancelled) return { start, end: Date.now(), trigger, status: 'cancelled', error: 'Cancelled: the incomplete output was deleted' };
    const output = result.output!;
    // Recorded before retention, so it never deletes the new one and a failure later still knows it.
    const state = this.readState(task.id);
    const retention = await applyRetention([...state.outputs, output], task.keep);
    this.writeState(task.id, { ...state, outputs: retention.outputs });
    const notes = [result.note, retention.errors.length ? `Could not delete ${retention.errors.join('; ')}` : ''].filter(Boolean);
    return {
      start,
      end: Date.now(),
      trigger,
      status: 'ok',
      output: output.path,
      size: output.size,
      documents: result.documents,
      collections: result.collections,
      deleted: retention.deleted || undefined,
      note: notes.length ? notes.join('. ') : undefined,
    };
  }

  /** Failures and skipped runs always notify; successful ones if the task asks for it. */
  private report(task: ScheduledTask, run: TaskRun): void {
    const show = 'Show Scheduled Tasks';
    const open = (answer: string | undefined) => {
      if (answer === show) void vscode.commands.executeCommand('mongoster.showScheduledTasks');
      if (answer === 'Reveal' && run.output) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(run.output));
    };
    if (run.status === 'failed') void vscode.window.showErrorMessage(`Scheduled task "${task.name}" failed: ${run.error}`, show).then(open);
    else if (run.status === 'skipped') void vscode.window.showWarningMessage(`Scheduled task "${task.name}" was skipped: ${run.error}`, show).then(open);
    else if (run.status === 'ok' && task.notifySuccess) {
      const seconds = ((run.end - run.start) / 1000).toFixed(1);
      const what = [run.collections !== undefined ? plural(run.collections, 'collection') : '', plural(run.documents ?? 0, 'document'), formatSize(run.size ?? 0)].filter(Boolean).join(', ');
      void vscode.window.showInformationMessage(`Scheduled task "${task.name}" done (${what}) in ${seconds} s: ${path.basename(run.output ?? '')}`, 'Reveal', show).then(open);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.active.values()) run.cancelled = true;
    clearInterval(this.timer);
    clearTimeout(this.first);
    clearTimeout(this.reload);
    this.watcher?.close();
    this.changed.dispose();
    this.ran.dispose();
    if (Scheduler.current === this) Scheduler.current = undefined;
  }
}
