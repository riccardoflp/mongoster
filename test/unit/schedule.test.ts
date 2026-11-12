// Scheduled tasks: when they run (local time, across daylight saving changes), due and missed runs,
// the names of what they write and what retention deletes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERN,
  addRun,
  describeSchedule,
  dueRun,
  emptyState,
  expandPattern,
  nextRun,
  nextRuns,
  outputName,
  outputsToDelete,
  patternError,
  previousRun,
  taskErrors,
  type Schedule,
  type ScheduledTask,
  type TaskOutput,
} from '../../src/shared/schedule';

// Europe/Rome: daylight saving starts on 2026-03-29 (02:00 → 03:00) and ends on 2026-10-25 (03:00 → 02:00).
const TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Europe/Rome';
});
afterAll(() => {
  process.env.TZ = TZ;
  if (TZ === undefined) delete process.env.TZ;
});

/** Local time in Rome as epoch ms. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
/** Epoch ms as "YYYY-MM-DD HH:MM" in local time. */
const local = (ms: number | undefined) => {
  if (ms === undefined) return undefined;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const task = (changes: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  name: 'Nightly',
  kind: 'backup',
  enabled: true,
  connectionId: 'c1',
  database: 'shop',
  format: 'archive',
  folder: '/backups',
  pattern: DEFAULT_PATTERN,
  schedule: { kind: 'daily', time: '02:30' },
  keep: 3,
  runMissed: false,
  notifySuccess: false,
  since: at(2026, 1, 1),
  ...changes,
});

describe('next run', () => {
  it('runs daily at the time, today if it has not passed', () => {
    const daily = { kind: 'daily', time: '02:30' } as const;
    expect(local(nextRun(daily, at(2026, 11, 11, 1, 0)))).toBe('2026-11-11 02:30');
    expect(local(nextRun(daily, at(2026, 11, 11, 2, 30)))).toBe('2026-11-12 02:30');
    expect(local(nextRun(daily, at(2026, 12, 31, 23, 0)))).toBe('2027-01-01 02:30');
  });

  it('runs every N hours at the times N hours apart from the one given', () => {
    const every6 = { kind: 'hours', every: 6, time: '08:15' } as const;
    expect(nextRuns(every6, at(2026, 11, 11, 0, 0), 5).map(local)).toEqual([
      '2026-11-11 02:15',
      '2026-11-11 08:15',
      '2026-11-11 14:15',
      '2026-11-11 20:15',
      '2026-11-12 02:15',
    ]);
    expect(describeSchedule(every6)).toBe('Every 6 hours (02:15, 08:15, 14:15, 20:15)');
    expect(describeSchedule({ kind: 'hours', every: 1, time: '00:05' })).toBe('Every hour at :05');
  });

  it('runs weekly on the chosen days', () => {
    const weekly: Schedule = { kind: 'weekly', days: [1, 4], time: '23:30' };
    // 2026-11-11 is a Wednesday.
    expect(nextRuns(weekly, at(2026, 11, 11, 12), 3).map(local)).toEqual(['2026-11-12 23:30', '2026-11-16 23:30', '2026-11-19 23:30']);
    expect(describeSchedule(weekly)).toBe('Mon, Thu at 23:30');
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '07:00' })).toBe('Weekdays at 07:00');
    expect(nextRun({ kind: 'weekly', days: [], time: '07:00' }, at(2026, 11, 11))).toBeUndefined();
  });

  it('keeps the local time across daylight saving changes, without skipping or repeating a day', () => {
    const daily = { kind: 'daily', time: '02:30' } as const;
    // 02:30 doesn't exist on 2026-03-29: it runs at 03:30, then at 02:30 again.
    expect(nextRuns(daily, at(2026, 3, 27, 12), 4).map(local)).toEqual(['2026-03-28 02:30', '2026-03-29 03:30', '2026-03-30 02:30', '2026-03-31 02:30']);
    // 02:30 happens twice on 2026-10-25: it runs once.
    const autumn = nextRuns(daily, at(2026, 10, 24, 12), 3);
    expect(autumn.map(local)).toEqual(['2026-10-25 02:30', '2026-10-26 02:30', '2026-10-27 02:30']);
    expect(autumn[1] - autumn[0]).toBe(25 * 3_600_000);
    // 23 or 25 hours apart, always the same time of day the day after.
    const nine = { kind: 'daily', time: '09:00' } as const;
    const spring = nextRuns(nine, at(2026, 3, 28, 8), 2);
    expect(spring[1] - spring[0]).toBe(23 * 3_600_000);
  });

  it('runs every hour once per hour of local time on the day daylight saving starts', () => {
    const hourly = { kind: 'hours', every: 1, time: '00:30' } as const;
    const runs = nextRuns(hourly, at(2026, 3, 29, 0, 45), 3);
    // 02:30 doesn't exist: the hour after 01:30 is 03:30, once.
    expect(runs.map(local)).toEqual(['2026-03-29 01:30', '2026-03-29 03:30', '2026-03-29 04:30']);
    expect(new Set(runs).size).toBe(3);
  });

  it('finds the last run at or before a time', () => {
    const daily = { kind: 'daily', time: '02:30' } as const;
    expect(local(previousRun(daily, at(2026, 11, 11, 2, 30)))).toBe('2026-11-11 02:30');
    expect(local(previousRun(daily, at(2026, 11, 11, 2, 29)))).toBe('2026-11-10 02:30');
    expect(local(previousRun({ kind: 'weekly', days: [0], time: '05:00' }, at(2026, 11, 11)))).toBe('2026-11-08 05:00');
  });
});

