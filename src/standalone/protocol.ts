// Messages between the host (Electron's main process, where the extension code runs) and the shell
// (the window: tree, tabs, editors, dialogs).

export type ThemeKind = 'dark' | 'light';

export interface ThemeInfo {
  kind: ThemeKind;
  /** The `--vscode-*` CSS variables, without the leading dashes. */
  vars: Record<string, string>;
  /** The syntax colors of the editor, by kind of token. */
  syntax: Record<string, string>;
}

export interface MenuAction {
  command: string;
  title: string;
  /** Codicon id. */
  icon?: string;
}

export interface TreeItemData {
  handle: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** Codicon id and its color (a CSS color), or the URL of an image. */
  icon?: { id: string; color?: string } | { src: string };
  /** 0 none, 1 collapsed, 2 expanded. */
  collapsible: 0 | 1 | 2;
  hasCommand: boolean;
  inline: MenuAction[];
}

export interface Pos {
  line: number;
  character: number;
}

export interface Span {
  start: Pos;
  end: Pos;
}

export type Column = 'active' | 'beside' | 1 | 2;

export interface QuickPickEntry {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  separator?: boolean;
}

export interface QuickPickRequest {
  id: number;
  items: QuickPickEntry[];
  title?: string;
  placeHolder?: string;
  canPickMany?: boolean;
  ignoreFocusOut?: boolean;
  /** Also match the typed text against the description and the detail. */
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
}

export interface InputBoxRequest {
  id: number;
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  valueSelection?: [number, number];
  password?: boolean;
  ignoreFocusOut?: boolean;
}

export type Severity = 'info' | 'warning' | 'error';

export interface StatusItem {
  id: number;
  text: string;
  tooltip?: string;
  command?: string;
  right: boolean;
  priority: number;
}

export interface LanguageProviders {
  completion: { id: number; languages: string[]; triggers: string[] }[];
  lens: { id: number; languages: string[] }[];
}

export interface EditorOpen {
  id: number;
  uri: string;
  title: string;
  tooltip: string;
  language: string;
  text: string;
  readOnly: boolean;
  dirty: boolean;
  column: Column;
  preserveFocus: boolean;
  selection?: Span;
  actions: MenuAction[];
  /** Run with their keys while the editor has the focus. */
  keys: { key: string; command: string }[];
}

export interface SettingField {
  key: string;
  type: 'boolean' | 'number' | 'string';
  description: string;
  value: unknown;
  default: unknown;
  minimum?: number;
  maximum?: number;
  options?: string[];
}

export interface CompletionData {
  incomplete: boolean;
  items: {
    label: string;
    description?: string;
    kind: number;
    insert: string;
    snippet: boolean;
    range?: Span;
    sortText?: string;
    filterText?: string;
    detail?: string;
    command?: string;
  }[];
}

export interface LensData {
  range: Span;
  title: string;
  tooltip?: string;
  command: string;
}

export interface TabRef {
  kind: 'panel' | 'editor' | 'settings';
  id: number;
}

/** Host → shell. */
export type HostMessage =
  | { type: 'init'; title: string; viewTitle: string; welcome: { text: string; button?: MenuAction }; theme: ThemeInfo; platform: string }
  | { type: 'theme'; theme: ThemeInfo }
  | { type: 'viewTitle'; actions: MenuAction[]; message?: string }
  | { type: 'treeChanged'; handle?: string }
  | { type: 'panelOpen'; id: number; title: string; icon?: string; src: string; column: Column; preserveFocus: boolean }
  | { type: 'panelUpdate'; id: number; title?: string; icon?: string; src?: string }
  | { type: 'panelReveal'; id: number; column?: Column; preserveFocus: boolean }
  | { type: 'panelClose'; id: number }
  | { type: 'panelMessage'; id: number; message: unknown }
  | ({ type: 'editorOpen' } & EditorOpen)
  | { type: 'editorUpdate'; id: number; uri?: string; title?: string; tooltip?: string; language?: string; text?: string; readOnly?: boolean; dirty?: boolean; actions?: MenuAction[]; keys?: { key: string; command: string }[] }
  | { type: 'editorReveal'; id: number; column?: Column; selection?: Span; preserveFocus: boolean }
  | { type: 'editorEdits'; id: number; edits: { range: Span; text: string }[]; clean: boolean }
  | { type: 'editorSelect'; id: number; selection: Span }
  | { type: 'editorClose'; id: number }
  | { type: 'editorCommand'; command: string }
  | { type: 'languages'; providers: LanguageProviders }
  | { type: 'lensesChanged' }
  | ({ type: 'quickPick' } & QuickPickRequest)
  | ({ type: 'inputBox' } & InputBoxRequest)
  | { type: 'inputValidation'; id: number; seq: number; message?: string; severity?: Severity }
  | { type: 'quickInputHide'; id: number }
  | { type: 'notify'; id: number; severity: Severity; message: string; detail?: string; modal: boolean; actions: string[] }
  | { type: 'notifyClose'; id: number }
  | { type: 'progress'; id: number; title: string; message?: string; percent?: number; cancellable: boolean }
  | { type: 'progressEnd'; id: number }
  | { type: 'status'; items: StatusItem[]; message?: string }
  | { type: 'settingsOpen'; fields: SettingField[]; focus?: string }
  | { type: 'settingsValues'; values: Record<string, unknown> }
  | { type: 'shellCommand'; command: 'closeTab' | 'save' | 'revert' | 'nextTab' | 'previousTab' | 'toggleSidebar' | 'focusTree' | 'collapseTree' }
  | { type: 'tabCommand'; command: 'close' | 'closeOthers' | 'closeAll' | 'move'; tab: TabRef };

/** Shell → host, without an answer. */
export type ShellMessage =
  | { type: 'ready' }
  | { type: 'treeCommand'; handle: string }
  | { type: 'treeContext'; handle: string }
  | { type: 'viewTitleMore' }
  | { type: 'execute'; command: string; handle?: string }
  | { type: 'panelClosed'; id: number }
  | { type: 'panelMessage'; id: number; message: unknown }
  | { type: 'tabs'; active?: TabRef; visible: TabRef[] }
  | { type: 'editorChanged'; id: number; text: string }
  | { type: 'editorSelection'; id: number; selection: Span }
  | { type: 'editorSave'; id: number }
  | { type: 'editorRevert'; id: number }
  | { type: 'editorCloseRequest'; id: number }
  | { type: 'quickPickResult'; id: number; picked?: number[] }
  | { type: 'inputBoxResult'; id: number; value?: string }
  | { type: 'inputValidate'; id: number; seq: number; value: string }
  | { type: 'notifyResult'; id: number; action?: string }
  | { type: 'progressCancel'; id: number }
  | { type: 'settingChange'; key: string; value: unknown }
  | { type: 'tabContext'; tab: TabRef; others: boolean }
  | { type: 'openExternal'; url: string };

/** Shell → host, answered. */
export interface ShellRequests {
  treeChildren: { args: { handle?: string }; result: TreeItemData[] };
  completions: { args: { provider: number; editor: number; position: Pos; text: string }; result: CompletionData | undefined };
  lenses: { args: { provider: number; editor: number }; result: LensData[] };
}

export interface ShellBridge {
  send(message: ShellMessage): void;
  request<K extends keyof ShellRequests>(name: K, args: ShellRequests[K]['args']): Promise<ShellRequests[K]['result']>;
  onMessage(listener: (message: HostMessage) => void): void;
}
