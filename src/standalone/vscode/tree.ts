// vscode.window.createTreeView: the tree of the side bar. The shell asks for the children of the
// nodes it shows; the title actions, the inline actions and the context menu come from package.json.
import { Menu, MenuItemConstructorOptions } from 'electron';
import type { MenuAction, TreeItemData } from '../protocol';
import { themeColor } from '../theme';
import { themeKind } from './appearance';
import { Disposable, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from './base';
import { onRequest, onShell, post } from './bridge';
import { runCommand } from './commands';
import { action, commandInfo, menu } from './contributions';
import { runtime } from './runtime';

interface View {
  id: string;
  provider: TreeDataProvider<unknown>;
  /** The elements the shell knows, by the handle it names them with. */
  elements: Map<string, { element: unknown; item: TreeItem }>;
}

let view: View | undefined;

const APP_PROTOCOL = 'mongoster-app';

function iconOf(item: TreeItem): TreeItemData['icon'] {
  const icon = item.iconPath;
  if (icon instanceof ThemeIcon) return { id: icon.id, color: icon.color && themeColor(themeKind(), icon.color.id) };
  if (icon instanceof Uri) return { src: `${APP_PROTOCOL}://res${icon.path}` };
  return undefined;
}

/** The entries of a menu as a native menu, with a separator between its groups. */
export function popupMenu(entries: { command: string; group: string }[], run: (command: string) => void): void {
  const template: MenuItemConstructorOptions[] = [];
  entries.forEach((entry, i) => {
    if (i > 0 && entries[i - 1].group !== entry.group) template.push({ type: 'separator' });
    template.push({ label: commandInfo(entry.command)?.title ?? entry.command, click: () => run(entry.command) });
  });
  if (!template.length) return;
  Menu.buildFromTemplate(template).popup({ window: runtime().window() });
}

export function viewTitleActions(): MenuAction[] {
  if (!view) return [];
  return menu('view/title', { view: view.id })
    .filter((e) => e.group === 'navigation')
    .map((e) => action(e.command));
}

export function createTreeView<T>(viewId: string, options: { treeDataProvider: TreeDataProvider<T>; showCollapseAll?: boolean }): Disposable {
  const current: View = { id: viewId, provider: options.treeDataProvider as TreeDataProvider<unknown>, elements: new Map() };
  view = current;
  const subscription = current.provider.onDidChangeTreeData?.((element) => {
    if (element === undefined || element === null) return post({ type: 'treeChanged' });
    // The node may be another object than the one listed: its id finds it.
    const id = (element as TreeItem).id;
    const handle = [...current.elements].find(([key, known]) => known.element === element || (id !== undefined && key === id))?.[0];
    post({ type: 'treeChanged', handle });
  });
  post({ type: 'viewTitle', actions: viewTitleActions() });
  return new Disposable(() => {
    subscription?.dispose();
    if (view === current) view = undefined;
  });
}

onRequest('treeChildren', async ({ handle }): Promise<TreeItemData[]> => {
  const current = view;
  if (!current) return [];
  const parent = handle === undefined ? undefined : current.elements.get(handle);
  if (handle !== undefined && !parent) return [];
  const children = (await current.provider.getChildren(parent?.element)) ?? [];
  const out: TreeItemData[] = [];
  for (const [index, element] of children.entries()) {
    const item = await current.provider.getTreeItem(element);
    const childHandle = item.id ?? `${handle ?? ''}/${index}:${item.label ?? ''}`;
    current.elements.set(childHandle, { element, item });
    out.push({
      handle: childHandle,
      label: item.label ?? '',
      description: typeof item.description === 'string' ? item.description : undefined,
      tooltip: item.tooltip,
      icon: iconOf(item),
      collapsible: item.collapsibleState === TreeItemCollapsibleState.Expanded ? 2 : item.collapsibleState === TreeItemCollapsibleState.Collapsed ? 1 : 0,
      hasCommand: !!item.command,
      inline: menu('view/item/context', { view: current.id, viewItem: item.contextValue })
        .filter((e) => e.group === 'inline')
        .map((e) => action(e.command)),
    });
  }
  return out;
});

onShell('treeCommand', (m) => {
  const command = view?.elements.get(m.handle)?.item.command;
  if (command) runCommand(command.command, ...(command.arguments ?? []));
});

onShell('treeContext', (m) => {
  const known = view?.elements.get(m.handle);
  if (!view || !known) return;
  const entries = menu('view/item/context', { view: view.id, viewItem: known.item.contextValue }).filter((e) => e.group !== 'inline');
  popupMenu(entries, (command) => runCommand(command, known.element));
});

onShell('viewTitleMore', () => {
  if (!view) return;
  const entries = menu('view/title', { view: view.id }).filter((e) => e.group !== 'navigation');
  popupMenu(entries, (command) => runCommand(command));
});

onShell('execute', (m) => {
  if (m.handle === undefined) return runCommand(m.command);
  const known = view?.elements.get(m.handle);
  if (known) runCommand(m.command, known.element);
});
