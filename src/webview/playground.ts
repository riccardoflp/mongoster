// Playground result tab: the returned documents as a table or as mongosh text, the print() output and errors.
import type { PlaygroundHostMessage, PlaygroundViewMessage } from '../shared/messages';
import { isEjsonWrapper, isPlainObject, prettyShell, toShell } from '../shared/query';

declare function acquireVsCodeApi(): {
  postMessage(message: PlaygroundViewMessage): void;
  getState(): { view?: View } | undefined;
  setState(state: { view: View }): void;
};

type View = 'table' | 'text';
type Result = Extract<PlaygroundHostMessage, { type: 'result' }>;

const vscode = acquireVsCodeApi();
let view: View = vscode.getState()?.view ?? 'table';
let current: Result | null = null;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MAX_ROWS = 1000;
const MAX_CELL = 160;

window.addEventListener('message', (e: MessageEvent<PlaygroundHostMessage>) => {
  const m = e.data;
  if (m.type === 'running') {
    el('meta').textContent = `Running ${m.title} on ${m.target}…`;
    document.body.classList.add('running');
    return;
  }
  document.body.classList.remove('running');
  current = m;
  render();
});

function setView(v: View): void {
  view = v;
  vscode.setState({ view });
  render();
}

el('viewTable').addEventListener('click', () => setView('table'));
el('viewText').addEventListener('click', () => setView('text'));
el('copy').addEventListener('click', () => current && vscode.postMessage({ type: 'copy', text: shellText(current.value) }));
el('openJson').addEventListener('click', () => current && vscode.postMessage({ type: 'openJson', text: JSON.stringify(current.value ?? null, null, 2) }));

function shellText(v: unknown): string {
  return v === undefined ? '' : prettyShell(v, 0, 100);
}

function render(): void {
  const m = current;
  if (!m) return;
  const count = m.kind === 'documents' && Array.isArray(m.value) ? m.value.length : undefined;
  const parts = [m.target, `${m.durationMs} ms`];
  if (count !== undefined) parts.push(`${count.toLocaleString('en-US')} document${count === 1 ? '' : 's'}${m.more ? ` (first ${m.limit}; add .limit() or .toArray() for others)` : ''}`);
  el('meta').textContent = `${m.title} · ${parts.join(' · ')}`;

  const error = el('error');
  error.classList.toggle('hidden', !m.error);
  error.replaceChildren();
  if (m.error) {
    const text = document.createElement('span');
    text.textContent = m.error.message;
    error.append(text);
    if (m.error.line) {
      const go = document.createElement('button');
      go.className = 'link';
      go.textContent = `line ${m.error.line}`;
      go.title = 'Show the line in the playground';
      go.addEventListener('click', () => vscode.postMessage({ type: 'goToLine', line: m.error!.line! }));
      error.append(' ', go);
    }
  }

  el('output').classList.toggle('hidden', !m.output.length);
  el('outputText').textContent = m.output.join('\n');

  const hasValue = m.kind !== 'none' && !m.error;
  for (const id of ['copy', 'openJson', 'viewTable', 'viewText']) el<HTMLButtonElement>(id).disabled = !hasValue;
  const tableable = m.kind === 'documents';
  el<HTMLButtonElement>('viewTable').disabled ||= !tableable;
  const shown: View = tableable ? view : 'text';
  el('viewTable').setAttribute('aria-selected', String(shown === 'table'));
  el('viewText').setAttribute('aria-selected', String(shown === 'text'));

  const result = el('result');
  result.replaceChildren();
  if (!hasValue) {
    if (!m.error) result.append(note(m.output.length ? '' : 'The script ran; its last statement has no value.'));
    return;
  }
  if (shown === 'table') {
    const docs = m.value as unknown[];
    result.append(docs.length ? table(docs) : note('No documents.'));
  } else {
    const pre = document.createElement('pre');
    pre.className = 'text';
    pre.textContent = shellText(m.value);
    result.append(pre);
  }
}

function note(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  return p;
}

function table(docs: unknown[]): HTMLElement {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const doc of docs.slice(0, MAX_ROWS)) {
    if (!isPlainObject(doc)) continue;
    for (const k of Object.keys(doc)) if (!seen.has(k)) seen.add(k), keys.push(k);
  }
  if (seen.has('_id')) keys.splice(keys.indexOf('_id'), 1), keys.unshift('_id');
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  head.append(th('#'), ...keys.map(th));
  const body = t.createTBody();
  docs.slice(0, MAX_ROWS).forEach((doc, i) => {
    const row = body.insertRow();
    const num = row.insertCell();
    num.className = 'num';
    num.textContent = String(i + 1);
    for (const k of keys) {
      const cell = row.insertCell();
      if (!isPlainObject(doc) || !(k in doc)) {
        cell.className = 'missing';
        continue;
      }
      const v = doc[k];
      const text = toShell(v);
      cell.textContent = text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
      if (text.length > 40) cell.title = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      cell.className = `v-${typeName(v)}`;
    }
  });
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.append(t);
  if (docs.length > MAX_ROWS) wrap.append(note(`Showing ${MAX_ROWS} of ${docs.length} documents.`));
  return wrap;
}

function th(text: string): HTMLTableCellElement {
  const cell = document.createElement('th');
  cell.textContent = text;
  return cell;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isEjsonWrapper(v)) return Object.keys(v)[0].slice(1).toLowerCase();
  return typeof v;
}

vscode.postMessage({ type: 'ready' });
