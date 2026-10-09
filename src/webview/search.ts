// Global search tab: the documents with the text in any field, grouped by collection, as the
// collections are read.
import './tokenColors';
import type { SearchCollection, SearchHit, SearchHostMessage, SearchOptions, SearchProgress, SearchResult, SearchViewMessage } from '../shared/messages';

interface State {
  options: SearchOptions;
}

declare function acquireVsCodeApi(): {
  postMessage(message: SearchViewMessage): void;
  getState(): Partial<State> | undefined;
  setState(state: State): void;
};

const vscode = acquireVsCodeApi();
const DEFAULTS: SearchOptions = { text: '', mode: 'text', matchCase: false, fieldNames: false, views: false, limit: 0 };
const state: State = { options: { ...DEFAULTS, ...vscode.getState()?.options } };
const save = () => vscode.setState(state);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Group {
  info: SearchCollection;
  progress: SearchProgress;
  results: SearchResult[];
  box?: HTMLElement;
  list?: HTMLElement;
  collapsed: boolean;
  /** The search stopped before the collection was read. */
  skipped?: boolean;
}

let scope: { database?: string; collection?: string } = {};
let searchId = 0;
let running = false;
let groups: Group[] = [];
let finished: { ms: number; stopped: boolean } | undefined;
let failure = '';
/** The text of the last search, for the empty message. */
let searched = '';

const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string, words = `${word}s`) => `${fmt(n)} ${n === 1 ? word : words}`;

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

const nsOf = (c: SearchCollection) => (scope.database ? c.collection : `${c.database}.${c.collection}`);

const KIND_LABEL: Record<string, string> = { objectId: 'ObjectId', date: 'date', uuid: 'UUID', number: 'number', bool: 'boolean', regex: 'regex', code: 'code', field: 'field name' };

function hitElement(h: SearchHit): HTMLElement {
  const row = document.createElement('div');
  row.className = 'hit';
  row.append(span('path', h.path));
  const snippet = document.createElement('span');
  snippet.className = `snippet kind-${h.kind}`;
  const mark = document.createElement('mark');
  mark.textContent = h.match;
  snippet.append(h.before, mark, h.after);
  row.append(snippet);
  const kind = KIND_LABEL[h.kind];
  if (kind) row.append(span('kind', kind));
  return row;
}

function resultElement(g: Group, r: SearchResult): HTMLElement {
  const item = document.createElement('li');
  item.className = 'doc';
  item.tabIndex = 0;
  item.title = 'Open the document';
  const open = () => vscode.postMessage({ type: 'openDocument', database: g.info.database, collection: g.info.collection, view: g.info.view, id: r.id });
  item.addEventListener('click', open);
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') open();
  });
  const head = document.createElement('div');
  head.className = 'doc-head';
  head.append(span('key', r.key), button('Copy _id', 'link copy', () => vscode.postMessage({ type: 'copy', text: r.key }), 'Copy the _id'));
  item.append(head);
  for (const h of r.hits) item.append(hitElement(h));
  if (r.more) item.append(span('more-hits', `+${plural(r.more, 'more match', 'more matches')} in this document`));
  return item;
}

function groupHead(g: Group, index: number): HTMLElement {
  const head = document.createElement('div');
  head.className = 'group-head';
  const toggle = button(g.collapsed ? '▸' : '▾', 'icon toggle', () => {
    g.collapsed = !g.collapsed;
    g.box?.classList.toggle('collapsed', g.collapsed);
    toggle.textContent = g.collapsed ? '▸' : '▾';
    toggle.setAttribute('aria-expanded', String(!g.collapsed));
  });
  toggle.setAttribute('aria-expanded', String(!g.collapsed));
  toggle.setAttribute('aria-label', `Show the results of ${nsOf(g.info)}`);
  head.append(toggle, span('ns', nsOf(g.info)));
  if (g.info.view) head.append(span('badge', 'view'));
  const p = g.progress;
  if (p.matches) head.append(span('count', plural(p.matches, 'document')));
  const read = p.state === 'scanning' ? `reading… ${fmt(p.scanned)}${g.info.estimate ? ` / ${fmt(g.info.estimate)}` : ''}` : p.partial ? `first ${fmt(p.scanned)} read` : '';
  if (read) head.append(span('scan', read));
  if (p.error) {
    const error = span('group-error', p.error);
    error.title = p.error;
    head.append(error);
  }
  head.append(span('spacer', ''));
  if (p.matches) {
    head.append(
      button('Open in Collection', 'link', () => vscode.postMessage({ type: 'showInCollection', index }), `Open ${nsOf(g.info)} filtered on the matching documents (up to 1,000)`),
    );
  }
  head.addEventListener('click', () => toggle.click());
  return head;
}

