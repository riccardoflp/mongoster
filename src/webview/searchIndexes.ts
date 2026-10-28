// "Search indexes" section of the Indexes tab: the Atlas Search and Vector Search indexes with their
// status, refreshed while one is being built; each row opens its definition and status by host.
import type { SearchIndexInfo } from '../shared/messages';
import { SEARCH_STATUS_TITLES, SEARCH_UNSUPPORTED_HELP, SearchIndexType, searchIndexCommand, searchStatusPending, searchStatusTone, summarizeSearchDefinition } from '../shared/searchIndexes';

export interface SearchIndexesCallbacks {
  reload(): void;
  /** Opens the dialog: empty, or on an existing index. */
  edit(index?: SearchIndexInfo): void;
  drop(name: string): void;
  copy(text: string): void;
  jsonTree(value: unknown): HTMLElement;
  collection(): string;
  /** The Indexes tab is the one shown. */
  active(): boolean;
}

const COLUMNS = ['', 'Name', 'Type', 'Status', 'Queryable', 'Definition', ''];
const TYPE_LABELS: Record<string, string> = { search: 'search', vectorSearch: 'vector search' };
/** While an index is being built (or right after a change), the list is read again this often. */
const POLL_MS = 5000;
/** How long after a change the list is followed, even before it shows the new status. */
const FOLLOW_MS = 30_000;

export class SearchIndexesView {
  private readonly table = document.getElementById('searchIndexTable') as HTMLTableElement;
  private readonly summary = document.getElementById('searchIndexSummary')!;
  private readonly message = document.getElementById('searchIndexMessage')!;
  private readonly create = document.getElementById('newSearchIndex') as HTMLButtonElement;
  private indexes: SearchIndexInfo[] = [];
  /** `unsupported`: the server has no search; it is asked again only with Refresh. */
  private state: 'none' | 'loading' | 'loaded' | 'unsupported' | 'error' = 'none';
  private readonly open = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private followUntil = 0;

  constructor(private readonly cb: SearchIndexesCallbacks) {
    this.create.addEventListener('click', () => this.cb.edit());
    document.getElementById('refreshSearchIndexes')!.addEventListener('click', () => this.load(true));
  }

  get list(): SearchIndexInfo[] {
    return this.indexes;
  }

  /** The list was never asked for. */
  get unread(): boolean {
    return this.state === 'none';
  }

  /** Reads the list; a server known to have no search is asked again only when `explicit` (Refresh). */
  load(explicit = false): void {
    if (this.state === 'unsupported' && !explicit) return;
    if (this.state !== 'unsupported') this.state = 'loading';
    this.table.classList.add('loading');
    this.cb.reload();
  }

  /** A change was sent: the list follows it for a while. */
  follow(): void {
    this.followUntil = Date.now() + FOLLOW_MS;
  }

  notify(text: string | null, error = false): void {
    this.message.textContent = text ?? '';
    this.message.className = !text ? 'hidden' : error ? 'error' : 'info';
  }

  render(indexes: SearchIndexInfo[], unsupported?: string, error?: string): void {
    this.table.classList.remove('loading');
    this.indexes = indexes;
    this.create.disabled = !!unsupported;
    this.create.title = unsupported ? SEARCH_UNSUPPORTED_HELP : 'Create an Atlas Search or Vector Search index';
    if (unsupported || error) {
      this.state = unsupported ? 'unsupported' : 'error';
      this.table.replaceChildren();
      this.summary.textContent = '';
      clearTimeout(this.timer);
      if (error) {
        this.notify(error, true);
        return;
      }
      // An explanation, not an error: the server's own words go below it.
      this.message.className = 'info search-unsupported';
      const detail = document.createElement('div');
      detail.className = 'search-unsupported-detail';
      detail.textContent = unsupported ?? '';
      this.message.replaceChildren(SEARCH_UNSUPPORTED_HELP, detail);
      return;
    }
    if (this.state === 'unsupported' || this.state === 'error') this.notify(null);
    this.state = 'loaded';
    this.draw();
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const busy = this.indexes.some((ix) => searchStatusPending(ix.status) || ix.hosts?.some((h) => searchStatusPending(h.status) || searchStatusPending(h.staged)));
    if (this.state !== 'loaded' || (!busy && Date.now() > this.followUntil)) return;
    this.timer = setTimeout(() => {
      if (this.cb.active() && document.visibilityState === 'visible') this.load();
      else this.schedule();
    }, POLL_MS);
  }

