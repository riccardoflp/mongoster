// The color of a connection wherever something of that connection is shown: the icon of its tabs, the
// names of the tabs of its documents and playgrounds, its node in the tree and the icons below it.
import * as vscode from 'vscode';
import type { ConnectionColor, ConnectionManager } from './connections';

/** The scheme of the URI a connection's tree node carries, so that its name takes the connection's color. */
export const CONNECTION_SCHEME = 'mongoster-connection';

export function connectionUri(connectionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CONNECTION_SCHEME, path: `/${connectionId}` });
}

/** The theme color of a connection color: the same one the icons in the tree take. */
export function themeColorOf(color: ConnectionColor): vscode.ThemeColor {
  return new vscode.ThemeColor(`charts.${color}`);
}

/** The icon of a connection's tabs: Mongoster's leaf in the connection's color, or `fallback` without a color. */
export function tabIcon(extensionUri: vscode.Uri, color: ConnectionColor | undefined, fallback = 'mongoster.svg'): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
  if (!color) return vscode.Uri.joinPath(extensionUri, 'media', fallback);
  const icon = (kind: 'light' | 'dark') => vscode.Uri.joinPath(extensionUri, 'media', 'connection', `${color}-${kind}.svg`);
  return { light: icon('light'), dark: icon('dark') };
}

/**
 * Gives a tab of a connection the connection's color: its icon, and in the desktop app a line above the
 * tab too (`tabColor` is the app's own: VS Code has nothing like it and doesn't look at it).
 */
export function paintTab(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, color: ConnectionColor | undefined, fallback?: string): void {
  panel.iconPath = tabIcon(extensionUri, color, fallback);
  (panel as { tabColor?: vscode.ThemeColor }).tabColor = color ? themeColorOf(color) : undefined;
}

/** Something else whose files belong to a connection, such as a playground and the connection it runs on. */
export interface ConnectionOfFiles {
  connectionOf(uri: vscode.Uri): string | undefined;
  readonly onDidChange: vscode.Event<vscode.Uri | undefined>;
}

/**
 * Colors the names of what belongs to a colored connection: its tree node, the tabs of its documents and
 * definitions (their URIs name the connection) and of the playgrounds running on it.
 */
export class ConnectionDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  /** The names and colors decorated last: connecting and disconnecting change nothing here. */
  private shown = '';

  constructor(
    private readonly connections: ConnectionManager,
    /** The schemes whose URIs have the connection's id as authority. */
    private readonly schemes: string[],
    private readonly others: ConnectionOfFiles[] = [],
  ) {
    this.shown = this.signature();
    this.disposables.push(
      connections.onDidChange(() => {
        const now = this.signature();
        if (now === this.shown) return;
        this.shown = now;
        this.changed.fire(undefined);
      }),
      ...others.map((o) => o.onDidChange((uri) => this.changed.fire(uri))),
    );
  }

  private signature(): string {
    return JSON.stringify(this.connections.list().map((c) => [c.id, c.name, c.color]));
  }

  connectionOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme === CONNECTION_SCHEME) return uri.path.slice(1);
    if (this.schemes.includes(uri.scheme)) return uri.authority;
    for (const other of this.others) {
      const id = other.connectionOf(uri);
      if (id) return id;
    }
    return undefined;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const id = this.connectionOf(uri);
    const info = id ? this.connections.get(id) : undefined;
    if (!info?.color) return undefined;
    return new vscode.FileDecoration(undefined, info.name, themeColorOf(info.color));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
