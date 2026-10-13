// vscode.window's dialogs and indicators: messages, quick picks, input boxes, file dialogs, progress,
// the status bar and the output channels. The shell draws them; the native file dialogs are Electron's.
import { dialog, FileFilter, OpenDialogOptions } from 'electron';
import type { QuickPickEntry, Severity, StatusItem } from '../protocol';
import { CancellationToken, CancellationTokenSource, Disposable, ProgressLocation, QuickPickItemKind, StatusBarAlignment, Thenable, Uri } from './base';
import { onShell, post } from './bridge';
import { runtime } from './runtime';

let nextId = 1;

// ---- messages

export interface MessageOptions {
  modal?: boolean;
  detail?: string;
}

const pendingMessages = new Map<number, (action: string | undefined) => void>();

onShell('notifyResult', (m) => {
  pendingMessages.get(m.id)?.(m.action);
  pendingMessages.delete(m.id);
});

function showMessage<T extends string>(severity: Severity, message: string, rest: (T | MessageOptions)[]): Promise<T | undefined> {
  const options = typeof rest[0] === 'object' ? (rest[0] as MessageOptions) : {};
  const actions = rest.filter((r): r is T => typeof r === 'string');
  const id = nextId++;
  return new Promise((resolve) => {
    pendingMessages.set(id, (action) => resolve(action as T | undefined));
    post({ type: 'notify', id, severity, message, detail: options.detail, modal: !!options.modal, actions });
  });
}

export function showInformationMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showInformationMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showInformationMessage<T extends string>(message: string, ...rest: (T | MessageOptions)[]): Thenable<T | undefined> {
  return showMessage('info', message, rest);
}

export function showWarningMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showWarningMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showWarningMessage<T extends string>(message: string, ...rest: (T | MessageOptions)[]): Thenable<T | undefined> {
  return showMessage('warning', message, rest);
}

export function showErrorMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
export function showErrorMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
export function showErrorMessage<T extends string>(message: string, ...rest: (T | MessageOptions)[]): Thenable<T | undefined> {
  return showMessage('error', message, rest);
}

// ---- quick pick

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  kind?: QuickPickItemKind;
  alwaysShow?: boolean;
}

export interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
  canPickMany?: boolean;
  ignoreFocusOut?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
}

const pendingPicks = new Map<number, (picked: number[] | undefined) => void>();

onShell('quickPickResult', (m) => {
  pendingPicks.get(m.id)?.(m.picked);
  pendingPicks.delete(m.id);
});

