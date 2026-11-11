// Scheduled tasks (periodic backups and exports) without I/O: the task and its saved state, when it
// runs next in local time (also across daylight saving changes), whether a run is due or was missed,
// the names of the files it writes and which of them retention deletes. Shared by the extension
// and the Scheduled Tasks tab.
import { isPlainObject, parseQuery } from './query';

export type TaskKind = 'backup' | 'export';
/** Backup formats, as the Back Up command offers them. */
export type BackupFormat = 'archive' | 'gzip' | 'plain';
export type ExportFormat = 'json' | 'jsonl' | 'csv';

/**
 * When a task runs, in local time. `hours`: every N hours (a divisor of 24), at the times of the day
 * that are N hours apart from `time` (every 6 hours from 02:30 is 02:30, 08:30, 14:30, 20:30).
 */
export type Schedule =
  | { kind: 'hours'; every: number; time: string }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string };

export interface ScheduledTask {
  id: string;
  name: string;
  kind: TaskKind;
  enabled: boolean;
  connectionId: string;
  /** None: every database of the connection. */
  database?: string;
  /** None: every collection of the database (an export needs one). */
  collection?: string;
  format: BackupFormat | ExportFormat;
  /** Export only, mongosh syntax. */
  filter?: string;
  projection?: string;
  /** Where the files go. */
  folder: string;
  /** Name of what each run writes, with placeholders such as {date}; the extension is added. */
  pattern: string;
  schedule: Schedule;
  /** Files or folders of this task kept, the newest; 0 keeps them all. */
  keep: number;
  /** A run missed while Mongoster wasn't running (or the computer was asleep) runs when it starts again. */
  runMissed: boolean;
  /** Notify after a successful run too (failures always notify). */
  notifySuccess: boolean;
  /** Epoch ms from which runs count: creation, enabling, a schedule change. */
  since: number;
}

export type RunTrigger = 'schedule' | 'manual' | 'missed';
export type RunStatus = 'ok' | 'failed' | 'skipped' | 'cancelled' | 'missed';

/** One entry of a task's run log. */
export interface TaskRun {
  /** Epoch ms. */
  start: number;
  end: number;
  trigger: RunTrigger;
  status: RunStatus;
  /** The file or folder written. */
  output?: string;
  /** Bytes written. */
  size?: number;
  documents?: number;
  collections?: number;
  /** Why it failed or was skipped. */
  error?: string;
  /** Something to know, e.g. collections left out. */
  note?: string;
  /** Older outputs deleted by retention. */
  deleted?: number;
}

/** A file or folder a run of the task wrote: retention only ever deletes these. */
export interface TaskOutput {
  path: string;
  /** Epoch ms of the run. */
  at: number;
  size: number;
  dir: boolean;
}

/** What is saved about a task besides its definition, shared by every window. */
export interface TaskState {
  /** The last scheduled time handled (run, skipped or missed): it doesn't run again for it. */
  lastSlot?: number;
  /** Newest first. */
  runs: TaskRun[];
  /** Oldest first. */
  outputs: TaskOutput[];
  /** A run in progress (the lock says whether its process is still alive). */
  running?: { pid: number; start: number; trigger: RunTrigger };
}

export const MAX_RUNS = 20;
export const HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12];
export const DEFAULT_PATTERN = '{name}_{date}_{time}';
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A scheduled run found up to this late still runs; later it was missed. */
export const GRACE_MS = 5 * 60_000;

export const BACKUP_FORMATS: { value: BackupFormat; label: string }[] = [
  { value: 'archive', label: 'Archive (.agz)' },
  { value: 'gzip', label: 'Folder, compressed (gzip)' },
  { value: 'plain', label: 'Folder, uncompressed' },
];

export const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSON Lines' },
  { value: 'csv', label: 'CSV' },
];

/** The extension of what a run writes ('' for a folder). */
export function outputExtension(format: BackupFormat | ExportFormat): string {
  return format === 'archive' ? '.agz' : format === 'gzip' || format === 'plain' ? '' : `.${format}`;
}

export const emptyState = (): TaskState => ({ runs: [], outputs: [] });

// ---------------------------------------------------------------- schedule

