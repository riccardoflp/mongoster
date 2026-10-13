// The tree of the side bar. The host has the data: the shell asks for the children of the nodes that
// are open, and remembers which ones are.
import type { MenuAction, TreeItemData } from '../protocol';
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

let roots: Node[] = [];
let loaded = false;
/** Opened by the user, and closed by the user among those that start open. */
const expanded = new Set<string>();
const collapsed = new Set<string>();
let selected: string | undefined;
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
    class: `row${data.handle === selected ? ' selected' : ''}`,
    role: 'treeitem',
    title: data.tooltip,
    'data-handle': data.handle,
    'aria-level': node.depth + 1,
    'aria-selected': data.handle === selected,
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
  el.append(h('span', { class: 'row-label' }, data.label));
  if (data.description) el.append(h('span', { class: 'row-description' }, data.description));
  if (data.inline.length) {
    el.append(
      h(
        'span',
        { class: 'row-actions' },
        ...data.inline.map((a) => iconButton(a.icon ?? 'circle-small', a.title, () => host.send({ type: 'execute', command: a.command, handle: data.handle }))),
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
  if (selected !== undefined && !nodes.some((n) => n.data.handle === selected)) selected = undefined;
  list.replaceChildren(...nodes.map(row));
}

function select(handle: string | undefined, reveal = false): void {
  selected = handle;
  render();
  if (reveal && handle !== undefined) list.querySelector(`[data-handle="${CSS.escape(handle)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function activateNode(node: Node): void {
  if (node.data.collapsible !== 0) toggle(node);
  if (node.data.hasCommand) host.send({ type: 'treeCommand', handle: node.data.handle });
}

// ---- the view's title

export function setTitleActions(actions: MenuAction[]): void {
  titleActions.replaceChildren(
    ...actions.map((a) => iconButton(a.icon ?? 'circle-small', a.title, () => host.send({ type: 'execute', command: a.command }))),
    iconButton('collapse-all', 'Collapse All', collapseAll),
    iconButton('ellipsis', 'More Actions…', () => host.send({ type: 'viewTitleMore' })),
  );
}

export function setWelcome(text: string, button: MenuAction | undefined): void {
  welcome.replaceChildren(h('p', {}, text));
  if (!button) return;
  const el = h('button', { class: 'button', type: 'button' }, button.title);
  el.addEventListener('click', () => host.send({ type: 'execute', command: button.command }));
  welcome.append(el);
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
    selected = node.data.handle;
    activateNode(node);
    render();
  });
  list.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const node = nodeOf(e.target);
    if (!node) return;
    select(node.data.handle);
    host.send({ type: 'treeContext', handle: node.data.handle });
  });
  list.addEventListener('keydown', (e) => {
    const nodes = visible();
    const index = nodes.findIndex((n) => n.data.handle === selected);
    const current = nodes[index];
    const go = (to: Node | undefined) => {
      if (to) select(to.data.handle, true);
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
        if (current) host.send({ type: 'treeContext', handle: current.data.handle });
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  void load(undefined);
}
