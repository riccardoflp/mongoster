// "Indexes" tab: the collection's indexes with size and usage, and a form to create one.
import type { IndexInfo } from '../shared/messages';
import { toShell } from '../shared/query';
import { relativeTime } from './history';

export interface IndexesCallbacks {
  /** Resolves with an error message, or undefined on success. */
  create(keys: string, options: string): Promise<string | undefined>;
  drop(name: string): void;
  hide(name: string, hidden: boolean): void;
}

const SPECIAL_TYPES = new Set(['text', '2dsphere', '2d', 'hashed', 'columnstore']);

export class IndexesView {
  private readonly table = document.getElementById('indexTable') as HTMLTableElement;
  private readonly keys = document.getElementById('indexKeys') as HTMLInputElement;
  private readonly options = document.getElementById('indexOptions') as HTMLInputElement;
  private readonly createButton = document.getElementById('createIndex') as HTMLButtonElement;
  private readonly message = document.getElementById('indexMessage')!;

  constructor(private readonly cb: IndexesCallbacks) {
    this.createButton.addEventListener('click', () => void this.create());
    for (const input of [this.keys, this.options]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.create();
      });
      input.addEventListener('input', () => input.classList.remove('invalid'));
    }
  }

  /** Fills the form, e.g. with an index suggested by Explain. */
  prefill(keys: Record<string, unknown>): void {
    this.keys.value = toShell(keys);
    this.options.value = '';
    this.setMessage(null);
    this.keys.focus();
  }

  setLoading(): void {
    this.table.classList.add('loading');
  }

  render(indexes: IndexInfo[], error?: string): void {
    this.table.classList.remove('loading');
    this.table.replaceChildren();
    if (error) {
      this.setMessage(error, true);
      return;
    }
    const head = this.table.createTHead().insertRow();
    for (const title of ['Name', 'Keys', 'Properties', 'Size', 'Usage', '']) {
      const th = document.createElement('th');
      th.textContent = title;
      head.append(th);
    }
    const body = this.table.createTBody();
    for (const ix of indexes) {
      const tr = body.insertRow();
      tr.classList.toggle('hidden-index', !!ix.hidden);
      cell(tr, ix.name, 'ix-name');
      cell(tr, toShell(ix.key), 'ix-keys');

      const props = tr.insertCell();
      const badge = (text: string, title = '', cls = '') => {
        const b = document.createElement('span');
        b.className = `badge ${cls}`;
        b.textContent = text;
        b.title = title;
        props.append(b);
      };
      const types = Object.values(ix.key).filter((v): v is string => typeof v === 'string' && SPECIAL_TYPES.has(v));
      for (const t of new Set(types)) badge(t);
      if (ix.unique) badge('unique');
      if (ix.sparse) badge('sparse', 'Only documents that have the indexed fields');
      if (ix.expireAfterSeconds !== undefined) badge(`TTL ${formatSeconds(ix.expireAfterSeconds)}`, 'Documents expire this long after the indexed date');
      if (ix.partialFilterExpression) badge('partial', toShell(ix.partialFilterExpression));
      if (ix.collation) badge(`collation ${ix.collation}`);
      if (ix.hidden) badge('hidden', 'Not used by queries, but kept up to date', 'warn');
      if (ix.building) badge('building', 'The index build is in progress', 'warn');

      cell(tr, ix.size !== undefined ? formatBytes(ix.size) : '', 'ix-num');
      const usage = cell(tr, ix.ops === undefined ? '' : `${ix.ops.toLocaleString()} ${ix.ops === 1 ? 'use' : 'uses'}`, 'ix-num');
      if (ix.since) usage.title = `Counted since ${new Date(ix.since).toLocaleString()} (${relativeTime(Date.parse(ix.since))})`;
      if (ix.ops === 0 && ix.name !== '_id_') usage.classList.add('ix-unused');

      const actions = tr.insertCell();
      actions.className = 'ix-actions editable';
      if (ix.name !== '_id_') {
        const hide = document.createElement('button');
        hide.className = 'secondary';
        hide.textContent = ix.hidden ? 'Unhide' : 'Hide';
        hide.title = ix.hidden ? 'Let queries use this index again' : 'Stop queries from using this index without dropping it';
        hide.addEventListener('click', () => this.cb.hide(ix.name, !ix.hidden));
        const drop = document.createElement('button');
        drop.className = 'secondary danger';
        drop.textContent = 'Drop';
        drop.addEventListener('click', () => this.cb.drop(ix.name));
        actions.append(hide, drop);
      }
    }
  }

  private async create(): Promise<void> {
    if (this.createButton.disabled) return;
    if (!this.keys.value.trim()) {
      this.keys.classList.add('invalid');
      this.setMessage('Enter the fields to index, e.g. { status: 1, age: -1 }', true);
      return;
    }
    this.createButton.disabled = true;
    this.setMessage('Creating index…');
    const error = await this.cb.create(this.keys.value, this.options.value);
    this.createButton.disabled = false;
    if (error) {
      this.setMessage(error, true);
      return;
    }
    this.setMessage(null);
    this.keys.value = this.options.value = '';
  }

  private setMessage(text: string | null, error = false): void {
    this.message.textContent = text ?? '';
    this.message.classList.toggle('hidden', !text);
    this.message.classList.toggle('error', error);
    this.message.classList.toggle('info', !error);
  }
}

function cell(tr: HTMLTableRowElement, text: string, className: string): HTMLTableCellElement {
  const td = tr.insertCell();
  td.className = className;
  td.textContent = text;
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
