// Scheduled Tasks tab: the periodic backups and exports, their next run, last result and run log, and
// the form to create or edit one.
import type { ScheduleConnection, ScheduleHostMessage, ScheduleViewMessage, ScheduledTaskView } from '../shared/messages';
import {
  BACKUP_FORMATS,
  EXPORT_FORMATS,
  HOUR_CHOICES,
  PLACEHOLDER_HELP,
  WEEKDAYS,
  describeSchedule,
  nextRuns,
  outputName,
  taskErrors,
  type RunStatus,
  type ScheduledTask,
  type Schedule,
  type TaskRun,
} from '../shared/schedule';

interface State {
  expanded: string[];
}

declare function acquireVsCodeApi(): { postMessage(m: ScheduleViewMessage): void; getState(): Partial<State> | undefined; setState(s: State): void };

const vscode = acquireVsCodeApi();
const saved = vscode.getState();
const expanded = new Set<string>(saved?.expanded ?? []);
const post = (m: ScheduleViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const remember = () => vscode.setState({ expanded: [...expanded] });

let tasks: ScheduledTaskView[] = [];
let connections: ScheduleConnection[] = [];
let defaultFolder = '';
/** The task being edited in the form. */
let draft: ScheduledTask | undefined;
let draftIsNew = false;
/** Database and collection names for the form's suggestions, by "connection" and "connection/database". */
const names = new Map<string, string[] | 'loading'>();

// ---------------------------------------------------------------- formatting

const p2 = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, what: string) => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

function size(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "today 02:00", "tomorrow 02:00", "Fri 13 Nov 02:00". */
function when(ms: number): string {
  const d = new Date(ms);
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const day = (offset: number) => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() + offset).toDateString();
  };
  if (d.toDateString() === day(0)) return `today ${time}`;
  if (d.toDateString() === day(1)) return `tomorrow ${time}`;
  if (d.toDateString() === day(-1)) return `yesterday ${time}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${time}`;
}

