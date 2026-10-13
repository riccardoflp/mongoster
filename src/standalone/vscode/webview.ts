// vscode.window.createWebviewPanel: each panel is a tab of the shell showing a sandboxed frame. The
// frame gets what VS Code gives a webview: acquireVsCodeApi(), the theme's CSS variables, the default styles.
import * as path from 'path';
import type { Column, ThemeInfo } from '../protocol';
import { themeInfo } from '../theme';
import { Event, EventEmitter, Thenable, Uri, ViewColumn } from './base';
import { onShell, post } from './bridge';
import { themeKind } from './appearance';
import { runtime } from './runtime';

/** The protocol the app serves its own files and the webviews' documents from. */
export const APP_PROTOCOL = 'mongoster-app';
const RESOURCE_HOST = 'res';
const viewHost = (id: number) => `view-${id}`;

export interface WebviewOptions {
  enableScripts?: boolean;
  retainContextWhenHidden?: boolean;
  localResourceRoots?: readonly Uri[];
}

export class Webview {
  private content = '';
  private version = 0;
  /** The shell has been told to open the frame. */
  announced = false;
  private readonly received = new EventEmitter<any>();
  readonly onDidReceiveMessage: Event<any> = this.received.event;
  readonly cspSource = `${APP_PROTOCOL}:`;

  constructor(
    private readonly id: number,
    readonly options: WebviewOptions,
  ) {}

  get html(): string {
    return this.content;
  }

  set html(value: string) {
    this.content = value;
    this.version++;
    // Set after the frame was opened: it loads the new document.
    if (this.announced) post({ type: 'panelUpdate', id: this.id, src: this.src() });
  }

  src(): string {
    return `${APP_PROTOCOL}://${viewHost(this.id)}/index.html?v=${this.version}`;
  }

  postMessage(message: unknown): Thenable<boolean> {
    post({ type: 'panelMessage', id: this.id, message });
    return Promise.resolve(true);
  }

