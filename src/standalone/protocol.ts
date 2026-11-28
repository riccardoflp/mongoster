// Messages between the host (Electron's main process, where the extension code runs) and the shell
// (the window: tree, tabs, editors, dialogs).

export type ThemeKind = 'dark' | 'light';

/** How the window is laid out: the side bar and the tabs as panels apart, or joined edge to edge. */
export type Layout = 'islands' | 'compact';

export interface ThemeInfo {
  /** The theme's id, the value of the `app.theme` setting. */
  id: string;
  kind: ThemeKind;
  /** The `--vscode-*` CSS variables, without the leading dashes. */
  vars: Record<string, string>;
  /** The syntax colors of the editor, by kind of token. */
  syntax: Record<string, string>;
}

/** A color theme as its preview in the empty tab area draws it: a few of its colors, all `#rrggbb`. */
export interface ThemePreview {
  id: string;
  label: string;
  kind: ThemeKind;
  /** The window around the panels, the side bar, the strip of the tabs, the editor, its text, the primary button. */
  window: string;
  sideBar: string;
  tabs: string;
  editor: string;
  foreground: string;
  accent: string;
  /** Syntax colors for the lines of code: keyword, property, string, number, comment. */
  syntax: string[];
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
  /** The color of the label (a CSS color), from the decoration of the item's resourceUri. */
  color?: string;
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
  /** The URL of the item's icon, for the current theme. */
  icon?: string;
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
  /** What the options are shown as, when not as themselves. */
  optionLabels?: string[];
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
  /** `menus`: the names of the menus in the title bar, with `&` before the letter that opens each with Alt; none on macOS. */
  | { type: 'init'; title: string; viewTitle: string; welcome: { text: string; button?: MenuAction }; theme: ThemeInfo; layout: Layout; platform: string; themes: ThemePreview[]; themeSetting: string; menus: string[] }
  | { type: 'window'; maximized: boolean; fullScreen: boolean; focused: boolean }
  /** The menu opened from the title bar closed. */
  | { type: 'menuClosed' }
  | { type: 'theme'; theme: ThemeInfo }
  | { type: 'layout'; layout: Layout }
  | { type: 'viewTitle'; actions: MenuAction[]; message?: string }
  | { type: 'treeChanged'; handle?: string }
  | { type: 'panelOpen'; id: number; title: string; icon?: string; color?: string; src: string; column: Column; preserveFocus: boolean }
  /** `icon` and `color` empty: none any more. `color` is a CSS color: the line above the tab. */
  | { type: 'panelUpdate'; id: number; title?: string; icon?: string; color?: string; src?: string }
  | { type: 'panelReveal'; id: number; column?: Column; preserveFocus: boolean }
  | { type: 'panelClose'; id: number }
  | { type: 'panelMessage'; id: number; message: unknown }
  | ({ type: 'editorOpen' } & EditorOpen)
  /** `color`: the CSS color of the tab's name and of the line above it, from the decoration of the document; empty for none. */
  | { type: 'editorUpdate'; id: number; uri?: string; title?: string; tooltip?: string; color?: string; language?: string; text?: string; readOnly?: boolean; dirty?: boolean; actions?: MenuAction[]; keys?: { key: string; command: string }[] }
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
  /** `handles`: the selected rows, when the one right-clicked is one of several selected. */
  | { type: 'treeContext'; handle: string; handles?: string[] }
  /** The selected rows, in the tree's order, each time they change. */
  | { type: 'treeSelection'; handles: string[] }
  /** A key with Ctrl or Cmd pressed in the tree (`ctrl+c`): a key binding of package.json may answer it. */
  | { type: 'treeKey'; key: string }
  | { type: 'viewTitleMore' }
  | { type: 'execute'; command: string; handle?: string; handles?: string[] }
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
  | { type: 'openExternal'; url: string }
  /** Opens a menu of the title bar under its name: `x` and `y` in CSS pixels of the window. */
  | { type: 'openMenu'; index: number; x: number; y: number }
  | { type: 'windowControl'; action: 'minimize' | 'maximize' | 'close' };

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