const STATUS_TEXT: Record<RunStatus, string> = { ok: 'done', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled', missed: 'missed' };
const TRIGGER_TEXT = { schedule: 'scheduled', manual: 'Run Now', missed: 'missed, run late' };

function runSummary(run: TaskRun): string {
  if (run.status === 'ok') {
    return [run.collections !== undefined ? plural(run.collections, 'collection') : '', plural(run.documents ?? 0, 'document'), size(run.size ?? 0), duration(run.end - run.start)]
      .filter(Boolean)
      .join(', ');
  }
  return run.error ?? '';
}

function sourceText(t: { database?: string; collection?: string }, kind: ScheduledTask['kind']): string {
  if (t.collection) return `${t.database}.${t.collection}`;
  if (t.database) return kind === 'backup' ? `${t.database} (all collections)` : t.database;
  return 'all databases';
}

function formatLabel(task: ScheduledTask): string {
  return [...BACKUP_FORMATS, ...EXPORT_FORMATS].find((f) => f.value === task.format)?.label ?? task.format;
}

// ---------------------------------------------------------------- DOM helpers

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = make('button', className, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function cell(row: HTMLTableRowElement, content: string | Node, className = '', title?: string): HTMLTableCellElement {
  const c = row.insertCell();
  c.append(content);
  if (className) c.className = className;
  if (title) c.title = title;
  return c;
}

function dot(color?: string): HTMLSpanElement {
  const d = make('span', 'dot');
  if (color) d.dataset.color = color;
  return d;
}

function showMessage(text: string, failed = false): void {
  const box = el('message');
  box.textContent = text;
  box.classList.toggle('hidden', !text);
  box.classList.toggle('failed', failed);
}

// ---------------------------------------------------------------- the list

function statusBadge(status: RunStatus | 'running'): HTMLSpanElement {
  return make('span', `status ${status}`, status === 'running' ? 'running' : STATUS_TEXT[status]);
}

function runLog(t: ScheduledTaskView): HTMLElement {
  const box = make('div', 'detail-box');
  const { task } = t;
  const facts = make('div', 'facts');
  const fact = (label: string, value: string) => {
    const line = make('div');
    line.append(make('span', 'muted', `${label}: `), value);
    facts.append(line);
  };
  fact('Writes', `${formatLabel(task)} in ${task.folder}, named ${task.pattern}`);
  if (task.kind === 'export' && (task.filter || task.projection)) fact('Query', [task.filter && `filter ${task.filter}`, task.projection && `projection ${task.projection}`].filter(Boolean).join(', '));
  fact('Keeps', task.keep ? `the last ${plural(task.keep, task.kind === 'backup' && task.format !== 'archive' ? 'folder' : 'file')} it wrote` : 'everything it writes');
  if (task.runMissed) fact('Missed runs', 'run when Mongoster starts');
  box.append(facts);
  if (!t.state.runs.length) {
    box.append(make('div', 'muted', 'No runs yet.'));
    return box;
  }
  const table = make('table', 'runs');
  const head = table.createTHead().insertRow();
  for (const label of ['started', 'how', 'result', 'details', 'output']) head.append(make('th', '', label));
  const body = table.createTBody();
  for (const run of t.state.runs) {
    const row = body.insertRow();
    cell(row, when(run.start), 'time', new Date(run.start).toLocaleString());
    cell(row, TRIGGER_TEXT[run.trigger], 'muted');
    cell(row, statusBadge(run.status));
    const details = [runSummary(run), run.deleted ? `${plural(run.deleted, 'old output')} deleted` : '', run.status === 'ok' ? run.note ?? '' : run.note ?? ''].filter(Boolean).join('. ');
    cell(row, details, `details${run.status === 'failed' ? ' failed' : ''}`, details);
    const output = row.insertCell();
    output.className = 'output';
    if (run.output) {
      const name = run.output.split(/[\\/]/).pop() ?? run.output;
      const exists = t.state.outputs.some((o) => o.path === run.output);
      if (exists) output.append(button(name, 'link', () => post({ type: 'reveal', path: run.output! }), `Reveal ${run.output}`));
      else {
        output.append(make('span', 'muted deleted', name));
        output.title = 'Deleted by retention';
      }
    }
  }
  box.append(table);
  return box;
}

function render(): void {
  const enabled = tasks.filter((t) => t.task.enabled).length;
  el('summary').textContent = tasks.length ? `${plural(tasks.length, 'task')}, ${enabled.toLocaleString('en-US')} enabled` : '';
  const table = el<HTMLTableElement>('tasks');
  table.textContent = '';
  if (!tasks.length) {
    const c = table.insertRow().insertCell();
    c.className = 'empty';
    c.textContent = 'No scheduled tasks yet. New Task… (or Schedule… on a connection, a database or a collection) backs up or exports periodically.';
    return;
  }
  const head = table.createTHead().insertRow();
  for (const label of ['', 'task', 'of', 'when', 'next run', 'last run', '']) head.append(make('th', '', label));
  const body = table.createTBody();
  for (const t of tasks) {
    const { task, state } = t;
    const row = body.insertRow();
    row.className = `task${task.enabled ? '' : ' disabled'}${expanded.has(task.id) ? ' open' : ''}`;

    const toggle = make('input');
    toggle.type = 'checkbox';
    toggle.checked = task.enabled;
    toggle.title = task.enabled ? 'Enabled: click to disable' : 'Disabled: click to enable';
    toggle.addEventListener('click', (e) => e.stopPropagation());
    toggle.addEventListener('change', () => post({ type: 'toggle', id: task.id, enabled: toggle.checked }));
    cell(row, toggle, 'toggle');

    const name = make('div', 'name', task.name);
    const kind = make('div', 'muted', `${task.kind === 'backup' ? 'Backup' : 'Export'}, ${formatLabel(task)}`);
    cell(row, name, 'task-name').append(kind);

    const source = make('span');
    source.append(dot(t.color), make('span', 'conn', `${t.connectionName ?? 'removed connection'} › `), sourceText(task, task.kind));
    cell(row, source, `source${t.connectionName ? '' : ' failed'}`, `${t.connectionName ?? 'The connection was removed'} › ${sourceText(task, task.kind)}`);

    cell(row, describeSchedule(task.schedule), 'schedule');
    cell(row, t.running ? '' : t.next ? when(t.next) : '—', 'time', t.next ? new Date(t.next).toLocaleString() : task.enabled ? '' : 'Disabled');

    const last = row.insertCell();
    last.className = 'last';
    const run = state.runs[0];
    if (t.running) {
      last.append(statusBadge('running'), ` ${t.running === 'elsewhere' ? 'in another window' : t.progress ?? 'starting…'}`);
    } else if (run) {
      last.append(statusBadge(run.status), ` ${when(run.start)}`);
      const summary = runSummary(run);
      if (summary) last.append(make('div', `muted summary${run.status === 'failed' || run.status === 'skipped' ? ' failed' : ''}`, summary));
      last.title = [new Date(run.start).toLocaleString(), summary, run.note].filter(Boolean).join('\n');
    } else last.append(make('span', 'muted', 'never'));

    const actions = row.insertCell();
    actions.className = 'actions';
    const wrap = make('div', 'row-actions');
    if (t.running) wrap.append(button('Cancel', 'small secondary', () => post({ type: 'cancel', id: task.id }), 'Stop the run: what it wrote so far is deleted'));
    else wrap.append(button('Run Now', 'small', () => post({ type: 'run', id: task.id }), 'Run it once now (the schedule stays as it is)'));
    wrap.append(
      button('Edit', 'small secondary', () => post({ type: 'edit', id: task.id })),
      button('✕', 'small secondary', () => post({ type: 'delete', id: task.id }), 'Delete the task (the files it wrote stay)'),
    );
    actions.append(wrap);

    row.addEventListener('click', () => {
      if (!expanded.delete(task.id)) expanded.add(task.id);
      remember();
      render();
    });
    if (expanded.has(task.id)) {
      const detail = body.insertRow();
      detail.className = 'detail';
      const c = detail.insertCell();
      c.colSpan = 7;
      c.append(runLog(t));
    }
  }
}

// ---------------------------------------------------------------- the form

const errorsShown = new Set<string>();

function field(form: HTMLElement, label: string, control: HTMLElement | HTMLElement[], hint?: string, key?: string): HTMLElement {
  const l = make('label', 'label', label);
  const box = make('div', 'control');
  box.append(...(Array.isArray(control) ? control : [control]));
  if (hint) box.append(make('div', 'hint', hint));
  if (key) {
    const error = make('div', 'error hidden');
    error.dataset.key = key;
    box.append(error);
  }
  form.append(l, box);
  return box;
}

function input(value: string, onInput: (v: string) => void, attrs: Record<string, string> = {}): HTMLInputElement {
  const i = make('input');
  i.type = 'text';
  i.spellcheck = false;
  i.value = value;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  i.addEventListener('input', () => {
    onInput(i.value);
    refreshForm();
  });
  return i;
}

function select<T extends string | number>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = make('select');
  for (const o of options) {
    const opt = make('option', '', o.label);
    opt.value = String(o.value);
    opt.selected = o.value === value;
    s.append(opt);
  }
  s.addEventListener('change', () => {
    const picked = options.find((o) => String(o.value) === s.value);
    if (picked) onChange(picked.value);
    renderForm();
  });
  return s;
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string): HTMLLabelElement {
  const l = make('label', 'check');
  const c = make('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.addEventListener('change', () => {
    onChange(c.checked);
    refreshForm();
  });
  l.append(c, ` ${label}`);
  if (title) l.title = title;
  return l;
}