/** "HH:MM" (also "H:MM") → hours and minutes. */
export function parseTime(text: string): { h: number; m: number } | undefined {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? { h, m } : undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** The times of day (hours, minutes) a schedule runs at, sorted. */
function timesOfDay(schedule: Schedule): { h: number; m: number }[] {
  const t = parseTime(schedule.time);
  if (!t) return [];
  if (schedule.kind !== 'hours') return [t];
  const every = Math.max(1, Math.min(24, Math.floor(schedule.every)));
  const out: { h: number; m: number }[] = [];
  for (let h = t.h % every; h < 24; h += every) out.push({ h, m: t.m });
  return out;
}

/**
 * The runs on one local calendar day, as epoch ms. A time that doesn't exist that day (the hour
 * skipped when daylight saving starts) runs when it would have, in the new time: 02:30 becomes 03:30.
 * A time that happens twice (when it ends) runs once.
 */
function runsOnDay(schedule: Schedule, year: number, month: number, day: number): number[] {
  const weekday = new Date(year, month, day, 12).getDay();
  if (schedule.kind === 'weekly' && !schedule.days.includes(weekday)) return [];
  const out = timesOfDay(schedule).map(({ h, m }) => new Date(year, month, day, h, m).getTime());
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Calls `visit` for each local day from the one of `from`, `step` days at a time, for `count` days. */
function eachDay(from: number, step: 1 | -1, count: number, visit: (y: number, m: number, d: number) => boolean | void): void {
  const start = new Date(from);
  for (let i = 0; i < count; i++) {
    // Noon: never shifted to another day by a daylight saving change.
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * step, 12);
    if (visit(day.getFullYear(), day.getMonth(), day.getDate())) return;
  }
}

/** The first run strictly after `after` (epoch ms), or undefined if the schedule never runs. */
export function nextRun(schedule: Schedule, after: number): number | undefined {
  let found: number | undefined;
  // From the day before: a normalized time (02:30 → 03:30) can't fall on the previous day, but be safe.
  eachDay(after - 86_400_000, 1, 10, (y, m, d) => {
    found = runsOnDay(schedule, y, m, d).find((t) => t > after);
    return found !== undefined;
  });
  return found;
}

/** The last run at or before `at`, or undefined if there is none in the week before. */
export function previousRun(schedule: Schedule, at: number): number | undefined {
  let found: number | undefined;
  eachDay(at + 86_400_000, -1, 10, (y, m, d) => {
    const runs = runsOnDay(schedule, y, m, d).filter((t) => t <= at);
    found = runs[runs.length - 1];
    return found !== undefined;
  });
  return found;
}

/** The next `count` runs after `after`. */
export function nextRuns(schedule: Schedule, after: number, count: number): number[] {
  const out: number[] = [];
  let t: number | undefined = after;
  while (out.length < count && (t = nextRun(schedule, t)) !== undefined) out.push(t);
  return out;
}

/** From when the runs of a task count: what was handled last, or when it was created or enabled. */
export const runsCountFrom = (task: ScheduledTask, state: TaskState) => Math.max(task.since, state.lastSlot ?? 0);

/** The next run of a task, or undefined when it is disabled. */
export function nextTaskRun(task: ScheduledTask, state: TaskState): number | undefined {
  return task.enabled ? nextRun(task.schedule, runsCountFrom(task, state)) : undefined;
}

export type Due =
  | { kind: 'none' }
  /** Run for the scheduled time `slot`. */
  | { kind: 'run'; slot: number }
  /** `slot` was missed: run it late if the task says so, otherwise just record it. */
  | { kind: 'missed'; slot: number };

/**
 * Whether a task has a run to do at `now`. Of several runs due, only the latest counts. A run found
 * more than `grace` late (Mongoster wasn't running, the computer was asleep) was missed.
 */
export function dueRun(task: ScheduledTask, state: TaskState, now: number, grace = GRACE_MS): Due {
  if (!task.enabled) return { kind: 'none' };
  const next = nextRun(task.schedule, runsCountFrom(task, state));
  if (next === undefined || next > now) return { kind: 'none' };
  const slot = previousRun(task.schedule, now) ?? next;
  return now - slot <= grace ? { kind: 'run', slot } : { kind: 'missed', slot };
}

/** "Every 6 hours (02:30, 08:30, 14:30, 20:30)", "Daily at 02:00", "Mon, Thu at 23:30". */
export function describeSchedule(schedule: Schedule): string {
  const times = timesOfDay(schedule).map(({ h, m }) => hhmm(h, m));
  if (!times.length) return 'Invalid time';
  if (schedule.kind === 'daily') return `Daily at ${times[0]}`;
  if (schedule.kind === 'weekly') {
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => schedule.days.includes(d));
    if (!days.length) return 'No days chosen';
    const which = days.length === 7 ? 'Every day' : days.length === 5 && !days.includes(0) && !days.includes(6) ? 'Weekdays' : days.map((d) => WEEKDAYS[d]).join(', ');
    return `${which} at ${times[0]}`;
  }
  if (schedule.every === 1) return `Every hour at :${times[0].slice(3)}`;
  return `Every ${schedule.every} hours (${times.join(', ')})`;
}

// ---------------------------------------------------------------- file names

export interface PatternValues {
  /** What is saved: the collection, database or connection. */
  name: string;
  connection: string;
  database?: string;
  collection?: string;
}

const PLACEHOLDERS = ['name', 'connection', 'database', 'collection', 'date', 'time', 'YYYY', 'MM', 'DD', 'HH', 'mm', 'ss', 'weekday'];
export const PLACEHOLDER_HELP = '{name} {connection} {database} {collection} {date} {time} {YYYY} {MM} {DD} {HH} {mm} {ss} {weekday}';

/** Characters that can't be in a file name on some system, and spaces. */
export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_');