describe('due and missed runs', () => {
  it('is due once the time has come, and not again after it was handled', () => {
    const t = task();
    const yesterday = { ...emptyState(), lastSlot: at(2026, 11, 10, 2, 30) };
    expect(dueRun(t, yesterday, at(2026, 11, 11, 2, 29))).toEqual({ kind: 'none' });
    expect(dueRun(t, yesterday, at(2026, 11, 11, 2, 31))).toEqual({ kind: 'run', slot: at(2026, 11, 11, 2, 30) });
    const handled = { ...emptyState(), lastSlot: at(2026, 11, 11, 2, 30) };
    expect(dueRun(t, handled, at(2026, 11, 11, 2, 31))).toEqual({ kind: 'none' });
    expect(dueRun(t, handled, at(2026, 11, 12, 2, 30))).toEqual({ kind: 'run', slot: at(2026, 11, 12, 2, 30) });
  });

  it('finds a run more than the grace period late missed, and only the latest of several', () => {
    const t = task();
    const state = { ...emptyState(), lastSlot: at(2026, 11, 8, 2, 30) };
    // Closed for three days, opened at 09:00: one missed run, the one of this morning.
    expect(dueRun(t, state, at(2026, 11, 11, 9, 0))).toEqual({ kind: 'missed', slot: at(2026, 11, 11, 2, 30) });
    expect(dueRun(t, state, at(2026, 11, 11, 2, 34))).toEqual({ kind: 'run', slot: at(2026, 11, 11, 2, 30) });
  });

  it('counts runs from when the task was created or enabled, and never when disabled', () => {
    const t = task({ since: at(2026, 11, 11, 3, 0) });
    expect(dueRun(t, emptyState(), at(2026, 11, 11, 9, 0))).toEqual({ kind: 'none' });
    expect(dueRun({ ...t, enabled: false }, emptyState(), at(2026, 11, 13))).toEqual({ kind: 'none' });
  });

  it('keeps the last runs in the log, newest first', () => {
    let state = emptyState();
    for (let i = 0; i < 25; i++) state = addRun(state, { start: i, end: i, trigger: 'schedule', status: 'ok' });
    expect(state.runs).toHaveLength(20);
    expect(state.runs[0].start).toBe(24);
  });
});

describe('file names', () => {
  // Built once TZ is set: when the file is loaded it is still the system's time zone (UTC on the CI).
  let date: Date;
  beforeAll(() => {
    date = new Date(2026, 9, 8, 16, 45, 12);
  });

  it('expands the placeholders, as Back Up names its files by default', () => {
    expect(expandPattern(DEFAULT_PATTERN, date, { name: 'shop', connection: 'Local' })).toBe('shop_2026-10-08_16-45-12');
    expect(expandPattern('{connection}-{database}.{collection}-{YYYY}{MM}{DD}-{HH}{mm}{ss}-{weekday}', date, { name: 'orders', connection: 'Prod DB', database: 'shop', collection: 'orders' })).toBe(
      'Prod_DB-shop.orders-20261008-164512-Thu',
    );
  });

  it('adds the extension of the format, none for a folder', () => {
    expect(outputName(task(), date, 'Local')).toBe('shop_2026-10-08_16-45-12.agz');
    expect(outputName(task({ format: 'gzip' }), date, 'Local')).toBe('shop_2026-10-08_16-45-12');
    expect(outputName(task({ kind: 'export', collection: 'orders', format: 'csv' }), date, 'Local')).toBe('orders_2026-10-08_16-45-12.csv');
    expect(outputName(task({ database: undefined }), date, 'My Server')).toBe('My_Server_2026-10-08_16-45-12.agz');
  });

  it('refuses names without a date, with folders or with unknown placeholders', () => {
    expect(patternError(DEFAULT_PATTERN)).toBeUndefined();
    expect(patternError('backup')).toMatch(/date or time/);
    expect(patternError('daily/{date}')).toMatch(/cannot contain/);
    expect(patternError('{name}_{day}')).toMatch(/Unknown placeholder \{day\}/);
    expect(patternError(' ')).toMatch(/Enter/);
  });
});

describe('retention', () => {
  const outputs: TaskOutput[] = [1, 2, 3, 4, 5].map((n) => ({ path: `/b/${n}.agz`, at: n * 1000, size: n, dir: false }));

  it('deletes all but the newest ones kept, whatever their order', () => {
    expect(outputsToDelete(outputs, 3).map((o) => o.path)).toEqual(['/b/2.agz', '/b/1.agz']);
    expect(outputsToDelete([...outputs].reverse(), 4).map((o) => o.path)).toEqual(['/b/1.agz']);
    expect(outputsToDelete(outputs, 5)).toEqual([]);
  });

  it('keeps everything with 0', () => {
    expect(outputsToDelete(outputs, 0)).toEqual([]);
  });
});

describe('validation', () => {
  it('accepts a complete task', () => {
    expect(taskErrors(task())).toEqual({});
  });

  it('reports what is missing or wrong, field by field', () => {
    const errors = taskErrors(task({ kind: 'export', format: 'archive', collection: undefined, filter: '{ status: ', name: ' ', keep: -1, schedule: { kind: 'weekly', days: [], time: '25:00' } }));
    expect(Object.keys(errors).sort()).toEqual(['collection', 'days', 'filter', 'format', 'keep', 'name', 'time']);
    expect(taskErrors(task({ kind: 'export', collection: 'orders', format: 'jsonl', projection: '[1]' })).projection).toMatch(/object/);
  });
});