function timeInput(schedule: Schedule): HTMLInputElement {
  const i = make('input');
  i.type = 'time';
  i.value = schedule.time;
  i.required = true;
  i.addEventListener('input', () => {
    schedule.time = i.value;
    refreshForm();
  });
  return i;
}

/** Suggestions of database or collection names, asked for once. */
function datalist(id: string, key: string, ask: () => void): HTMLDataListElement {
  const list = make('datalist');
  list.id = id;
  const known = names.get(key);
  if (known === undefined) {
    names.set(key, 'loading');
    ask();
  } else if (known !== 'loading') for (const n of known) list.append(Object.assign(make('option'), { value: n }));
  return list;
}

function connectionName(id: string): string {
  return connections.find((c) => c.id === id)?.name ?? '';
}

function setSchedule(kind: Schedule['kind']): void {
  if (!draft || draft.schedule.kind === kind) return;
  const time = draft.schedule.time || '02:00';
  draft.schedule = kind === 'hours' ? { kind, every: 6, time } : kind === 'weekly' ? { kind, days: [1], time } : { kind, time };
}

function renderForm(): void {
  const form = el<HTMLFormElement>('form');
  form.textContent = '';
  form.classList.toggle('hidden', !draft);
  if (!draft) return;
  const task = draft;
  form.append(make('h2', '', draftIsNew ? 'New Scheduled Task' : `Edit ${task.name || 'Task'}`));
  const grid = make('div', 'grid');
  form.append(grid);

  field(grid, 'Name', input(task.name, (v) => (task.name = v), { placeholder: 'e.g. Nightly backup of shop' }), undefined, 'name');

  const kinds = make('div', 'radios');
  for (const [value, label] of [['backup', 'Backup'], ['export', 'Export']] as const) {
    const l = make('label', 'check');
    const r = make('input');
    r.type = 'radio';
    r.name = 'kind';
    r.checked = task.kind === value;
    r.addEventListener('change', () => {
      task.kind = value;
      task.format = value === 'backup' ? 'archive' : 'jsonl';
      if (task.name === `Back up ${sourceName()}` || task.name === `Export ${sourceName()}`) task.name = `${value === 'backup' ? 'Back up' : 'Export'} ${sourceName()}`;
      renderForm();
    });
    l.append(r, ` ${label}`);
    kinds.append(l);
  }
  field(grid, 'Kind', kinds, task.kind === 'backup' ? 'In the mongodump formats, as Back Up… writes them: restore with Restore from Backup… or mongorestore.' : 'The documents of a collection, as Export Collection… writes them.');

  // Source
  const conn = select(
    [...(task.connectionId && !connections.some((c) => c.id === task.connectionId) ? [{ value: task.connectionId, label: '(removed connection)' }] : []), ...connections.map((c) => ({ value: c.id, label: c.name }))],
    task.connectionId,
    (v) => {
      task.connectionId = v;
      task.database = undefined;
      task.collection = undefined;
    },
  );
  field(grid, 'Connection', conn, undefined, 'connectionId');
  const dbList = datalist('databases', task.connectionId, () => post({ type: 'names', connectionId: task.connectionId }));
  const db = input(task.database ?? '', (v) => {
    task.database = v.trim() || undefined;
    if (!task.database) task.collection = undefined;
  }, { list: 'databases', placeholder: task.kind === 'backup' ? 'empty: all databases' : 'database' });
  db.addEventListener('change', () => renderForm());
  field(grid, 'Database', [db, dbList], undefined, 'database');
  const collKey = `${task.connectionId}/${task.database ?? ''}`;
  const collList = task.database ? datalist('collections', collKey, () => post({ type: 'names', connectionId: task.connectionId, database: task.database })) : make('datalist');
  collList.id = 'collections';
  const coll = input(task.collection ?? '', (v) => (task.collection = v.trim() || undefined), {
    list: 'collections',
    placeholder: task.kind === 'backup' ? 'empty: all collections of the database' : 'collection',
  });
  coll.disabled = !task.database;
  field(grid, 'Collection', [coll, collList], undefined, 'collection');

  const formats = task.kind === 'backup' ? BACKUP_FORMATS : EXPORT_FORMATS;
  field(grid, 'Format', select<string>(formats, task.format, (v) => (task.format = v as ScheduledTask['format'])), undefined, 'format');
  if (task.kind === 'export') {
    field(grid, 'Filter', input(task.filter ?? '', (v) => (task.filter = v || undefined), { placeholder: '{ status: "active" }, empty: all documents', class: 'mono' }), undefined, 'filter');
    field(grid, 'Projection', input(task.projection ?? '', (v) => (task.projection = v || undefined), { placeholder: '{ name: 1, email: 1 }, empty: all fields', class: 'mono' }), task.format === 'csv' ? "CSV has the columns of the collection's tab, as laid out there." : undefined, 'projection');
  }

  // Destination
  const folder = input(task.folder, (v) => (task.folder = v), { placeholder: 'Folder' });
  const browse = button('Browse…', 'secondary', () => post({ type: 'browse', folder: task.folder || defaultFolder }));
  const folderRow = make('div', 'inline');
  folderRow.append(folder, browse);
  field(grid, 'Folder', folderRow, undefined, 'folder');
  const preview = make('div', 'hint preview');
  preview.id = 'namePreview';
  field(grid, 'File name', [input(task.pattern, (v) => (task.pattern = v), { class: 'mono' }), preview], `Placeholders: ${PLACEHOLDER_HELP}. A number is added if the name exists.`, 'pattern');

  // Schedule
  const whenRow = make('div', 'inline');
  whenRow.append(
    select<Schedule['kind']>(
      [
        { value: 'hours', label: 'Every few hours' },
        { value: 'daily', label: 'Daily' },
        { value: 'weekly', label: 'Weekly' },
      ],
      task.schedule.kind,
      setSchedule,
    ),
  );
  const schedule = task.schedule;
  if (schedule.kind === 'hours') {
    whenRow.append(
      select(HOUR_CHOICES.map((h) => ({ value: h, label: `every ${plural(h, 'hour')}` })), schedule.every, (v) => (schedule.every = v)),
      make('span', '', 'at'),
      timeInput(schedule),
    );
  } else if (schedule.kind === 'daily') whenRow.append(make('span', '', 'at'), timeInput(schedule));
  else {
    const days = make('span', 'days');
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      days.append(
        checkbox(WEEKDAYS[d], schedule.days.includes(d), (on) => {
          schedule.days = on ? [...schedule.days, d].sort() : schedule.days.filter((x) => x !== d);
        }),
      );
    }
    whenRow.append(days,make('span', '', 'at'), timeInput(schedule));
  }
  const next = make('div', 'hint');
  next.id = 'nextPreview';
  field(grid, 'When', [whenRow, next], 'Local time. Tasks run while VS Code (any window) or the desktop app is open, in only one of them.', 'time');

  const keep = make('input');
  keep.type = 'number';
  keep.min = '0';
  keep.step = '1';
  keep.value = String(task.keep);
  keep.addEventListener('input', () => {
    task.keep = keep.value === '' ? -1 : Number(keep.value);
    refreshForm();
  });
  const keepRow = make('div', 'inline');
  keepRow.append(make('span', '', 'the last'), keep, make('span', '', task.kind === 'backup' && task.format !== 'archive' ? 'folders' : 'files'));
  field(grid, 'Keep', keepRow, 'Older ones written by this task are deleted after each successful run; nothing else in the folder is touched. 0 keeps them all.', 'keep');

  const options = make('div', 'options');
  options.append(
    checkbox('Run a missed run when Mongoster starts', task.runMissed, (v) => (task.runMissed = v), 'If VS Code or the app was closed (or the computer asleep) at the time of a run, it runs once when it is open again'),
    checkbox('Notify after successful runs too', task.notifySuccess, (v) => (task.notifySuccess = v), 'Failed and skipped runs always notify'),
    checkbox('Enabled', task.enabled, (v) => (task.enabled = v)),
  );
  field(grid, 'Options', options);

  const buttons = make('div', 'buttons');
  const save = button(draftIsNew ? 'Create Task' : 'Save', '', () => {
    const errors = taskErrors(task);
    if (Object.keys(errors).length) {
      for (const key of Object.keys(errors)) errorsShown.add(key);
      refreshForm();
      return;
    }
    post({ type: 'save', task: { ...task, name: task.name.trim(), folder: task.folder.trim(), pattern: task.pattern.trim() } });
  });
  save.id = 'save';
  buttons.append(
    save,
    button('Cancel', 'secondary', () => {
      draft = undefined;
      errorsShown.clear();
      renderForm();
    }),
  );
  form.append(buttons);
  refreshForm();
}