/** Creates or updates the group of a collection; collections without matches or errors aren't shown. */
function renderGroup(index: number): void {
  const g = groups[index];
  if (!g.progress.matches && !g.progress.error) return;
  const results = el('results');
  if (!g.box) {
    g.box = document.createElement('div');
    g.box.className = 'group';
    g.list = document.createElement('ul');
    g.list.className = 'docs';
    g.box.append(document.createElement('div'), g.list);
    // In the order of the plan.
    const after = groups.slice(index + 1).find((x) => x.box)?.box;
    results.insertBefore(g.box, after ?? null);
  }
  g.box.classList.toggle('failed', !!g.progress.error);
  g.box.firstElementChild!.replaceWith(groupHead(g, index));
  const shown = g.list!.querySelectorAll('li.doc').length;
  for (const r of g.results.slice(shown)) g.list!.insertBefore(resultElement(g, r), g.list!.querySelector('li.more'));
  const hidden = g.progress.matches - g.results.length;
  let more = g.list!.querySelector<HTMLElement>('li.more');
  if (hidden > 0) {
    if (!more) {
      more = document.createElement('li');
      more.className = 'more';
      g.list!.append(more);
    }
    more.textContent = '';
    more.append(`+${plural(hidden, 'more document')} — `, button('Open in Collection', 'link', () => vscode.postMessage({ type: 'showInCollection', index }), 'Open the collection filtered on the matching documents (up to 1,000)'));
  } else more?.remove();
}

function renderSummary(): void {
  const done = groups.filter((g) => g.progress.state !== 'scanning' && !g.skipped).length;
  const read = groups.reduce((n, g) => n + g.progress.scanned, 0);
  const docs = groups.reduce((n, g) => n + g.progress.matches, 0);
  const withMatches = groups.filter((g) => g.progress.matches).length;
  const failed = groups.filter((g) => g.progress.error).length;
  const parts: string[] = [];
  if (running && !groups.length) parts.push('Listing the collections…');
  else if (running) parts.push(`${fmt(done)} of ${plural(groups.length, 'collection')} read`);
  else if (finished) parts.push(`${plural(groups.length, 'collection')}${finished.stopped ? ` (${fmt(done)} read)` : ''}`);
  if (groups.length) parts.push(`${plural(read, 'document')} read`);
  if (docs) parts.push(`${plural(docs, 'document')} found in ${plural(withMatches, 'collection')}`);
  if (failed) parts.push(`${fmt(failed)} not readable`);
  if (finished) parts.push(`${(finished.ms / 1000).toFixed(1)} s`);
  el('summary').textContent = parts.join(' · ');

  const status = el('status');
  status.classList.toggle('hidden', !running && !finished && !failure);
  status.dataset.state = failure ? 'error' : running ? 'scanning' : finished?.stopped ? 'stopped' : 'done';
  status.textContent = failure ? 'error' : running ? 'searching…' : finished?.stopped ? 'stopped' : 'done';
  const go = el<HTMLButtonElement>('go');
  go.textContent = running ? 'Stop' : 'Search';
  go.classList.toggle('secondary', running);

  const error = el('error');
  error.textContent = failure;
  error.classList.toggle('hidden', !failure);

  let empty = document.querySelector<HTMLElement>('.results .empty');
  const none = !running && !!finished && !docs && !failed;
  if (none) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty';
      el('results').append(empty);
    }
    empty.textContent = `No document contains “${searched}”${finished!.stopped ? ' in the collections read' : ''}.`;
  } else empty?.remove();
}

