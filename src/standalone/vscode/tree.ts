// vscode.window.createTreeView: the tree of the side bar. The shell asks for the children of the
// nodes it shows; the title actions, the inline actions and the context menu come from package.json.
import { Menu, MenuItemConstructorOptions } from 'electron';
import type { MenuAction, TreeItemData } from '../protocol';
import { CancellationTokenSource, DataTransfer, Disposable, ThemeIcon, TreeDataProvider, TreeDragAndDropController, TreeItem, TreeItemCollapsibleState, Uri } from './base';
import { onRequest, onShell, post } from './bridge';
import { runCommand } from './commands';
import { action, commandInfo, keybindings, menu } from './contributions';
import { runtime } from './runtime';
import { cssColor, decorationColor } from './decorations';

interface View {
  id: string;
  provider: TreeDataProvider<unknown>;
  /** The elements the shell knows, by the handle it names them with. */
  elements: Map<string, { element: unknown; item: TreeItem }>;
  /** Shown above the tree, under the title. */
  message?: string;
  /** The handles of the selected rows, as the shell last told. */
  selection: string[];
  dragAndDrop?: TreeDragAndDropController<unknown>;
}

/** What createTreeView gives back: the message above the view's tree can be set, the selected elements read. */
export class TreeView<T = unknown> extends Disposable {
  constructor(
    private readonly current: View,
    callOnDispose: () => unknown,
  ) {
    super(callOnDispose);
  }

  get selection(): readonly T[] {
    return this.current.selection.flatMap((handle) => {
      const known = this.current.elements.get(handle);
      return known ? [known.element as T] : [];
    });
  }

  get message(): string | undefined {
    return this.current.message;
  }

  set message(value: string | undefined) {
    this.current.message = value;
    if (view === this.current) postViewTitle();
  }
}

let view: View | undefined;

const APP_PROTOCOL = 'mongoster-app';

function iconOf(item: TreeItem): TreeItemData['icon'] {
  const icon = item.iconPath;
  // The theme's variable: the color changes with the theme.
  if (icon instanceof ThemeIcon) return { id: icon.id, color: icon.color && cssColor(icon.color) };
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

export function postViewTitle(): void {
  post({ type: 'viewTitle', actions: viewTitleActions(), message: view?.message });
}

export function createTreeView<T>(viewId: string, options: { treeDataProvider: TreeDataProvider<T>; showCollapseAll?: boolean; canSelectMany?: boolean; dragAndDropController?: TreeDragAndDropController<T> }): TreeView<T> {
  const current: View = { id: viewId, provider: options.treeDataProvider as TreeDataProvider<unknown>, elements: new Map(), selection: [], dragAndDrop: options.dragAndDropController as TreeDragAndDropController<unknown> | undefined };
  view = current;
  const subscription = current.provider.onDidChangeTreeData?.((element) => {
    if (element === undefined || element === null) return post({ type: 'treeChanged' });
    // The node may be another object than the one listed: its id finds it.
    const id = (element as TreeItem).id;
    const handle = [...current.elements].find(([key, known]) => known.element === element || (id !== undefined && key === id))?.[0];
    post({ type: 'treeChanged', handle });
  });
  postViewTitle();
  return new TreeView<T>(current, () => {
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
      color: await decorationColor(item.resourceUri),
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

/**
 * The arguments of a command run on a node, as VS Code gives them: the node, and all the selected ones when it is
 * one of several selected.
 */
function nodeArguments(handle: string, handles: string[] | undefined): unknown[] | undefined {
  const known = view?.elements.get(handle);
  if (!known) return undefined;
  const selected = handles?.flatMap((h) => {
    const element = view?.elements.get(h)?.element;
    return element === undefined ? [] : [element];
  });
  return selected && selected.length > 1 ? [known.element, selected] : [known.element];
}

onShell('treeContext', (m) => {
  const known = view?.elements.get(m.handle);
  const args = nodeArguments(m.handle, m.handles);
  if (!view || !known || !args) return;
  const entries = menu('view/item/context', { view: view.id, viewItem: known.item.contextValue }).filter((e) => e.group !== 'inline');
  popupMenu(entries, (command) => runCommand(command, ...args));
});

onShell('treeSelection', (m) => {
  if (view) view.selection = m.handles;
});

/** A key of the tree runs the command bound to it for the focused view, without arguments as in VS Code. */
onShell('treeKey', (m) => {
  if (!view) return;
  const bound = keybindings({ focusedView: view.id }).find((k) => k.key === m.key);
  if (bound) runCommand(bound.command);
});

/** Rows dropped in the tree: the controller is given what was dragged, then where, as VS Code does. */
onShell('treeDrop', (m) => {
  const controller = view?.dragAndDrop;
  if (!view || !controller) return;
  const elements = m.handles.flatMap((h) => {
    const element = view?.elements.get(h)?.element;
    return element === undefined ? [] : [element];
  });
  const target = m.target === undefined ? undefined : view.elements.get(m.target)?.element;
  if (!elements.length || (m.target !== undefined && target === undefined)) return;
  const transfer = new DataTransfer();
  const token = new CancellationTokenSource().token;
  void (async () => {
    await controller.handleDrag?.(elements, transfer, token);
    await controller.handleDrop?.(target, transfer, token);
  })();
});

onShell('viewTitleMore', () => {
  if (!view) return;
  const entries = menu('view/title', { view: view.id }).filter((e) => e.group !== 'navigation');
  popupMenu(entries, (command) => runCommand(command));
});

onShell('execute', (m) => {
  if (m.handle === undefined) return runCommand(m.command);
  const args = nodeArguments(m.handle, m.handles);
  if (args) runCommand(m.command, ...args);
});
