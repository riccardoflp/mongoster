// "Indexes" tab: the collection's indexes with their properties, size and usage; each row opens its
// full definition, and the actions create, edit, duplicate, hide and drop them.
import type { IndexInfo, IndexTotals } from '../shared/messages';
import { toShell } from '../shared/query';
import { IndexSpec, KEY_TYPES, editableSpec, indexCommand, isWildcard, misspelledWildcards } from '../shared/indexes';
import { relativeTime } from './history';

export interface IndexesCallbacks {
  reload(): void;
  /** Opens the dialog: empty, on the index `original`, or on a copy of `spec`. */
  edit(spec?: IndexSpec, original?: string): void;
  drop(name: string): void;
  hide(name: string, hidden: boolean): void;
  copy(text: string): void;
  /** Renders a value as the JSON tree of the document dialog. */
  jsonTree(value: unknown): HTMLElement;
  collection(): string;
  /** The tab is the one shown. */
  active(): boolean;
}

type SortKey = 'name' | 'size' | 'ops';
const COLUMNS: { title: string; sort?: SortKey }[] = [
  { title: '' },
  { title: 'Name', sort: 'name' },
  { title: 'Keys' },
  { title: 'Properties' },
  { title: 'Size', sort: 'size' },
  { title: 'Usage', sort: 'ops' },
  { title: '' },
];
/** While an index is being built, the tab reads the indexes again this often. */
const POLL_MS = 1000;
const DAY_MS = 86_400_000;