  private draw(): void {
    const { indexes } = this;
    const building = indexes.filter((ix) => searchStatusPending(ix.status)).length;
    const failed = indexes.filter((ix) => searchStatusTone(ix.status) === 'bad').length;
    const parts = [`${indexes.length} search ${indexes.length === 1 ? 'index' : 'indexes'}`];
    if (building) parts.push(`${building} being built`);
    if (failed) parts.push(`${failed} not working`);
    this.summary.textContent = indexes.length ? parts.join(' · ') : 'none yet: they are what $search and $vectorSearch query';

    this.table.replaceChildren();
    if (!indexes.length) return;
    const head = this.table.createTHead().insertRow();
    for (const title of COLUMNS) {
      const th = document.createElement('th');
      th.textContent = title;
      head.append(th);
    }
    for (const ix of indexes) this.table.append(this.group(ix));
  }

  private group(ix: SearchIndexInfo): HTMLTableSectionElement {
    const body = document.createElement('tbody');
    const tr = body.insertRow();
    tr.className = 'ix-row';
    const isOpen = this.open.has(ix.name);
    const toggle = cell(tr, isOpen ? '▾' : '▸', 'ix-toggle');
    toggle.title = isOpen ? 'Hide the definition' : 'Show the full definition and the status on each host';
    cell(tr, ix.name, 'ix-name');
    cell(tr, TYPE_LABELS[ix.type] ?? ix.type, 'ix-type');

    const status = tr.insertCell();
    if (ix.status) {
      const badge = text('span', ix.status, `badge search-status ${searchStatusTone(ix.status)}`);
      badge.title = [SEARCH_STATUS_TITLES[ix.status], ix.message].filter(Boolean).join('\n');
      status.append(badge);
    }
    const staged = ix.hosts?.find((h) => h.staged)?.staged;
    if (staged) {
      const badge = text('span', `new definition ${staged}`, `badge search-status ${searchStatusTone(staged)}`);
      badge.title = 'A new definition is being built: queries use the previous one until it is ready';
      status.append(badge);
    }
    const queryable = cell(tr, ix.queryable === undefined ? '' : ix.queryable ? '✓' : '✕', `search-queryable ${ix.queryable === false ? 'no' : ''}`);
    queryable.title = ix.queryable === false ? 'Queries on this index return no results yet' : ix.queryable ? 'Queries can use this index' : '';

    const summary = summarizeSearchDefinition(ix.type, ix.definition);
    const def = cell(tr, summary.join(' · '), 'ix-keys search-summary');
    def.title = summary.join('\n');

    const actions = tr.insertCell();
    actions.className = 'ix-actions editable';
    if (ix.status !== 'DELETING') {
      actions.append(
        button('Edit…', 'Change the definition of the index: it is built again in the background', () => this.cb.edit(ix)),
        button('Drop', '', () => {
          this.notify(null);
          this.cb.drop(ix.name);
        }, 'secondary danger'),
      );
    }

    tr.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (window.getSelection()?.toString()) return;
      if (!this.open.delete(ix.name)) this.open.add(ix.name);
      this.draw();
    });
    if (isOpen) body.append(this.details(ix));
    return body;
  }

  private details(ix: SearchIndexInfo): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = 'ix-detail';
    const td = tr.insertCell();
    td.colSpan = COLUMNS.length;
    const box = document.createElement('div');
    box.className = 'ix-detail-box';

    const definition = section('Definition');
    definition.append(this.cb.jsonTree(ix.definition));

    const command = section('Command');
    const code = searchIndexCommand(this.cb.collection(), ix.name, ix.type as SearchIndexType, ix.definition);
    command.firstElementChild!.append(button('Copy', 'Copy the mongosh command that creates this index', () => this.cb.copy(code)));
    command.append(text('pre', code, 'ix-command'));
    if (ix.message) {
      command.append(text('div', 'Message', 'ix-detail-title'));
      command.append(text('div', ix.message, 'ix-host'));
    }
    if (ix.hosts) {
      command.append(text('div', 'Status by host', 'ix-detail-title'));
      for (const h of ix.hosts) {
        const parts = [h.status ?? 'unknown status'];
        if (h.queryable !== undefined) parts.push(h.queryable ? 'queryable' : 'not queryable');
        if (h.staged) parts.push(`new definition ${h.staged}`);
        command.append(text('div', `${h.host}: ${parts.join(' · ')}${h.message ? ` — ${h.message}` : ''}`, 'ix-host'));
      }
    }
    box.append(definition, command);
    td.append(box);
    return tr;
  }
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
