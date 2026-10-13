// The tabs of the shell, in one or two groups side by side. A tab's content stays where it is in the
// DOM when its tab moves to the other group (a frame moved in the DOM would load again): only its class changes.
import type { Column, MenuAction, TabRef } from '../protocol';
import { drag, h, host, icon, iconButton, recall, remember } from './dom';

export type GroupId = 1 | 2;

export interface TabSpec extends TabRef {
  title: string;
  tooltip?: string;
  /** The URL of an image, or a codicon id. */
  icon?: { src: string } | { id: string };
  content: HTMLElement;
  /** Its tab was selected. */
  shown?(): void;
  /** Its tab was selected and should take the keyboard. */
  focus?(): void;
  /** The user asked to close it; without it the tab just closes. */
  requestClose?(): void;
  disposed?(): void;
}

export interface Tab extends TabSpec {
  group: GroupId;
  dirty: boolean;
  actions: MenuAction[];
  el: HTMLElement;
}

const editors = document.getElementById('editors')!;
const strips: Record<GroupId, HTMLElement> = { 1: document.getElementById('tabs-1')!, 2: document.getElementById('tabs-2')! };
const actionBars: Record<GroupId, HTMLElement> = { 1: document.getElementById('actions-1')!, 2: document.getElementById('actions-2')! };
const contents = document.getElementById('contents')!;

const tabs: Tab[] = [];
/** The selected tab of each group, and the tabs of each group from the last used. */
const selected: Record<GroupId, Tab | undefined> = { 1: undefined, 2: undefined };
const recent: Record<GroupId, Tab[]> = { 1: [], 2: [] };
let activeGroup: GroupId = 1;

const key = (ref: TabRef) => `${ref.kind}:${ref.id}`;
const other = (group: GroupId): GroupId => (group === 1 ? 2 : 1);
const inGroup = (group: GroupId) => tabs.filter((t) => t.group === group);

export function find(ref: TabRef): Tab | undefined {
  return tabs.find((t) => t.kind === ref.kind && t.id === ref.id);
}

export function activeTab(): Tab | undefined {
  return selected[activeGroup] ?? selected[other(activeGroup)];
}

function resolve(column: Column | undefined): GroupId {
  if (!tabs.length) return 1;
  if (column === 1 || column === 2) return column;
  if (column === 'beside') return other(activeGroup);
  return activeGroup;
}

// ---- drawing

function drawTab(tab: Tab): void {
  tab.el.replaceChildren();
  tab.el.title = tab.tooltip ?? tab.title;
  if (tab.icon) tab.el.append('src' in tab.icon ? h('img', { class: 'tab-icon', src: tab.icon.src, alt: '' }) : icon(tab.icon.id, 'tab-icon'));
  tab.el.append(h('span', { class: 'tab-title' }, tab.title));
  tab.el.classList.toggle('dirty', tab.dirty);
  tab.el.append(
    iconButton(tab.dirty ? 'circle-filled' : 'close', tab.dirty ? 'Unsaved changes — close' : 'Close (Ctrl+W)', () => requestClose(tab)),
  );
}

function drawActions(group: GroupId): void {
  const tab = selected[group];
  actionBars[group].replaceChildren(
    ...(tab?.actions ?? []).map((a) =>
      iconButton(a.icon ?? 'play', a.title, () => {
        activate(tab!, true);
        host.send({ type: 'execute', command: a.command });
      }),
    ),
  );
}

function layout(): void {
  const first = inGroup(1).length > 0;
  const second = inGroup(2).length > 0;
  editors.classList.toggle('split', first && second);
  editors.classList.toggle('only-2', !first && second);
  editors.classList.toggle('empty', !first && !second);
  for (const group of [1, 2] as GroupId[]) {
    strips[group].parentElement!.classList.toggle('active', group === activeGroup && first && second);
    for (const tab of inGroup(group)) {
      const isSelected = selected[group] === tab;
      tab.el.classList.toggle('selected', isSelected);
      tab.el.setAttribute('aria-selected', String(isSelected));
      tab.content.classList.toggle('shown', isSelected);
      tab.content.classList.toggle('in-2', group === 2);
    }
    drawActions(group);
  }
}

let reported = '';

/** Tells the host which tabs are shown and which one is active. */
function report(): void {
  const active = activeTab();
  const visible = ([1, 2] as GroupId[]).map((g) => selected[g]).filter((t): t is Tab => !!t);
  const state = JSON.stringify([active && key(active), visible.map(key)]);
  if (state === reported) return;
  reported = state;
  host.send({
    type: 'tabs',
    active: active && { kind: active.kind, id: active.id },
    visible: visible.map((t) => ({ kind: t.kind, id: t.id })),
  });
}

// ---- opening, selecting, closing