export class IndexesView {
  private readonly table = document.getElementById('indexTable') as HTMLTableElement;
  private readonly summary = document.getElementById('indexSummary')!;
  private readonly message = document.getElementById('indexMessage')!;
  private indexes: IndexInfo[] = [];
  private totals: IndexTotals = {};
  private sort: { key: SortKey; dir: 1 | -1 } | null = null;
  private readonly open = new Set<string>();
  /** Changes sent and not answered yet: a build may be running. */
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly cb: IndexesCallbacks) {
    document.getElementById('newIndex')!.addEventListener('click', () => this.cb.edit());
    document.getElementById('refreshIndexes')!.addEventListener('click', () => {
      this.setLoading();
      this.cb.reload();
    });
  }

  get list(): IndexInfo[] {
    return this.indexes;
  }

  get documents(): number | undefined {
    return this.totals.documents;
  }

  setLoading(): void {
    this.table.classList.add('loading');
  }

  /** A change was sent (`+1`) or answered (`-1`): while one is running the list follows the build. */
  track(delta: 1 | -1): void {
    this.pending += delta;
    this.schedule();
  }

  /** The outcome of a change, below the buttons. */
  notify(text: string | null, error = false): void {
    this.message.textContent = text ?? '';
    this.message.classList.toggle('hidden', !text);
    this.message.classList.toggle('error', error);
    this.message.classList.toggle('info', !error);
  }

  render(indexes: IndexInfo[], totals: IndexTotals = {}, error?: string): void {
    this.table.classList.remove('loading');
    if (error) {
      this.table.replaceChildren();
      this.summary.textContent = '';
      this.notify(error, true);
      return;
    }
    this.indexes = indexes;
    this.totals = totals;
    this.draw();
    this.schedule();
  }

  /** A change made from the list: the outcome of the previous one no longer applies. */
  private act(change: () => void): void {
    this.notify(null);
    change();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.pending && !this.indexes.some((ix) => ix.building)) return;
    this.timer = setTimeout(() => {
      if (this.cb.active()) this.cb.reload();
      else this.schedule();
    }, POLL_MS);
  }

  private draw(): void {
    const { indexes } = this;
    this.summary.textContent = this.summaryText();
    this.table.replaceChildren();
    const head = this.table.createTHead().insertRow();
    for (const col of COLUMNS) {
      const th = document.createElement('th');
      th.textContent = col.title;
      const key = col.sort;
      if (key) {
        th.classList.add('sortable');
        th.title = 'Sort';
        if (this.sort?.key === key) {
          const mark = document.createElement('span');
          mark.className = 'sort-indicator';
          mark.textContent = this.sort.dir === 1 ? ' ▲' : ' ▼';
          th.append(mark);
        }
        th.addEventListener('click', () => {
          // Ascending, descending, then back to the order the server lists them in.
          const first = key === 'name' ? 1 : -1;
          this.sort = this.sort?.key !== key ? { key, dir: first } : this.sort.dir === first ? { key, dir: -first as 1 | -1 } : null;
          this.draw();
        });
      }
      head.append(th);
    }

    const sorted = [...indexes];
    const sort = this.sort;
    if (sort) {
      sorted.sort((a, b) => sort.dir * (sort.key === 'name' ? a.name.localeCompare(b.name) : (a[sort.key] ?? -1) - (b[sort.key] ?? -1)));
    }
    const largest = Math.max(1, ...indexes.map((ix) => ix.size ?? 0));
    for (const ix of sorted) this.table.append(this.group(ix, largest));
  }

  private summaryText(): string {
    const { indexes, totals } = this;
    const parts = [`${indexes.length} ${indexes.length === 1 ? 'index' : 'indexes'}`];
    const size = totals.indexSize ?? indexes.reduce((n, ix) => n + (ix.size ?? 0), 0);
    if (size) parts.push(`${formatBytes(size)} on disk`);
    if (totals.documents !== undefined) parts.push(`${totals.documents.toLocaleString()} ${totals.documents === 1 ? 'document' : 'documents'}`);
    const unused = indexes.filter((ix) => ix.ops === 0 && ix.name !== '_id_').length;
    if (unused) parts.push(`${unused} never used`);
    const since = indexes.map((ix) => ix.since).filter((s): s is string => !!s).sort().pop();
    if (since) parts.push(`usage counted since ${relativeTime(Date.parse(since))}`);
    return parts.join(' · ');
  }

  /** The row of an index and, when open, the one with its details. */
  private group(ix: IndexInfo, largest: number): HTMLTableSectionElement {
    const body = document.createElement('tbody');
    const tr = body.insertRow();
    tr.className = 'ix-row';
    tr.classList.toggle('hidden-index', !!ix.options.hidden);
    const spec = editableSpec(ix.name, ix.key, ix.options);
    const isOpen = this.open.has(ix.name);

    const toggle = cell(tr, isOpen ? '▾' : '▸', 'ix-toggle');
    toggle.title = isOpen ? 'Hide the definition' : 'Show the full definition';
    cell(tr, ix.name, 'ix-name');
    const keys = cell(tr, toShell(spec.keys), 'ix-keys');
    keys.title = toShell(spec.keys);
    this.badges(tr.insertCell(), ix, spec);

    const size = cell(tr, ix.size !== undefined ? formatBytes(ix.size) : '', 'ix-num ix-size');
    if (ix.size !== undefined) {
      const bar = document.createElement('div');
      bar.className = 'ix-bar';
      bar.style.width = `${Math.max(2, Math.round((ix.size / largest) * 100))}%`;
      size.append(bar);
      const total = this.totals.indexSize;
      if (total) size.title = `${Math.round((ix.size / total) * 100)}% of the size of the indexes`;
    }

    const usage = cell(tr, ix.ops === undefined ? '' : `${ix.ops.toLocaleString()} ${ix.ops === 1 ? 'use' : 'uses'}`, 'ix-num');
    if (ix.since) {
      const at = Date.parse(ix.since);
      const rate = usageRate(ix.ops ?? 0, at);
      if (rate) usage.append(text('span', ` ${rate}`, 'ix-rate'));
      usage.title = `Counted since ${new Date(at).toLocaleString()} (${relativeTime(at)})`;
    }
    if (ix.ops === 0 && ix.name !== '_id_') usage.classList.add('ix-unused');

    const actions = tr.insertCell();
    actions.className = 'ix-actions editable';
    if (ix.name !== '_id_') {
      const hidden = !!ix.options.hidden;
      actions.append(
        button('Edit…', 'Change the definition of the index', () => this.cb.edit(spec, ix.name)),
        button('Duplicate…', 'Create another index starting from this one', () => this.cb.edit({ keys: spec.keys, options: withoutName(spec.options) })),
        button(hidden ? 'Unhide' : 'Hide', hidden ? 'Let queries use this index again' : 'Stop queries from using this index without dropping it', () => this.act(() => this.cb.hide(ix.name, !hidden))),
        button('Drop', '', () => this.act(() => this.cb.drop(ix.name)), 'secondary danger'),
      );
    }

    tr.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      // Selecting text of the row isn't a click on it.
      if (window.getSelection()?.toString()) return;
      if (!this.open.delete(ix.name)) this.open.add(ix.name);
      this.draw();
    });
    if (isOpen) body.append(this.details(ix, spec));
    return body;
  }

  private badges(cell: HTMLTableCellElement, ix: IndexInfo, spec: IndexSpec): void {
    const o = ix.options;
    const badge = (label: string, title = '', cls = '') => {
      const b = text('span', label, `badge ${cls}`);
      b.title = title;
      cell.append(b);
    };
    const types = Object.values(spec.keys).filter((v): v is string => typeof v === 'string');
    for (const t of new Set(types)) badge(t, KEY_TYPES.includes(t) ? '' : 'Index type');
    if (Object.keys(spec.keys).some(isWildcard)) badge('wildcard', 'Indexes every field, or every field below the path');
    const misspelled = misspelledWildcards(spec.keys);
    if (misspelled.length) {
      badge('not a wildcard', `${misspelled.join(', ')}: the index is on a field with that very name, not on every field. A wildcard is written $** or path.$**`, 'warn');
    }
    if (o.unique) badge('unique', 'No two documents can have the same value');
    if (o.sparse) badge('sparse', 'Only documents that have the indexed fields');
    if (typeof o.expireAfterSeconds === 'number') badge(`TTL ${formatSeconds(o.expireAfterSeconds)}`, 'Documents are deleted this long after the indexed date');
    if (o.partialFilterExpression) badge('partial', `Only documents matching ${toShell(o.partialFilterExpression)}`);
    const collation = (o.collation as { locale?: unknown } | undefined)?.locale;
    if (collation) badge(`collation ${String(collation)}`, toShell(spec.options.collation));
    if (o.clustered) badge('clustered', 'The documents are stored in the order of this index');
    if (o.hidden) badge('hidden', 'Not used by queries, but kept up to date', 'warn');
    if (ix.building) {
      const p = ix.progress;
      badge(p ? `building ${Math.floor((p.done / p.total) * 100)}%` : 'building', p ? `${p.phase ?? 'Building'}: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}` : 'The index build is in progress', 'warn');
    }
  }

  private details(ix: IndexInfo, spec: IndexSpec): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = 'ix-detail';
    const td = tr.insertCell();
    td.colSpan = COLUMNS.length;
    const box = document.createElement('div');
    box.className = 'ix-detail-box';

    const definition = section('Definition');
    definition.append(this.cb.jsonTree({ name: ix.name, key: ix.key, ...ix.options }));

    const command = section('Command');
    const code = indexCommand(this.cb.collection(), spec);
    const copy = button('Copy', 'Copy the mongosh command that creates this index', () => this.cb.copy(code));
    command.firstElementChild!.append(copy);
    command.append(text('pre', code, 'ix-command'));
    if (ix.hosts) {
      command.append(text('div', 'Usage by member', 'ix-detail-title'));
      for (const h of ix.hosts) {
        const since = h.since ? ` since ${new Date(h.since).toLocaleString()}` : '';
        command.append(text('div', `${h.shard ? `${h.shard} · ` : ''}${h.host}: ${h.ops.toLocaleString()} ${h.ops === 1 ? 'use' : 'uses'}${since}`, 'ix-host'));
      }
    }
    box.append(definition, command);
    td.append(box);
    return tr;
  }
}

function withoutName(options: Record<string, unknown>): Record<string, unknown> {
  const { name: _name, ...rest } = options;
  return rest;
}

/** Uses per day since the counter started; nothing while it is too young to tell. */
function usageRate(ops: number, since: number): string {
  const days = (Date.now() - since) / DAY_MS;
  if (!ops || days < 1 / 24) return '';
  const perDay = ops / Math.max(days, 1);
  return perDay >= 1 ? `≈ ${Math.round(perDay).toLocaleString()}/day` : '< 1/day';
}

function section(title: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ix-detail-section';
  box.append(text('div', title, 'ix-detail-title'));
  return box;
}

function text(tag: string, content: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function button(label: string, title: string, onClick: () => void, className = 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function cell(tr: HTMLTableRowElement, content: string, className: string): HTMLTableCellElement {
  const td = tr.insertCell();
  td.className = className;
  td.textContent = content;
  return td;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatSeconds(s: number): string {
  if (s % 86400 === 0 && s) return `${s / 86400}d`;
  if (s % 3600 === 0 && s) return `${s / 3600}h`;
  if (s % 60 === 0 && s) return `${s / 60}m`;
  return `${s}s`;
}