export function showQuickPick(items: readonly string[] | Thenable<readonly string[]>, options: QuickPickOptions & { canPickMany: true }, token?: CancellationToken): Thenable<string[] | undefined>;
export function showQuickPick(items: readonly string[] | Thenable<readonly string[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<string | undefined>;
export function showQuickPick<T extends QuickPickItem>(items: readonly T[] | Thenable<readonly T[]>, options: QuickPickOptions & { canPickMany: true }, token?: CancellationToken): Thenable<T[] | undefined>;
export function showQuickPick<T extends QuickPickItem>(items: readonly T[] | Thenable<readonly T[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<T | undefined>;
export async function showQuickPick(
  given: readonly (string | QuickPickItem)[] | Thenable<readonly (string | QuickPickItem)[]>,
  options: QuickPickOptions = {},
  _token?: CancellationToken,
): Promise<any> {
  const items = await given;
  const entries: QuickPickEntry[] = items.map((item) =>
    typeof item === 'string'
      ? { label: item }
      : { label: item.label, description: item.description, detail: item.detail, picked: item.picked, separator: item.kind === QuickPickItemKind.Separator },
  );
  const id = nextId++;
  const picked = await new Promise<number[] | undefined>((resolve) => {
    pendingPicks.set(id, resolve);
    post({
      type: 'quickPick',
      id,
      items: entries,
      title: options.title,
      placeHolder: options.placeHolder,
      canPickMany: options.canPickMany,
      ignoreFocusOut: options.ignoreFocusOut,
      // The detail and the description are part of what an entry says: typing matches them too.
      matchOnDescription: options.matchOnDescription ?? true,
      matchOnDetail: options.matchOnDetail ?? true,
    });
  });
  if (!picked) return undefined;
  return options.canPickMany ? picked.map((i) => items[i]) : items[picked[0]];
}

// ---- input box

export interface InputBoxValidationMessage {
  message: string;
  severity: number;
}

type Validation = string | InputBoxValidationMessage | undefined | null;

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  valueSelection?: [number, number];
  password?: boolean;
  ignoreFocusOut?: boolean;
  validateInput?(value: string): Validation | Thenable<Validation>;
}

interface PendingInput {
  options: InputBoxOptions;
  resolve(value: string | undefined): void;
}

const pendingInputs = new Map<number, PendingInput>();

async function validate(options: InputBoxOptions, value: string): Promise<{ message?: string; severity?: Severity }> {
  const result = await options.validateInput?.(value);
  if (!result) return {};
  if (typeof result === 'string') return { message: result, severity: 'error' };
  // InputBoxValidationSeverity: 1 info, 2 warning, 3 error. Only an error refuses the value.
  return { message: result.message, severity: result.severity === 1 ? 'info' : result.severity === 2 ? 'warning' : 'error' };
}

onShell('inputValidate', (m) => {
  const pending = pendingInputs.get(m.id);
  if (!pending) return;
  void validate(pending.options, m.value).then((v) => post({ type: 'inputValidation', id: m.id, seq: m.seq, ...v }));
});

onShell('inputBoxResult', (m) => {
  const pending = pendingInputs.get(m.id);
  if (!pending) return;
  const finish = (value: string | undefined) => {
    pendingInputs.delete(m.id);
    post({ type: 'quickInputHide', id: m.id });
    pending.resolve(value);
  };
  if (m.value === undefined) return finish(undefined);
  const value = m.value;
  void validate(pending.options, value).then((v) => {
    if (v.message && v.severity === 'error') post({ type: 'inputValidation', id: m.id, seq: -1, ...v });
    else finish(value);
  });
});

export function showInputBox(options: InputBoxOptions = {}): Thenable<string | undefined> {
  const id = nextId++;
  return new Promise((resolve) => {
    pendingInputs.set(id, { options, resolve });
    post({
      type: 'inputBox',
      id,
      title: options.title,
      prompt: options.prompt,
      placeHolder: options.placeHolder,
      value: options.value,
      valueSelection: options.valueSelection,
      password: options.password,
      ignoreFocusOut: options.ignoreFocusOut,
    });
  });
}

// ---- file dialogs

export interface OpenDialogOptions_ {
  title?: string;
  defaultUri?: Uri;
  openLabel?: string;
  canSelectFiles?: boolean;
  canSelectFolders?: boolean;
  canSelectMany?: boolean;
  filters?: Record<string, string[]>;
}

export interface SaveDialogOptions {
  title?: string;
  defaultUri?: Uri;
  saveLabel?: string;
  filters?: Record<string, string[]>;
}

const fileFilters = (filters: Record<string, string[]> | undefined): FileFilter[] | undefined =>
  filters && Object.entries(filters).map(([name, extensions]) => ({ name, extensions }));

export async function showOpenDialog(options: OpenDialogOptions_ = {}): Promise<Uri[] | undefined> {
  const folders = !!options.canSelectFolders;
  const files = options.canSelectFiles ?? !folders;
  const properties: OpenDialogOptions['properties'] = [];
  if (files) properties.push('openFile');
  if (folders) properties.push('openDirectory', 'createDirectory');
  if (options.canSelectMany) properties.push('multiSelections');
  const dialogOptions: OpenDialogOptions = {
    title: options.title,
    defaultPath: options.defaultUri?.fsPath,
    buttonLabel: options.openLabel,
    filters: fileFilters(options.filters),
    properties,
  };
  const window = runtime().window();
  const result = await (window ? dialog.showOpenDialog(window, dialogOptions) : dialog.showOpenDialog(dialogOptions));
  return result.canceled || !result.filePaths.length ? undefined : result.filePaths.map((p) => Uri.file(p));
}

export async function showSaveDialog(options: SaveDialogOptions = {}): Promise<Uri | undefined> {
  const dialogOptions = {
    title: options.title,
    defaultPath: options.defaultUri?.fsPath,
    buttonLabel: options.saveLabel,
    filters: fileFilters(options.filters),
  };
  const window = runtime().window();
  const result = await (window ? dialog.showSaveDialog(window, dialogOptions) : dialog.showSaveDialog(dialogOptions));
  return result.canceled || !result.filePath ? undefined : Uri.file(result.filePath);
}

// ---- progress

export interface ProgressOptions {
  location: ProgressLocation | { viewId: string };
  title?: string;
  cancellable?: boolean;
}

export interface Progress<T> {
  report(value: T): void;
}

const runningProgress = new Map<number, CancellationTokenSource>();

onShell('progressCancel', (m) => runningProgress.get(m.id)?.cancel());

export async function withProgress<R>(
  options: ProgressOptions,
  task: (progress: Progress<{ message?: string; increment?: number }>, token: CancellationToken) => Thenable<R>,
): Promise<R> {
  const id = nextId++;
  const source = new CancellationTokenSource();
  runningProgress.set(id, source);
  const title = options.title ?? '';
  let message: string | undefined;
  let percent: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  const send = () => {
    timer = undefined;
    post({ type: 'progress', id, title, message, percent, cancellable: !!options.cancellable });
  };
  send();
  try {
    return await task(
      {
        report: (value) => {
          if (value.message !== undefined) message = value.message;
          if (typeof value.increment === 'number') percent = Math.min(100, (percent ?? 0) + value.increment);
          // Reports can come by the thousand: the shell hears of them a few times a second.
          timer ??= setTimeout(send, 80);
        },
      },
      source.token,
    );
  } finally {
    if (timer) clearTimeout(timer);
    runningProgress.delete(id);
    source.dispose();
    post({ type: 'progressEnd', id });
  }
}

// ---- status bar

export interface StatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

const statusItems = new Map<number, StatusItem & { shown: boolean }>();
const statusMessages: { id: number; text: string }[] = [];
let statusScheduled = false;

function updateStatus(): void {
  if (statusScheduled) return;
  statusScheduled = true;
  queueMicrotask(() => {
    statusScheduled = false;
    post({
      type: 'status',
      items: [...statusItems.values()].filter((i) => i.shown && i.text).map(({ shown: _shown, ...item }) => item),
      message: statusMessages[statusMessages.length - 1]?.text,
    });
  });
}

/** Sends the status bar again, e.g. to a window that just loaded. */
export function refreshStatus(): void {
  updateStatus();
}

export function createStatusBarItem(alignment: StatusBarAlignment = StatusBarAlignment.Left, priority = 0): StatusBarItem {
  const state: StatusItem & { shown: boolean } = { id: nextId++, text: '', right: alignment === StatusBarAlignment.Right, priority, shown: false };
  statusItems.set(state.id, state);
  const set = <K extends 'text' | 'tooltip' | 'command'>(key: K, value: (typeof state)[K]) => {
    if (state[key] === value) return;
    state[key] = value;
    if (state.shown) updateStatus();
  };
  return {
    get text() {
      return state.text;
    },
    set text(value) {
      set('text', value);
    },
    get tooltip() {
      return state.tooltip;
    },
    set tooltip(value) {
      set('tooltip', value);
    },
    get command() {
      return state.command;
    },
    set command(value) {
      set('command', value);
    },
    show() {
      if (state.shown) return;
      state.shown = true;
      updateStatus();
    },
    hide() {
      if (!state.shown) return;
      state.shown = false;
      updateStatus();
    },
    dispose() {
      statusItems.delete(state.id);
      updateStatus();
    },
  };
}

export function setStatusBarMessage(text: string, hideAfter?: number | Thenable<unknown>): Disposable {
  const entry = { id: nextId++, text };
  statusMessages.push(entry);
  updateStatus();
  const disposable = new Disposable(() => {
    const index = statusMessages.indexOf(entry);
    if (index === -1) return;
    statusMessages.splice(index, 1);
    updateStatus();
  });
  if (typeof hideAfter === 'number') setTimeout(() => disposable.dispose(), hideAfter);
  else if (hideAfter) void Promise.resolve(hideAfter).then(() => disposable.dispose(), () => disposable.dispose());
  return disposable;
}

// ---- output channels

export interface OutputChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

const MAX_OUTPUT = 400_000;
const channels = new Map<string, { text: string }>();

/** The names of the output channels, for the View menu. */
export function outputChannels(): string[] {
  return [...channels.keys()];
}

export function outputText(name: string): string {
  return channels.get(name)?.text ?? '';
}

export function createOutputChannel(name: string): OutputChannel {
  const channel = { text: '' };
  channels.set(name, channel);
  const append = (value: string) => {
    channel.text += value;
    if (channel.text.length > MAX_OUTPUT) channel.text = channel.text.slice(channel.text.indexOf('\n', channel.text.length - MAX_OUTPUT / 2) + 1);
  };
  return {
    name,
    append,
    appendLine: (value) => append(`${value}\n`),
    clear: () => {
      channel.text = '';
    },
    show: () => void import('./documents').then((d) => d.showOutput(name)),
    hide: () => undefined,
    dispose: () => {
      channels.delete(name);
    },
  };
}
