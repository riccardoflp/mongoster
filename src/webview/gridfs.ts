// GridFS tab: the files of a bucket, with their preview, and the buttons to upload, download, open,
// rename and delete them.
import type { GridFSHostMessage, GridFSViewMessage, GridFile, GridSort } from '../shared/messages';
import { prettyShell, toShell } from '../shared/query';

interface State {
  search: string;
  sort: GridSort;
  skip: number;
}

declare function acquireVsCodeApi(): { postMessage(m: GridFSViewMessage): void; getState(): Partial<State> | undefined; setState(s: State): void };

const PAGE = 100;
const vscode = acquireVsCodeApi();
const state: State = { search: '', sort: { field: 'uploadDate', desc: true }, skip: 0, ...vscode.getState() };
const save = () => vscode.setState(state);
const post = (m: GridFSViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let readOnly = false;
let files: GridFile[] = [];
let total = 0;
let totalSize = 0;
let requestId = 0;
const expanded = new Set<string>();
const previews = new Map<string, Extract<GridFSHostMessage, { type: 'preview' }> | 'loading'>();

function size(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function date(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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

function cell(row: HTMLTableRowElement, text: string, className = '', title?: string): HTMLTableCellElement {
  const c = row.insertCell();
  c.textContent = text;
  if (className) c.className = className;
  if (title) c.title = title;
  return c;
}

function load(): void {
  post({ type: 'load', requestId: ++requestId, search: state.search, sort: state.sort, skip: state.skip, limit: PAGE });
}

function showMessage(text: string, failed = false): void {
  const box = el('message');
  box.textContent = text;
  box.classList.toggle('hidden', !text);
  box.classList.toggle('failed', failed);
}

/** Metadata other than the content type, on one line. */
function metadataText(f: GridFile): string {
  if (!f.metadata || typeof f.metadata !== 'object') return f.metadata === undefined ? '' : toShell(f.metadata);
  const rest = Object.fromEntries(Object.entries(f.metadata as Record<string, unknown>).filter(([k]) => k !== 'contentType'));
  return Object.keys(rest).length ? toShell(rest) : '';
}

const COLUMNS: { label: string; field?: GridSort['field']; className?: string }[] = [
  { label: 'name', field: 'filename' },
  { label: 'size', field: 'length', className: 'num' },
  { label: 'uploaded', field: 'uploadDate' },
  { label: 'type' },
  { label: 'metadata' },
  { label: '_id' },
  { label: '' },
];

function render(): void {
  const table = el<HTMLTableElement>('files');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label + (col.field && state.sort.field === col.field ? (state.sort.desc ? ' ▼' : ' ▲') : '');
    if (col.className) th.className = col.className;
    if (col.field) {
      const field = col.field;
      th.title = 'Sort';
      th.classList.add('sortable-th');
      th.addEventListener('click', () => {
        state.sort = { field, desc: state.sort.field === field ? !state.sort.desc : field !== 'filename' };
        state.skip = 0;
        save();
        load();
      });
    }
    head.append(th);
  }
  const body = table.createTBody();
  for (const f of files) {
    const row = body.insertRow();
    row.className = 'clickable';
    if (expanded.has(f.key)) row.classList.add('expanded');
    cell(row, f.filename, 'name', f.filename);
    cell(row, size(f.length), 'num', `${f.length.toLocaleString('en-US')} bytes · chunks of ${size(f.chunkSize)}`);
    cell(row, date(f.uploadDate), 'muted', f.uploadDate);
    cell(row, f.contentType ?? '', 'muted');
    const meta = metadataText(f);
    cell(row, meta, 'command', meta);
    cell(row, f.id, 'muted id', f.id);
    const actions = row.insertCell();
    actions.className = 'action';
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    wrap.append(
      button('Open', 'secondary small', () => post({ type: 'open', key: f.key }), 'Open the file in VS Code (a temporary copy)'),
      button('Download…', 'secondary small', () => post({ type: 'download', key: f.key }), 'Save the file to disk'),
    );
    if (!readOnly) {
      wrap.append(
        button('Rename…', 'secondary small', () => post({ type: 'rename', key: f.key })),
        button('Delete', 'secondary small', () => post({ type: 'delete', key: f.key }), 'Delete the file and its chunks'),
      );
    }
    actions.append(wrap);
    row.addEventListener('click', () => {
      if (expanded.has(f.key)) expanded.delete(f.key);
      else {
        expanded.add(f.key);
        if (!previews.has(f.key)) {
          previews.set(f.key, 'loading');
          post({ type: 'preview', key: f.key });
        }
      }
      render();
    });
    if (expanded.has(f.key)) detail(body, f);
  }
  if (!files.length) {
    const c = body.insertRow().insertCell();
    c.colSpan = COLUMNS.length;
    c.className = 'empty';
    c.textContent = state.search.trim() ? 'No file matches the filter.' : readOnly ? 'The bucket is empty.' : 'The bucket is empty: Upload… adds files.';
  }
  el('summary').textContent = total ? `${total.toLocaleString('en-US')} file${total === 1 ? '' : 's'} · ${size(totalSize)}` : '';
  const pager = total > PAGE;
  el('prev').parentElement!.classList.toggle('hidden', !pager);
  el<HTMLButtonElement>('prev').disabled = state.skip === 0;
  el<HTMLButtonElement>('next').disabled = state.skip + PAGE >= total;
  el('page').textContent = pager ? `${(state.skip + 1).toLocaleString('en-US')}–${Math.min(state.skip + PAGE, total).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : '';
}

function detail(body: HTMLTableSectionElement, f: GridFile): void {
  const row = body.insertRow();
  row.className = 'detail';
  const c = row.insertCell();
  c.colSpan = COLUMNS.length;
  const box = document.createElement('div');
  box.className = 'detail-box';
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.append(
    button(readOnly ? 'Show Document' : 'Edit Metadata', 'secondary small', () => post({ type: 'editMetadata', key: f.key }), 'Open the files document in an editor; saving it writes it back'),
    button('Copy _id', 'secondary small', () => post({ type: 'copy', text: f.id })),
    button('Copy Name', 'secondary small', () => post({ type: 'copy', text: f.filename })),
  );
  box.append(actions);
  const p = previews.get(f.key);
  const preview = document.createElement('div');
  preview.className = 'preview';
  if (!p || p === 'loading') preview.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Loading the preview…' }));
  else if (p.error) preview.append(Object.assign(document.createElement('span'), { className: p.kind ? 'muted' : 'failed', textContent: p.error }));
  else if (p.kind === 'image' && p.dataUrl) {
    const img = document.createElement('img');
    img.src = p.dataUrl;
    img.alt = f.filename;
    preview.append(img);
  } else {
    const pre = document.createElement('pre');
    pre.className = p.kind === 'binary' ? 'hex' : 'text';
    pre.textContent = p.text ?? '';
    if (p.kind === 'binary') preview.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: `Binary file${p.truncated ? ': the first 512 bytes' : ''}` }));
    preview.append(pre);
    if (p.truncated && p.kind === 'text') preview.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: `The first ${size(256 * 1024)} of ${size(f.length)}: Open shows the whole file.` }));
  }
  box.append(preview);
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Files document';
  const raw = document.createElement('pre');
  raw.textContent = prettyShell(f.raw, 0, 100);
  details.append(summary, raw);
  box.append(details);
  c.append(box);
}

window.addEventListener('message', (e: MessageEvent<GridFSHostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      readOnly = m.readOnly;
      document.body.classList.toggle('locked', readOnly);
      if (m.color) document.body.dataset.color = m.color;
      else delete document.body.dataset.color;
      el('title').replaceChildren(`${m.connectionName} › ${m.database} › `, Object.assign(document.createElement('strong'), { textContent: m.bucket }));
      if (readOnly) el('title').append(' ', Object.assign(document.createElement('span'), { className: 'badge', textContent: 'read-only', title: "The connection is read-only: files can't be uploaded, renamed or deleted" }));
      load();
      break;
    case 'files':
      if (m.requestId !== requestId) return;
      el('error').textContent = m.error ?? '';
      el('error').classList.toggle('hidden', !m.error);
      files = m.files ?? [];
      total = m.total ?? 0;
      totalSize = m.totalSize ?? 0;
      if (!files.length && state.skip > 0 && total) {
        state.skip = Math.max(0, Math.floor((total - 1) / PAGE) * PAGE);
        save();
        load();
        return;
      }
      for (const k of [...expanded]) if (!files.some((f) => f.key === k)) expanded.delete(k);
      render();
      break;
    case 'preview':
      previews.set(m.key, m);
      render();
      break;
    case 'action':
      if (m.message) showMessage(m.message, !m.ok);
      if (m.ok) {
        previews.clear();
        load();
      }
      break;
  }
});

const search = el<HTMLInputElement>('search');
search.value = state.search;
let timer: ReturnType<typeof setTimeout> | undefined;
search.addEventListener('input', () => {
  state.search = search.value;
  state.skip = 0;
  save();
  clearTimeout(timer);
  timer = setTimeout(load, 300);
});
el('refresh').addEventListener('click', () => {
  previews.clear();
  load();
});
el('upload').addEventListener('click', () => post({ type: 'upload' }));
el('prev').addEventListener('click', () => {
  state.skip = Math.max(0, state.skip - PAGE);
  save();
  load();
});
el('next').addEventListener('click', () => {
  state.skip += PAGE;
  save();
  load();
});

post({ type: 'ready' });
