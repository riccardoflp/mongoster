// Small helpers to build the shell's DOM.
import type { ShellBridge } from '../protocol';

export const host = (window as unknown as { mongosterHost: ShellBridge }).mongosterHost;

type Attributes = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: (Node | string | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') el.className = String(value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== undefined) el.append(child);
  return el;
}

export function icon(id: string, extra = ''): HTMLElement {
  return h('span', { class: `codicon codicon-${id}${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true' });
}

/** Text with VS Code's `$(icon)` marks shown as icons. */
export function label(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(/\$\(([a-z0-9-]+)(~spin)?\)/g)) {
    if (m.index > last) out.append(text.slice(last, m.index));
    out.append(icon(m[1], m[2] ? 'spin' : ''));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.append(text.slice(last));
  return out;
}

/** The text without its `$(icon)` marks, for matching what the user types. */
export function plain(text: string): string {
  return text.replace(/\$\([a-z0-9-]+(~spin)?\)\s*/g, '');
}

/** An icon button running `run` on click. */
export function iconButton(id: string, title: string, run: (e: MouseEvent) => void): HTMLButtonElement {
  const button = h('button', { class: 'icon-button', title, 'aria-label': title, type: 'button' }, icon(id));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    run(e);
  });
  return button;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The little Markdown the settings' descriptions use: `code` and **bold**. */
export function markdown(text: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return template.content;
}

/** Follows a drag started by `down`: `move` gets the pointer's position until it is released. */
export function drag(down: PointerEvent, move: (e: PointerEvent) => void, done?: () => void): void {
  down.preventDefault();
  // The frames would swallow the pointer while it passes over them.
  document.body.classList.add('dragging');
  const stop = () => {
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    done?.();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept: the default is used next time.
  }
}

export function recall(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
