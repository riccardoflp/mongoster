// The tree of the side bar. The host has the data: the shell asks for the children of the nodes that
// are open, and remembers which ones are.
import type { MenuAction, TreeItemData, Welcome } from '../protocol';
import { typeAheadTarget, typedText } from '../../shared/typeAhead';
import { h, host, icon, iconButton } from './dom';

interface Node {
  data: TreeItemData;
  parent: Node | undefined;
  depth: number;
  children: Node[] | undefined;
  loading: boolean;
}

const list = document.getElementById('tree')!;
const welcome = document.getElementById('welcome')!;
const titleActions = document.getElementById('view-actions')!;
const viewMessage = document.getElementById('view-message')!;
/** The welcome's choice of color theme, once the host has said what the themes are. */
let themeSelect: HTMLSelectElement | undefined;

let roots: Node[] = [];
let loaded = false;
/** Opened by the user, and closed by the user among those that start open. */
const expanded = new Set<string>();
const collapsed = new Set<string>();
/** The row the keys move from: the last one clicked or moved to. */
let focused: string | undefined;
/** The rows selected: the focused one, or several with Ctrl and Shift. Commands from a menu act on all of them. */
const selection = new Set<string>();
/** Where Shift+click and Shift+arrow select from. */
let anchor: string | undefined;
/** The letters of the type-ahead, and when the last one was typed. */
let typed = '';
let typedAt = 0;
/** Each load of a node's children has a number: only the last one asked is kept. */
const loads = new Map<string, number>();
let nextLoad = 1;

const isOpen = (node: Node) => node.data.collapsible !== 0 && (expanded.has(node.data.handle) || (node.data.collapsible === 2 && !collapsed.has(node.data.handle)));