  /** The URL a file of the app has inside a webview; files elsewhere aren't served. */
  asWebviewUri(resource: Uri): Uri {
    const relative = path.relative(runtime().appRoot, resource.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Not a file of the app: ${resource.fsPath}`);
    return Uri.from({ scheme: APP_PROTOCOL, authority: RESOURCE_HOST, path: `/${relative.split(path.sep).join('/')}` });
  }

  receive(message: unknown): void {
    this.received.fire(message);
  }

  dispose(): void {
    this.received.dispose();
  }
}

export interface WebviewPanelOnDidChangeViewStateEvent {
  readonly webviewPanel: WebviewPanel;
}

export class WebviewPanel {
  readonly webview: Webview;
  visible = true;
  active = true;
  viewColumn: ViewColumn | undefined;
  private name: string;
  private icon: Uri | undefined;
  private disposed = false;
  private readonly disposeEmitter = new EventEmitter<void>();
  private readonly stateEmitter = new EventEmitter<WebviewPanelOnDidChangeViewStateEvent>();
  readonly onDidDispose: Event<void> = this.disposeEmitter.event;
  readonly onDidChangeViewState: Event<WebviewPanelOnDidChangeViewStateEvent> = this.stateEmitter.event;

  constructor(
    readonly id: number,
    readonly viewType: string,
    title: string,
    readonly options: WebviewOptions,
  ) {
    this.name = title;
    this.webview = new Webview(id, options);
  }

  get title(): string {
    return this.name;
  }

  set title(value: string) {
    if (value === this.name) return;
    this.name = value;
    post({ type: 'panelUpdate', id: this.id, title: value });
  }

  get iconPath(): Uri | undefined {
    return this.icon;
  }

  set iconPath(value: Uri | undefined) {
    this.icon = value;
    post({ type: 'panelUpdate', id: this.id, icon: value ? this.webview.asWebviewUri(value).toString() : '' });
  }

  reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void {
    if (this.disposed) return;
    post({ type: 'panelReveal', id: this.id, preserveFocus: !!preserveFocus });
  }

  /** The shell says whether the panel's tab is shown and has the focus. */
  shown(visible: boolean, active: boolean): void {
    if (this.visible === visible && this.active === active) return;
    this.visible = visible;
    this.active = active;
    this.stateEmitter.fire({ webviewPanel: this });
  }

  dispose(): void {
    this.close(true);
  }

  /** `tell`: false when the shell closed the tab itself. */
  close(tell: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    panels.delete(this.id);
    if (tell) post({ type: 'panelClose', id: this.id });
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.stateEmitter.dispose();
    this.webview.dispose();
  }
}

const panels = new Map<number, WebviewPanel>();
let nextPanel = 1;

const column = (c: ViewColumn | undefined): Column => (c === ViewColumn.Beside ? 'beside' : c === ViewColumn.One ? 1 : c === ViewColumn.Two ? 2 : 'active');

export function createWebviewPanel(
  viewType: string,
  title: string,
  showOptions: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
  options: WebviewOptions = {},
): WebviewPanel {
  const id = nextPanel++;
  const panel = new WebviewPanel(id, viewType, title, options);
  panels.set(id, panel);
  const show = typeof showOptions === 'object' ? showOptions : { viewColumn: showOptions, preserveFocus: false };
  panel.viewColumn = show.viewColumn;
  // The html is set right after the panel is created: the frame is opened once this turn is over.
  queueMicrotask(() => {
    if (!panels.has(id)) return;
    panel.webview.announced = true;
    post({
      type: 'panelOpen',
      id,
      title: panel.title,
      icon: panel.iconPath ? panel.webview.asWebviewUri(panel.iconPath).toString() : undefined,
      src: panel.webview.src(),
      column: column(show.viewColumn),
      preserveFocus: !!show.preserveFocus,
    });
  });
  return panel;
}

onShell('panelClosed', (m) => panels.get(m.id)?.close(false));
onShell('panelMessage', (m) => panels.get(m.id)?.webview.receive(m.message));

/** The shell says which tabs are shown and which one is active. */
export function panelsShown(visible: Set<number>, active: number | undefined): void {
  for (const panel of panels.values()) panel.shown(visible.has(panel.id), panel.id === active);
}

// ---- what the protocol handler serves

/** The id of the panel a `view-N` host names. */
export function panelOfHost(host: string): number | undefined {
  const m = /^view-(\d+)$/.exec(host);
  return m ? Number(m[1]) : undefined;
}

export function isResourceHost(host: string): boolean {
  return host === RESOURCE_HOST;
}

/** The document of a panel: its html, with the webview's environment set up before anything else runs. */
export function panelDocument(id: number): string | undefined {
  const panel = panels.get(id);
  if (!panel) return undefined;
  const html = panel.webview.html;
  // The page's policy only runs scripts carrying its nonce: the setup script takes the same one.
  const nonce = /'nonce-([^']+)'/.exec(html)?.[1] ?? '';
  const setup =
    `<link rel="stylesheet" href="${APP_PROTOCOL}://${RESOURCE_HOST}/dist/app/webview-default.css">` +
    `<script nonce="${nonce}">(${bootstrap.toString()})(${JSON.stringify(themeInfo(themeKind())).replace(/</g, '\\u003c')});</script>`;
  const head = /<head[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + setup + html.slice(head.index + head[0].length) : setup + html;
}

/**
 * Runs inside the frame, before the page's own scripts. It is serialized with toString(), so it can
 * only use what it declares itself.
 */
function bootstrap(initial: ThemeInfo): void {
  const root = document.documentElement;
  const apply = (theme: ThemeInfo) => {
    for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(`--vscode-${name}`, value);
    root.style.colorScheme = theme.kind;
    const mark = () => {
      document.body.classList.remove('vscode-dark', 'vscode-light');
      document.body.classList.add(`vscode-${theme.kind}`);
      document.body.dataset.vscodeThemeKind = `vscode-${theme.kind}`;
    };
    if (document.body) mark();
    else document.addEventListener('DOMContentLoaded', mark, { once: true });
  };
  apply(initial);

  const shell = window.parent;
  let state: unknown;
  let acquired = false;
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
    if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
    acquired = true;
    return Object.freeze({
      postMessage: (message: unknown) => shell.postMessage({ mongoster: 'message', message }, '*'),
      getState: () => state,
      setState: (value: unknown) => {
        state = value;
        return value;
      },
    });
  };

  // Registered first, so the page's listeners only see the extension's messages.
  window.addEventListener('message', (e) => {
    if (e.source !== shell) return e.stopImmediatePropagation();
    const data = e.data as { mongoster?: string; theme?: ThemeInfo } | undefined;
    if (data && data.mongoster === 'theme' && data.theme) {
      e.stopImmediatePropagation();
      apply(data.theme);
    }
  });
  // The shell can't see what happens in the frame: it is told when the frame is clicked or focused.
  window.addEventListener('focus', () => shell.postMessage({ mongoster: 'focus' }, '*'));
  window.addEventListener('pointerdown', () => shell.postMessage({ mongoster: 'focus' }, '*'), true);
  document.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link || !/^https?:/.test(link.href)) return;
    e.preventDefault();
    shell.postMessage({ mongoster: 'link', url: link.href }, '*');
  });
}
