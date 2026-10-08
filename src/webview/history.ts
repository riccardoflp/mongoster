// "History" popover: recent and saved queries of the collection.
import type { QueryText, SavedQuery } from '../shared/messages';
import { pipelineToText, summarizePipeline } from '../shared/pipeline';

export interface HistoryCallbacks {
  apply(query: QueryText): void;
  save(query: QueryText): void;
  remove(id: string): void;
  clear(): void;
  current(): QueryText;
  notify(message: string): void;
}

export class HistoryPopover {
  private recent: SavedQuery[] = [];
  private saved: SavedQuery[] = [];
  private readonly panel = document.getElementById('historyPanel')!;
  private readonly button = document.getElementById('historyBtn') as HTMLButtonElement;
  private readonly search = document.getElementById('historySearch') as HTMLInputElement;
  private readonly body = document.getElementById('historyBody')!;

  constructor(private readonly cb: HistoryCallbacks) {
    this.button.addEventListener('click', () => this.toggle());
    this.search.addEventListener('input', () => this.render());
    document.getElementById('saveCurrent')!.addEventListener('click', () => {
      const q = cb.current();
      if (q.pipeline ? !q.pipeline.length : !q.filter.trim() && !q.sort.trim() && !q.projection.trim()) {
        cb.notify(q.pipeline ? 'Nothing to save: the pipeline has no stages.' : 'Nothing to save: filter, sort and projection are empty.');
      } else cb.save(q);
    });
    this.panel.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('mousedown', (e) => {
      const t = e.target as Node;
      if (this.isOpen && !this.panel.contains(t) && !this.button.contains(t)) this.toggle(false);
    });
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  update(recent: SavedQuery[], saved: SavedQuery[]): void {
    this.recent = recent;
    this.saved = saved;
    if (this.isOpen) this.render();
  }

  toggle(open = !this.isOpen): void {
    this.panel.classList.toggle('hidden', !open);
    this.button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const r = this.button.getBoundingClientRect();
    this.panel.style.top = `${r.bottom + 4}px`;
    this.search.value = '';
    this.render();
    this.search.focus();
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    const match = (e: SavedQuery) =>
      !q ||
      [e.name ?? '', e.filter, e.sort, e.projection, e.pipeline ? pipelineToText(e.pipeline) : ''].some((t) =>
        t.toLowerCase().includes(q),
      );
    const saved = this.saved.filter(match);
    const recent = this.recent.filter(match);
    this.body.replaceChildren();
    if (saved.length) this.section('Saved', saved, true);
    if (recent.length) this.section('Recent', recent, false);
    if (!saved.length && !recent.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent =
        this.saved.length || this.recent.length ? 'No queries match your search.' : 'Queries you run on this collection appear here.';
      this.body.append(empty);
    }
  }

  private section(title: string, list: SavedQuery[], saved: boolean): void {
    const head = document.createElement('div');
    head.className = 'history-section';
    head.append(text('span', title));
    if (!saved) {
      const clear = button('link', 'Clear', 'Clear the recent queries of this collection');
      clear.addEventListener('click', () => this.cb.clear());
      head.append(clear);
    }
    this.body.append(head);

    for (const entry of list) {
      const row = document.createElement('div');
      row.className = 'history-item';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const main = document.createElement('div');
      main.className = 'hi-main';
      if (entry.name) main.append(text('span', entry.name, 'hi-name'));
      main.append(preview(entry));
      row.append(main, text('span', relativeTime(entry.at), 'hi-time'));
      if (!saved) {
        const star = button('icon', '☆', 'Save with a name');
        star.addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.save(entry);
        });
        row.append(star);
      }
      const remove = button('icon', '✕', saved ? 'Delete saved query' : 'Remove from history');
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.remove(entry.id);
      });
      row.append(remove);
      row.addEventListener('click', () => this.choose(entry));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.choose(entry);
      });
      this.body.append(row);
    }
  }

  private choose(entry: SavedQuery): void {
    this.toggle(false);
    this.cb.apply(entry);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.toggle(false);
      this.button.focus();
      e.stopPropagation();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...this.body.querySelectorAll<HTMLElement>('.history-item')];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : i - 1;
    if (next < 0) this.search.focus();
    else items[next].focus();
    e.preventDefault();
  }
}

function preview(q: QueryText): HTMLElement {
  const wrap = text('span', '', 'hi-query');
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (q.pipeline) {
    wrap.append(text('span', 'aggregate ', 'hi-label'), text('span', summarizePipeline(q.pipeline), 'hi-filter'));
    wrap.title = pipelineToText(q.pipeline);
    return wrap;
  }
  wrap.append(text('span', oneLine(q.filter) || '{}', 'hi-filter'));
  if (q.sort) wrap.append(text('span', ' sort ', 'hi-label'), text('span', oneLine(q.sort)));
  if (q.projection) wrap.append(text('span', ' project ', 'hi-label'), text('span', oneLine(q.projection)));
  wrap.title = [q.filter && `filter: ${q.filter}`, q.sort && `sort: ${q.sort}`, q.projection && `project: ${q.projection}`]
    .filter(Boolean)
    .join('\n');
  return wrap;
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}

function text(tag: string, content: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}

function button(className: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.title = title;
  return b;
}