function visible(): Node[] {
  const out: Node[] = [];
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      out.push(node);
      if (isOpen(node) && node.children) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

function findNode(handle: string, nodes: Node[] = roots): Node | undefined {
  for (const node of nodes) {
    if (node.data.handle === handle) return node;
    const found = node.children && findNode(handle, node.children);
    if (found) return found;
  }
  return undefined;
}

// ---- loading

async function load(parent: Node | undefined): Promise<void> {
  const handle = parent?.data.handle;
  const loadKey = handle ?? '';
  const run = nextLoad++;
  loads.set(loadKey, run);
  if (parent) parent.loading = true;
  let items: TreeItemData[];
  try {
    items = await host.request('treeChildren', { handle });
  } catch {
    items = [];
  }
  if (loads.get(loadKey) !== run) return;
  if (parent) parent.loading = false;
  const previous = parent ? parent.children : roots;
  const children = items.map((data): Node => {
    // The children already shown stay until theirs are loaded again: the tree doesn't blink on a refresh.
    const before = previous?.find((n) => n.data.handle === data.handle);
    return { data, parent, depth: parent ? parent.depth + 1 : 0, children: before?.children, loading: false };
  });
  if (parent) parent.children = children;
  else {
    roots = children;
    loaded = true;
  }
  render();
  await Promise.all(children.filter(isOpen).map((child) => load(child)));
}

/** The host says the tree changed, all of it or under a node. */
export function treeChanged(handle?: string): void {
  const node = handle === undefined ? undefined : findNode(handle);
  // A node that isn't shown has nothing to reload; an unknown one means its parents changed.
  if (handle !== undefined && node && !isOpen(node)) {
    node.children = undefined;
    return;
  }
  void load(handle === undefined ? undefined : node);
}

function toggle(node: Node, open = !isOpen(node)): void {
  const handle = node.data.handle;
  if (open) {
    expanded.add(handle);
    collapsed.delete(handle);
    if (!node.children) void load(node);
  } else {
    expanded.delete(handle);
    collapsed.add(handle);
    // Closing a node forgets what was under it, so opening it again shows what is there now.
    loads.delete(handle);
    node.loading = false;
    node.children = undefined;
  }
  render();
}

export function collapseAll(): void {
  for (const node of visible()) {
    if (node.data.collapsible === 0) continue;
    expanded.delete(node.data.handle);
    collapsed.add(node.data.handle);
    node.children = undefined;
  }
  render();
}

// ---- drawing

function row(node: Node): HTMLElement {
  const { data } = node;
  const open = isOpen(node);
  const el = h('div', {
    class: `row${selection.has(data.handle) ? ' selected' : ''}${data.handle === focused ? ' focused' : ''}`,
    role: 'treeitem',
    title: data.tooltip,
    'data-handle': data.handle,
    'aria-level': node.depth + 1,
    'aria-selected': selection.has(data.handle),
    'aria-expanded': data.collapsible === 0 ? undefined : String(open),
    style: `--depth: ${node.depth}`,
  });
  el.append(
    data.collapsible === 0
      ? h('span', { class: 'twisty' })
      : node.loading
        ? icon('loading', 'twisty spin')
        : icon(open ? 'chevron-down' : 'chevron-right', 'twisty'),
  );
  if (data.icon) {
    if ('src' in data.icon) el.append(h('img', { class: 'row-icon', src: data.icon.src, alt: '' }));
    else {
      const glyph = icon(data.icon.id, 'row-icon');
      if (data.icon.color) glyph.style.color = data.icon.color;
      el.append(glyph);
    }
  }
  const name = h('span', { class: 'row-label' }, data.label);
  if (data.color) name.style.setProperty('--label-color', data.color);
  el.append(name);
  if (data.description) el.append(h('span', { class: 'row-description' }, data.description));
  if (data.inline.length) {
    el.append(
      h(
        'span',
        { class: 'row-actions' },
        ...data.inline.map((a) =>
          iconButton(a.icon ?? 'circle-small', a.title, () => host.send({ type: 'execute', command: a.command, handle: data.handle, handles: selectedWith(data.handle) })),
        ),
      ),
    );
  }
  return el;
}

function render(): void {
  const empty = loaded && !roots.length;
  welcome.hidden = !empty;
  list.hidden = empty;
  const nodes = visible();
  const shown = new Set(nodes.map((n) => n.data.handle));
  if (focused !== undefined && !shown.has(focused)) focused = undefined;
  for (const handle of selection) if (!shown.has(handle)) selection.delete(handle);
  list.replaceChildren(...nodes.map(row));
}

/**
 * Moves to a row: selecting it alone, adding or removing it (`toggle`, Ctrl+click), or selecting from the anchor to it
 * (`range`, Shift+click and Shift+arrow).
 */
function select(handle: string | undefined, reveal = false, how: 'only' | 'toggle' | 'range' = 'only'): void {
  focused = handle;
  if (handle === undefined) selection.clear();
  else if (how === 'toggle') {
    if (!selection.delete(handle)) selection.add(handle);
    anchor = handle;
  } else if (how === 'range') {
    const handles = visible().map((n) => n.data.handle);
    const from = handles.indexOf(anchor ?? handle);
    const to = handles.indexOf(handle);
    selection.clear();
    for (const h of handles.slice(Math.min(from < 0 ? to : from, to), Math.max(from, to) + 1)) selection.add(h);
  } else {
    selection.clear();
    selection.add(handle);
    anchor = handle;
  }
  render();
  if (reveal && handle !== undefined) list.querySelector(`[data-handle="${CSS.escape(handle)}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** The selected rows, in the tree's order, when `handle` is one of several selected: what a command then acts on. */
function selectedWith(handle: string): string[] | undefined {
  if (selection.size < 2 || !selection.has(handle)) return undefined;
  return visible()
    .map((n) => n.data.handle)
    .filter((h) => selection.has(h));
}

/** A letter typed in the tree: the next row whose name starts with it (`typeAheadTarget`). */
function typeAhead(key: string): void {
  const now = Date.now();
  typed = typedText(typed, key, now - typedAt);
  typedAt = now;
  const nodes = visible();
  const index = typeAheadTarget(
    nodes.map((n) => n.data.label),
    nodes.findIndex((n) => n.data.handle === focused),
    typed,
  );
  if (index >= 0) select(nodes[index].data.handle, true);
}

function activateNode(node: Node): void {
  if (node.data.collapsible !== 0) toggle(node);
  if (node.data.hasCommand) host.send({ type: 'treeCommand', handle: node.data.handle });
}

// ---- the view's title

export function setTitleActions(actions: MenuAction[], message: string | undefined): void {
  viewMessage.textContent = message ?? '';
  viewMessage.title = message ?? '';
  viewMessage.hidden = !message;
  titleActions.replaceChildren(
    ...actions.map((a) => iconButton(a.icon ?? 'circle-small', a.title, () => host.send({ type: 'execute', command: a.command }))),
    iconButton('collapse-all', 'Collapse All', collapseAll),
    iconButton('ellipsis', 'More Actions…', () => host.send({ type: 'viewTitleMore' })),
  );
}

/**
 * The first thing a new user sees: how to add a connection, and the color theme, chosen here before any
 * tab is open. The theme is the `app.theme` setting, as in `View › Theme` and the Settings tab.
 */
export function setWelcome(w: Welcome): void {
  welcome.replaceChildren(h('p', {}, w.text));
  if (w.button) {
    const { command, title } = w.button;
    const el = h('button', { class: 'button', type: 'button' }, title);
    el.addEventListener('click', () => host.send({ type: 'execute', command }));
    welcome.append(el);
  }
  if (!w.themes.length) return;
  const group = (kind: string, label: string) =>
    h('optgroup', { label }, ...w.themes.filter((t) => t.kind === kind).map((t) => h('option', { value: t.id }, t.label)));
  themeSelect = h('select', { id: 'welcome-theme' }, h('option', { value: 'system' }, 'Follow the System'), group('dark', 'Dark'), group('light', 'Light'));
  themeSelect.value = w.theme;
  themeSelect.addEventListener('change', () => host.send({ type: 'settingChange', key: 'app.theme', value: themeSelect!.value }));
  welcome.append(h('div', { class: 'welcome-theme' }, h('label', { for: 'welcome-theme' }, 'Color theme'), themeSelect));
}

/** The theme was changed elsewhere (the menu, the Settings tab): the welcome shows it. */
export function welcomeTheme(value: unknown): void {
  if (themeSelect && typeof value === 'string') themeSelect.value = value;
}

export function focusTree(): void {
  list.focus();
}

export function initTree(): void {
  const nodeOf = (target: EventTarget | null) => {
    const handle = (target as Element | null)?.closest<HTMLElement>('.row')?.dataset.handle;
    return handle === undefined ? undefined : findNode(handle);
  };
  list.addEventListener('click', (e) => {
    const node = nodeOf(e.target);
    if (!node) return;
    // Ctrl (Cmd on macOS) and Shift change the selection without opening anything.
    if (e.ctrlKey || e.metaKey) return select(node.data.handle, false, 'toggle');
    if (e.shiftKey) return select(node.data.handle, false, 'range');
    select(node.data.handle);
    activateNode(node);
  });
  list.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const node = nodeOf(e.target);
    if (!node) return;
    // Right-clicking one of the selected rows keeps the selection, as in VS Code: the menu's command acts on them all.
    if (selection.has(node.data.handle)) focused = node.data.handle;
    else select(node.data.handle);
    render();
    host.send({ type: 'treeContext', handle: node.data.handle, handles: selectedWith(node.data.handle) });
  });
  list.addEventListener('keydown', (e) => {
    const nodes = visible();
    const index = nodes.findIndex((n) => n.data.handle === focused);
    const current = nodes[index];
    const go = (to: Node | undefined) => {
      if (to) select(to.data.handle, true, e.shiftKey ? 'range' : 'only');
    };
    switch (e.key) {
      case 'ArrowDown':
        go(nodes[Math.min(index + 1, nodes.length - 1)]);
        break;
      case 'ArrowUp':
        go(nodes[Math.max(index - 1, 0)]);
        break;
      case 'Home':
        go(nodes[0]);
        break;
      case 'End':
        go(nodes[nodes.length - 1]);
        break;
      case 'ArrowRight':
        if (!current || current.data.collapsible === 0) return;
        if (!isOpen(current)) toggle(current, true);
        else go(current.children?.[0]);
        break;
      case 'ArrowLeft':
        if (!current) return;
        if (isOpen(current)) toggle(current, false);
        else go(current.parent);
        break;
      case 'Enter':
      case ' ':
        if (current) activateNode(current);
        break;
      case 'ContextMenu':
        if (current) host.send({ type: 'treeContext', handle: current.data.handle, handles: selectedWith(current.data.handle) });
        break;
      case 'Escape':
        if (current) select(current.data.handle);
        break;
      default:
        // A letter or a digit moves to the next row whose name starts with it; with Ctrl, Alt or Cmd it's a shortcut.
        if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.metaKey || e.altKey) return;
        typeAhead(e.key);
    }
    e.preventDefault();
  });
  void load(undefined);
}