/** Why the pattern can't be used, or undefined. */
export function patternError(pattern: string): string | undefined {
  if (!pattern.trim()) return 'Enter a file name';
  if (/[\\/]/.test(pattern)) return 'The file name cannot contain / or \\: choose the folder instead';
  const unknown = [...pattern.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((p) => !PLACEHOLDERS.includes(p));
  if (unknown.length) return `Unknown placeholder {${unknown[0]}}: use ${PLACEHOLDER_HELP}`;
  if (!/\{(date|time|YYYY|MM|DD|HH|mm|ss|weekday)\}/.test(pattern)) return 'Include the date or time, e.g. {date}_{time}, so the runs write different files';
  return undefined;
}

/** The file or folder name of a run at `date` (local time), without the extension. */
export function expandPattern(pattern: string, date: Date, values: PatternValues): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const parts: Record<string, string> = {
    name: values.name,
    connection: values.connection,
    database: values.database ?? '',
    collection: values.collection ?? '',
    YYYY: String(date.getFullYear()),
    MM: p2(date.getMonth() + 1),
    DD: p2(date.getDate()),
    HH: p2(date.getHours()),
    mm: p2(date.getMinutes()),
    ss: p2(date.getSeconds()),
    weekday: WEEKDAYS[date.getDay()],
  };
  parts.date = `${parts.YYYY}-${parts.MM}-${parts.DD}`;
  parts.time = `${parts.HH}-${parts.mm}-${parts.ss}`;
  const name = pattern.replace(/\{([^}]*)\}/g, (all, key: string) => (key in parts ? parts[key] : all));
  return safeFileName(name).replace(/^[._]+|[._]+$/g, '') || 'output';
}

/** What a task saves, by name: as the Back Up and Export commands name their files. */
export function patternValues(task: Pick<ScheduledTask, 'database' | 'collection'>, connectionName: string): PatternValues {
  return {
    name: task.collection ?? task.database ?? connectionName,
    connection: connectionName,
    database: task.database,
    collection: task.collection,
  };
}

/** The name (with its extension) of what a run of the task writes at `date`. */
export function outputName(task: ScheduledTask, date: Date, connectionName: string): string {
  return expandPattern(task.pattern, date, patternValues(task, connectionName)) + outputExtension(task.format);
}

// ---------------------------------------------------------------- retention

/** The outputs that retention deletes: all but the newest `keep` (none when keep is 0). */
export function outputsToDelete(outputs: TaskOutput[], keep: number): TaskOutput[] {
  if (!(keep > 0)) return [];
  // Of two at the same time, the one added later is the newer.
  const newest = outputs.map((o, i) => ({ o, i })).sort((a, b) => b.o.at - a.o.at || b.i - a.i);
  return newest.slice(Math.floor(keep)).map(({ o }) => o);
}

/** Adds a run to the log, newest first, keeping the last MAX_RUNS. */
export function addRun(state: TaskState, run: TaskRun): TaskState {
  return { ...state, runs: [run, ...state.runs].slice(0, MAX_RUNS) };
}

// ---------------------------------------------------------------- validation

function objectError(text: string | undefined, label: string): string | undefined {
  if (!text?.trim()) return undefined;
  try {
    if (!isPlainObject(parseQuery(text))) return `${label} must be an object, e.g. { status: "active" }`;
  } catch (err) {
    return `${label}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

/** What is wrong with a task, field by field (empty when it can be saved). */
export function taskErrors(task: ScheduledTask): Partial<Record<keyof ScheduledTask | 'time' | 'days' | 'every', string>> {
  const errors: Partial<Record<keyof ScheduledTask | 'time' | 'days' | 'every', string>> = {};
  if (!task.name.trim()) errors.name = 'Enter a name';
  if (!task.connectionId) errors.connectionId = 'Choose a connection';
  if (task.collection && !task.database) errors.database = 'Enter the database of the collection';
  if (task.kind === 'export') {
    if (!task.database) errors.database = 'Enter the database';
    if (!task.collection) errors.collection = 'An export is of one collection: enter it';
    if (!EXPORT_FORMATS.some((f) => f.value === task.format)) errors.format = 'Choose JSON, JSON Lines or CSV';
    const filter = objectError(task.filter, 'Filter');
    if (filter) errors.filter = filter;
    const projection = objectError(task.projection, 'Projection');
    if (projection) errors.projection = projection;
  } else if (!BACKUP_FORMATS.some((f) => f.value === task.format)) errors.format = 'Choose a backup format';
  if (!task.folder.trim()) errors.folder = 'Choose the folder';
  const pattern = patternError(task.pattern);
  if (pattern) errors.pattern = pattern;
  if (!parseTime(task.schedule.time)) errors.time = 'Enter a time as HH:MM, e.g. 02:30';
  if (task.schedule.kind === 'weekly' && !task.schedule.days.length) errors.days = 'Choose at least one day';
  if (task.schedule.kind === 'hours' && !HOUR_CHOICES.includes(task.schedule.every)) errors.every = `Every ${HOUR_CHOICES.join(', ')} hours`;
  if (!Number.isInteger(task.keep) || task.keep < 0) errors.keep = 'Enter how many to keep (0: all)';
  return errors;
}
