// The webview panels: each one is a tab holding a sandboxed frame, on its own origin, that talks to
// the host through the shell.
import type { Column, ThemeInfo } from '../protocol';
import { h, host } from './dom';
import { Tab, activate, close, find, open, touched, update } from './workbench';

interface Panel {
  tab: Tab;
  frame: HTMLIFrameElement;
  /** The frame's document is loaded: messages sent before are kept for it. */
  loaded: boolean;
  queue: unknown[];
}

const panels = new Map<number, Panel>();

const tabIcon = (src: string | undefined) => (src ? { src } : undefined);

export function openPanel(id: number, title: string, icon: string | undefined, src: string, column: Column, preserveFocus: boolean): void {
  const frame = h('iframe', {
    class: 'webview',
    src,
    title,
    // Scripts on the frame's own origin: it can't reach the shell or the other panels.
    sandbox: 'allow-scripts allow-same-origin allow-forms',
  });
  const panel: Panel = { tab: undefined as unknown as Tab, frame, loaded: false, queue: [] };
  frame.addEventListener('load', () => {
    panel.loaded = true;
    for (const message of panel.queue.splice(0)) frame.contentWindow?.postMessage(message, '*');
  });
  panels.set(id, panel);
  panel.tab = open(
    {
      kind: 'panel',
      id,
      title,
      icon: tabIcon(icon),
      content: h('div', {}, frame),
      focus: () => frame.contentWindow?.focus(),
      requestClose: () => {
        close(panel.tab);
        host.send({ type: 'panelClosed', id });
      },
      disposed: () => panels.delete(id),
    },
    column,
    preserveFocus,
  );
}

export function updatePanel(id: number, changes: { title?: string; icon?: string; src?: string }): void {
  const panel = panels.get(id);
  if (!panel) return;
  if (changes.title !== undefined) {
    panel.frame.title = changes.title;
    update(panel.tab, { title: changes.title });
  }
  if (changes.icon !== undefined) update(panel.tab, { icon: tabIcon(changes.icon) });
  if (changes.src !== undefined) {
    panel.loaded = false;
    panel.frame.src = changes.src;
  }
}

export function revealPanel(id: number, preserveFocus: boolean): void {
  const panel = panels.get(id);
  if (panel) activate(panel.tab, !preserveFocus);
}

export function closePanel(id: number): void {
  const tab = find({ kind: 'panel', id });
  if (tab) close(tab);
}

export function postToPanel(id: number, message: unknown): void {
  const panel = panels.get(id);
  if (!panel) return;
  if (panel.loaded) panel.frame.contentWindow?.postMessage(message, '*');
  else panel.queue.push(message);
}

export function themePanels(theme: ThemeInfo): void {
  for (const panel of panels.values()) panel.frame.contentWindow?.postMessage({ mongoster: 'theme', theme }, '*');
}

export function initPanels(): void {
  window.addEventListener('message', (e) => {
    const entry = [...panels].find(([, p]) => p.frame.contentWindow === e.source);
    if (!entry) return;
    const [id, panel] = entry;
    const data = e.data as { mongoster?: string; message?: unknown; url?: string } | undefined;
    if (data?.mongoster === 'message') host.send({ type: 'panelMessage', id, message: data.message });
    else if (data?.mongoster === 'focus') touched(panel.tab);
    else if (data?.mongoster === 'link' && typeof data.url === 'string') host.send({ type: 'openExternal', url: data.url });
  });
}
