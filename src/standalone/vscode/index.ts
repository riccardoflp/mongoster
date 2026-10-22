// The `vscode` module of the standalone app: the part of VS Code's API that Mongoster uses, on top of
// Electron. The app's build resolves `import 'vscode'` to this file, so the extension's code runs as it is.
import * as path from 'path';
import { clipboard, shell } from 'electron';
import type { SettingField } from '../protocol';
import { activeColorTheme, onDidChangeActiveColorTheme, themeExtension } from './appearance';
import { Disposable, Event, EventEmitter, Uri } from './base';
import { onShell, post } from './bridge';
import { executeCommand, registerCommand } from './commands';
import {
  TextDocument,
  TextEditor,
  activeTextEditor,
  fileSystem,
  onDidChangeActiveTextEditor,
  onDidChangeTextDocument,
  onDidCloseTextDocument,
  onDidOpenTextDocument,
  onDidRenameFiles,
  onDidSaveTextDocument,
  openTextDocument,
  registerCodeLensProvider,
  registerCompletionItemProvider,
  registerFileSystemProvider,
  showTextDocument,
  textDocuments,
} from './documents';
import { runtime } from './runtime';
import { Memento, SecretStorage, settings } from './storage';
import { setContextKey } from './contributions';
import { createTreeView, postViewTitle } from './tree';
import {
  createOutputChannel,
  createStatusBarItem,
  setStatusBarMessage,
  showErrorMessage,
  showInformationMessage,
  showInputBox,
  showOpenDialog,
  showQuickPick,
  showSaveDialog,
  showWarningMessage,
  withProgress,
} from './ui';
import { createWebviewPanel } from './webview';

export * from './base';
export { TextDocument, TextEditor } from './documents';
export type { TextDocumentShowOptions, TextEditorEdit, TextLine } from './documents';
export { Memento, SecretStorage } from './storage';
export type { ConfigurationChangeEvent, WorkspaceConfiguration } from './storage';
export type { InputBoxOptions, MessageOptions, OutputChannel, Progress, ProgressOptions, QuickPickItem, QuickPickOptions, SaveDialogOptions, StatusBarItem } from './ui';
export { Webview, WebviewPanel } from './webview';
export type { WebviewOptions } from './webview';
export type { TreeView } from './tree';
export type { ColorTheme } from './appearance';

// ---- the extension and its context

export interface Extension<T> {
  readonly id: string;
  readonly extensionUri: Uri;
  readonly packageJSON: any;
  readonly exports?: T;
}

export interface ExtensionContext {
  readonly subscriptions: { dispose(): unknown }[];
  readonly extensionUri: Uri;
  readonly extensionPath: string;
  readonly globalState: Memento;
  readonly workspaceState: Memento;
  readonly secrets: SecretStorage;
  readonly globalStorageUri: Uri;
  readonly extension: Extension<unknown>;
}

let self: Extension<unknown> | undefined;

export function createExtensionContext(): ExtensionContext {
  const { appRoot, userData, packageJSON } = runtime();
  const extensionUri = Uri.file(appRoot);
  self = { id: `mongoster.${packageJSON.name}`, extensionUri, packageJSON };
  return {
    subscriptions: [],
    extensionUri,
    extensionPath: appRoot,
    globalState: new Memento('globalState.json'),
    workspaceState: new Memento('workspaceState.json'),
    secrets: new SecretStorage(),
    globalStorageUri: Uri.file(path.join(userData, 'globalStorage')),
    extension: self,
  };
}

const never = new EventEmitter<void>();

export const extensions = {
  get all(): readonly Extension<unknown>[] {
    return self ? [themeExtension, self] : [themeExtension];
  },
  getExtension: (id: string): Extension<unknown> | undefined => extensions.all.find((e) => e.id === id),
  onDidChange: never.event,
};

// ---- window

export interface WindowState {
  readonly focused: boolean;
}

const windowStateEmitter = new EventEmitter<WindowState>();
let focused = true;

/** The app says when its window gets or loses the focus. */
export function windowFocusChanged(value: boolean): void {
  if (focused === value) return;
  focused = value;
  windowStateEmitter.fire({ focused });
}