function readOptions(): SearchOptions {
  return {
    text: el<HTMLInputElement>('text').value,
    mode: el<HTMLSelectElement>('mode').value as SearchOptions['mode'],
    matchCase: el<HTMLInputElement>('matchCase').checked,
    fieldNames: el<HTMLInputElement>('fieldNames').checked,
    views: el<HTMLInputElement>('views').checked,
    limit: Number(el<HTMLSelectElement>('limit').value),
  };
}

function start(): void {
  state.options = readOptions();
  save();
  if (!state.options.text.trim()) {
    el<HTMLInputElement>('text').focus();
    return;
  }
  searchId++;
  running = true;
  finished = undefined;
  failure = '';
  searched = state.options.text.trim();
  groups = [];
  el('results').textContent = '';
  renderSummary();
  vscode.postMessage({ type: 'search', searchId, options: state.options });
}

window.addEventListener('message', (e: MessageEvent<SearchHostMessage>) => {
  const m = e.data;
  if (m.type === 'init') {
    scope = { database: m.database, collection: m.collection };
    el('title').textContent = `Search ${m.collection ? `${m.database}.${m.collection}` : (m.database ?? 'every database')} · ${m.connectionName}`;
    el('viewsOption').classList.toggle('hidden', !!m.collection);
    if (m.color) document.body.dataset.color = m.color;
    else delete document.body.dataset.color;
    return;
  }
  if (m.searchId !== searchId) return;
  switch (m.type) {
    case 'plan':
      groups = m.collections.map((info, index) => ({ info, progress: { index, state: 'scanning', scanned: 0, matches: 0, results: [] }, results: [], collapsed: false }));
      renderSummary();
      break;
    case 'progress':
      for (const u of m.updates) {
        const g = groups[u.index];
        if (!g) continue;
        g.results.push(...u.results);
        g.progress = { ...u, results: [] };
        renderGroup(u.index);
      }
      renderSummary();
      break;
    case 'done':
      running = false;
      finished = { ms: m.ms, stopped: m.stopped };
      // Stopped: the collections being read were read in part.
      groups.forEach((g, i) => {
        if (g.progress.state === 'scanning') {
          g.skipped = !g.progress.scanned;
          g.progress.state = 'done';
          g.progress.partial = m.stopped;
          renderGroup(i);
        }
      });
      renderSummary();
      break;
    case 'failed':
      running = false;
      failure = m.message;
      renderSummary();
      break;
  }
});

const text = el<HTMLInputElement>('text');
const mode = el<HTMLSelectElement>('mode');
text.value = state.options.text;
mode.value = state.options.mode;
el<HTMLInputElement>('matchCase').checked = state.options.matchCase;
el<HTMLInputElement>('fieldNames').checked = state.options.fieldNames;
el<HTMLInputElement>('views').checked = state.options.views;
el<HTMLSelectElement>('limit').value = String(state.options.limit);
const syncPlaceholder = () => {
  text.placeholder = mode.value === 'regex' ? '^mario|rossi$  or  /^ma/i  —  Enter searches' : 'Text, _id, number or date to find in any field  —  Enter searches';
};
syncPlaceholder();
mode.addEventListener('change', syncPlaceholder);
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    start();
  } else if (e.key === 'Escape' && running) vscode.postMessage({ type: 'stop' });
});
el('go').addEventListener('click', () => (running ? vscode.postMessage({ type: 'stop' }) : start()));
for (const id of ['mode', 'matchCase', 'fieldNames', 'views', 'limit']) {
  el(id).addEventListener('change', () => {
    state.options = readOptions();
    save();
  });
}
text.focus();
renderSummary();
vscode.postMessage({ type: 'ready' });