/** What the source is called in the default names. */
function sourceName(): string {
  if (!draft) return '';
  return draft.collection ? `${draft.database}.${draft.collection}` : draft.database ?? connectionName(draft.connectionId);
}

/** Updates the previews and the errors of the form without rebuilding it (the focus stays). */
function refreshForm(): void {
  if (!draft) return;
  const task = draft;
  const errors = taskErrors(task) as Record<string, string | undefined>;
  for (const box of document.querySelectorAll<HTMLElement>('#form .error')) {
    const key = box.dataset.key!;
    const text = errors[key] ?? (key === 'time' ? errors.days ?? errors.every : undefined);
    const shown = !!text && errorsShown.has(key) ? text : '';
    box.textContent = shown;
    box.classList.toggle('hidden', !shown);
  }
  const preview = document.getElementById('namePreview');
  if (preview) preview.textContent = errors.pattern ? '' : `e.g. ${outputName(task, new Date(), connectionName(task.connectionId) || 'connection')}`;
  const next = document.getElementById('nextPreview');
  if (next) next.textContent = errors.time || errors.days ? '' : `${describeSchedule(task.schedule)}. Next: ${nextRuns(task.schedule, Date.now(), 3).map(when).join(', ')}`;
}

document.addEventListener('focusout', (e) => {
  const target = e.target as HTMLElement;
  const key = target.closest('.control')?.querySelector<HTMLElement>('.error')?.dataset.key;
  if (key && draft) {
    errorsShown.add(key);
    refreshForm();
  }
});