export function open(spec: TabSpec, column: Column | undefined, preserveFocus: boolean): Tab {
  const group = resolve(column);
  const el = h('div', { class: 'tab', role: 'tab', tabindex: -1 });
  const tab: Tab = { ...spec, group, dirty: false, actions: [], el };
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) activate(tab, true);
    // The middle button closes the tab; its default would start scrolling.
    if (e.button === 1) e.preventDefault();
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) requestClose(tab);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    host.send({ type: 'tabContext', tab: { kind: tab.kind, id: tab.id }, others: tabs.length > 1 });
  });
  tab.content.classList.add('content');
  tabs.push(tab);
  strips[group].append(el);
  contents.append(tab.content);
  drawTab(tab);
  // Opened beside without the focus: shown in its group, the active group stays.
  if (preserveFocus && tabs.length > 1) {
    select(tab);
    layout();
    report();
  } else activate(tab, true);
  return tab;
}

function select(tab: Tab): void {
  const changed = selected[tab.group] !== tab;
  selected[tab.group] = tab;
  recent[tab.group] = [tab, ...recent[tab.group].filter((t) => t !== tab)];
  if (changed) {
    tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    queueMicrotask(() => tab.shown?.());
  }
}

/** Selects the tab and makes its group the active one. */
export function activate(tab: Tab, focus: boolean): void {
  select(tab);
  activeGroup = tab.group;
  layout();
  report();
  if (focus) queueMicrotask(() => tab.focus?.());
}

/** The content of a tab was clicked or focused: its group becomes the active one. */
export function touched(tab: Tab): void {
  if (activeGroup === tab.group && selected[tab.group] === tab) return;
  activate(tab, false);
}

export function update(tab: Tab, changes: Partial<Pick<Tab, 'title' | 'tooltip' | 'icon' | 'dirty' | 'actions'>>): void {
  Object.assign(tab, changes);
  drawTab(tab);
  if (changes.actions) drawActions(tab.group);
}

export function requestClose(tab: Tab): void {
  if (tab.requestClose) tab.requestClose();
  else close(tab);
}

export function close(tab: Tab): void {
  const index = tabs.indexOf(tab);
  if (index === -1) return;
  tabs.splice(index, 1);
  tab.el.remove();
  tab.content.remove();
  recent[tab.group] = recent[tab.group].filter((t) => t !== tab);
  const wasActive = activeGroup === tab.group && selected[tab.group] === tab;
  if (selected[tab.group] === tab) {
    selected[tab.group] = recent[tab.group][0];
    selected[tab.group]?.shown?.();
  }
  if (!inGroup(tab.group).length && inGroup(other(tab.group)).length) activeGroup = other(tab.group);
  tab.disposed?.();
  layout();
  report();
  if (wasActive) queueMicrotask(() => activeTab()?.focus?.());
}

/** Moves the tab to the other group. */
export function move(tab: Tab): void {
  const from = tab.group;
  tab.group = other(from);
  recent[from] = recent[from].filter((t) => t !== tab);
  if (selected[from] === tab) {
    selected[from] = recent[from][0];
    selected[from]?.shown?.();
  }
  strips[tab.group].append(tab.el);
  activate(tab, true);
}

export function closeOthers(tab: Tab): void {
  for (const t of inGroup(tab.group)) if (t !== tab) requestClose(t);
}

export function closeAll(): void {
  for (const t of [...tabs]) requestClose(t);
}

/** The next (or previous) tab of the active group. */
export function cycle(step: 1 | -1): void {
  const group = inGroup(activeGroup);
  const current = selected[activeGroup];
  if (!current || group.length < 2) return;
  activate(group[(group.indexOf(current) + step + group.length) % group.length], true);
}

// ---- the sashes

const SPLIT_KEY = 'mongoster.split';
const SIDEBAR_KEY = 'mongoster.sidebar';
const sidebar = document.getElementById('sidebar')!;

function setSplit(fraction: number): void {
  editors.style.setProperty('--split', `${(Math.min(0.85, Math.max(0.15, fraction)) * 100).toFixed(2)}%`);
}

function setSidebar(width: number): void {
  sidebar.style.width = `${Math.round(Math.min(Math.max(width, 170), window.innerWidth * 0.6))}px`;
}

export function toggleSidebar(): void {
  document.body.classList.toggle('no-sidebar');
}

export function initWorkbench(): void {
  setSplit(Number(recall(SPLIT_KEY)) || 0.5);
  setSidebar(Number(recall(SIDEBAR_KEY)) || 280);

  document.getElementById('split-sash')!.addEventListener('pointerdown', (down) => {
    const box = editors.getBoundingClientRect();
    let fraction = 0.5;
    drag(
      down,
      (e) => setSplit((fraction = (e.clientX - box.left) / box.width)),
      () => remember(SPLIT_KEY, String(fraction)),
    );
  });
  document.getElementById('sidebar-sash')!.addEventListener('pointerdown', (down) => {
    drag(
      down,
      (e) => setSidebar(e.clientX),
      () => remember(SIDEBAR_KEY, String(sidebar.getBoundingClientRect().width)),
    );
  });
  // The wheel scrolls the tabs sideways.
  for (const strip of Object.values(strips)) {
    strip.addEventListener('wheel', (e) => {
      if (e.deltaY && !e.deltaX) strip.scrollLeft += e.deltaY;
    }, { passive: true });
  }
  layout();
}