export const window = {
  showInformationMessage,
  showWarningMessage,
  showErrorMessage,
  showQuickPick,
  showInputBox,
  showOpenDialog,
  showSaveDialog,
  withProgress,
  setStatusBarMessage,
  createStatusBarItem,
  createOutputChannel,
  createTreeView,
  createWebviewPanel,
  showTextDocument,
  onDidChangeActiveTextEditor,
  onDidChangeActiveColorTheme,
  onDidChangeWindowState: windowStateEmitter.event as Event<WindowState>,
  get activeTextEditor(): TextEditor | undefined {
    return activeTextEditor();
  },
  get activeColorTheme() {
    return activeColorTheme;
  },
  get state(): WindowState {
    return { focused };
  },
};

// ---- workspace

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

export const workspace = {
  openTextDocument,
  registerFileSystemProvider: (scheme: string, provider: Parameters<typeof registerFileSystemProvider>[1], _options?: unknown) =>
    registerFileSystemProvider(scheme, provider),
  fs: fileSystem,
  getConfiguration: (section?: string) => settings.section(section),
  onDidChangeConfiguration: settings.onDidChange,
  onDidOpenTextDocument,
  onDidCloseTextDocument,
  onDidSaveTextDocument,
  onDidChangeTextDocument,
  onDidRenameFiles,
  get textDocuments(): readonly TextDocument[] {
    return textDocuments();
  },
  /** The app has no workspace: what would default to its folder defaults to the home folder. */
  get workspaceFolders(): readonly WorkspaceFolder[] | undefined {
    return undefined;
  },
};

// ---- commands, env, languages

export const commands = { registerCommand, executeCommand };

export const env = {
  appName: 'Mongoster',
  clipboard: {
    readText: (): Promise<string> => Promise.resolve(clipboard.readText()),
    writeText: (value: string): Promise<void> => {
      clipboard.writeText(value);
      return Promise.resolve();
    },
  },
  openExternal: async (target: Uri): Promise<boolean> => {
    if (!/^https?$/.test(target.scheme)) return false;
    await shell.openExternal(target.toString());
    return true;
  },
};

export const languages = { registerCompletionItemProvider, registerCodeLensProvider };

// ---- the settings tab

function settingFields(): SettingField[] {
  return Object.entries(settings.properties())
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
    .map(([key, p]) => ({
      key,
      type: p.type === 'boolean' ? 'boolean' : p.type === 'number' || p.type === 'integer' ? 'number' : 'string',
      description: p.markdownDescription ?? p.description ?? '',
      value: settings.value(key),
      default: p.default,
      minimum: p.minimum,
      maximum: p.maximum,
      options: p.enum,
    }));
}

export function openSettings(focus?: string): void {
  post({ type: 'settingsOpen', fields: settingFields(), focus });
}

onShell('settingChange', (m) => {
  if (!(m.key in settings.properties())) return;
  settings.set(m.key, m.value);
});

settings.onDidChange(() => {
  post({ type: 'settingsValues', values: Object.fromEntries(Object.keys(settings.properties()).map((k) => [k, settings.value(k)])) });
});

// ---- VS Code's own commands that the extension runs

/** Registers them: once, before the extension is activated. */
export function registerBuiltinCommands(): Disposable {
  return Disposable.from(
    registerCommand('revealFileInOS', (target?: Uri) => {
      if (target?.scheme === 'file') shell.showItemInFolder(target.fsPath);
    }),
    // A file is opened with the program the operating system has for it.
    registerCommand('vscode.open', async (target?: Uri) => {
      if (!target) return;
      if (target.scheme === 'file') {
        const failure = await shell.openPath(target.fsPath);
        if (failure) void showErrorMessage(`Could not open ${target.fsPath}: ${failure}`);
      } else if (/^https?$/.test(target.scheme)) await shell.openExternal(target.toString());
    }),
    registerCommand('workbench.action.openSettings', (query?: string) => openSettings(typeof query === 'string' ? query : undefined)),
    registerCommand('editor.action.triggerSuggest', () => post({ type: 'editorCommand', command: 'editor.action.triggerSuggest' })),
    registerCommand('setContext', (key: string, value: unknown) => {
      setContextKey(key, value);
      // The view's title actions are the ones whose `when` may have changed.
      postViewTitle();
    }),
  );
}