// ---------------------------------------------------------------- messages

el('new').addEventListener('click', () => post({ type: 'new' }));

window.addEventListener('message', (event: MessageEvent<ScheduleHostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'init': {
      tasks = m.tasks;
      const changed = JSON.stringify(connections) !== JSON.stringify(m.connections);
      connections = m.connections;
      defaultFolder = m.defaultFolder;
      const note = el('note');
      const running = tasks.some((t) => t.task.enabled);
      note.textContent = '';
      if (m.app && running && !m.tray) {
        note.append('Tasks run while the app is open. ');
        note.append(button('Keep running in the tray', 'link', () => post({ type: 'traySetting' }), 'Setting mongoster.scheduledTasks.keepRunningInTray: closing the window keeps the app running in the system tray'));
        note.append(' when the window is closed.');
      }
      note.classList.toggle('hidden', !note.textContent);
      for (const id of [...expanded]) if (!tasks.some((t) => t.task.id === id)) expanded.delete(id);
      render();
      if (changed && draft) renderForm();
      break;
    }
    case 'edit':
      draft = structuredClone(m.task);
      draftIsNew = m.isNew;
      errorsShown.clear();
      showMessage('');
      renderForm();
      el('form').scrollIntoView({ block: 'start', inline: 'nearest' });
      el('form').querySelector<HTMLInputElement>('input')?.focus();
      break;
    case 'names':
      // Also after an error (no suggestions then): it isn't asked again.
      names.set(m.database ? `${m.connectionId}/${m.database}` : m.connectionId, m.names);
      for (const list of document.querySelectorAll<HTMLDataListElement>('#form datalist')) {
        const isDb = list.id === 'databases';
        if (isDb === !m.database && draft?.connectionId === m.connectionId && (isDb || draft?.database === m.database)) {
          list.textContent = '';
          for (const n of m.names) list.append(Object.assign(make('option'), { value: n }));
        }
      }
      break;
    case 'folder':
      if (!draft) return;
      draft.folder = m.path;
      renderForm();
      break;
    case 'saved':
      draft = undefined;
      errorsShown.clear();
      renderForm();
      break;
    case 'message':
      showMessage(m.text, m.failed);
      break;
  }
});

post({ type: 'ready' });
