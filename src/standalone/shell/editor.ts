// The text editors (Monaco, the editor of VS Code): documents as JSON, playgrounds, generated code.
// The host owns the documents; the editor reports what is typed and asks it for completions and lenses.
import * as monaco from 'monaco-editor';
import type { EditorOpen, LanguageProviders, MenuAction, Span, ThemeInfo } from '../protocol';
import { h, host } from './dom';
import { Tab, activate, activeTab, close, find, open, touched, update } from './workbench';

interface Entry {
  id: number;
  tab: Tab;
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  /** The keys already bound in this editor. */
  keys: Set<string>;
}

const entries = new Map<number, Entry>();
const byModel = (model: monaco.editor.ITextModel) => [...entries.values()].find((e) => e.model === model);

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const file = label === 'json' ? 'json.worker.js' : label === 'typescript' || label === 'javascript' ? 'ts.worker.js' : 'editor.worker.js';
    return new Worker(new URL(file, document.baseURI), { name: label });
  },
};

// ---- theme

let theme: ThemeInfo | undefined;

export function themeEditors(next: ThemeInfo): void {
  theme = next;
  const color = (name: string) => next.vars[name];
  const hex = (name: string) => next.syntax[name]?.replace('#', '');
  monaco.editor.defineTheme('mongoster', {
    base: next.kind === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: hex('comment') },
      { token: 'string', foreground: hex('string') },
      { token: 'string.key.json', foreground: hex('property') },
      { token: 'string.value.json', foreground: hex('string') },
      { token: 'number', foreground: hex('number') },
      { token: 'keyword', foreground: hex('keyword') },
      { token: 'keyword.json', foreground: hex('constant') },
      { token: 'regexp', foreground: hex('regexp') },
      { token: 'type', foreground: hex('type') },
    ],
    colors: {
      'editor.background': color('editor-background'),
      'editor.foreground': color('editor-foreground'),
      'editorLineNumber.foreground': color('editorLineNumber-foreground'),
      'editorWidget.background': color('editorWidget-background'),
      'editorWidget.border': color('editorWidget-border'),
      'editorSuggestWidget.background': color('editorSuggestWidget-background'),
      'editorSuggestWidget.border': color('editorSuggestWidget-border'),
      'editorSuggestWidget.selectedBackground': color('editorSuggestWidget-selectedBackground'),
      'editorCodeLens.foreground': color('editorCodeLens-foreground'),
      focusBorder: color('focusBorder'),
    },
  });
  monaco.editor.setTheme('mongoster');
  for (const entry of entries.values()) entry.editor.updateOptions(fontOptions());
}

function fontOptions(): monaco.editor.IEditorOptions {
  return {
    fontFamily: theme?.vars['editor-font-family'],
    fontSize: parseInt(theme?.vars['editor-font-size'] ?? '14', 10),
  };
}

// ---- positions: the host counts lines and characters from 0, Monaco from 1

const toRange = (span: Span) => new monaco.Range(span.start.line + 1, span.start.character + 1, span.end.line + 1, span.end.character + 1);
const toSpan = (range: monaco.IRange): Span => ({
  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
});

// ---- keys: `ctrl+enter` as a Monaco key binding

function keybinding(key: string): number | undefined {
  let binding = 0;
  for (const part of key.toLowerCase().split('+')) {
    if (part === 'ctrl' || part === 'cmd' || part === 'meta') binding |= monaco.KeyMod.CtrlCmd;
    else if (part === 'shift') binding |= monaco.KeyMod.Shift;
    else if (part === 'alt') binding |= monaco.KeyMod.Alt;
    else {
      const named: Record<string, monaco.KeyCode> = {
        enter: monaco.KeyCode.Enter,
        escape: monaco.KeyCode.Escape,
        space: monaco.KeyCode.Space,
        tab: monaco.KeyCode.Tab,
      };
      const codes = monaco.KeyCode as unknown as Record<string, monaco.KeyCode | undefined>;
      const code = named[part] ?? codes[part.toUpperCase()] ?? codes[`Key${part.toUpperCase()}`] ?? codes[`Digit${part}`];
      if (code === undefined) return undefined;
      binding |= code;
    }
  }
  return binding;
}

function bindKeys(entry: Entry, keys: { key: string; command: string }[]): void {
  for (const { key, command } of keys) {
    const id = `${key} ${command}`;
    const binding = keybinding(key);
    if (binding === undefined || entry.keys.has(id)) continue;
    entry.keys.add(id);
    entry.editor.addCommand(binding, () => host.send({ type: 'execute', command }));
  }
}

// ---- editors

export function openEditor(request: EditorOpen): void {
  const container = h('div', { class: 'editor' });
  const model = monaco.editor.createModel(request.text, request.language, monaco.Uri.from({ scheme: 'inmemory', authority: 'editor', path: `/${request.id}/${request.title}` }));
  const editor = monaco.editor.create(container, {
    model,
    theme: 'mongoster',
    readOnly: request.readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    stickyScroll: { enabled: false },
    tabSize: 2,
    padding: { top: 6 },
    ...fontOptions(),
  });
  const entry: Entry = { id: request.id, tab: undefined as unknown as Tab, editor, model, keys: new Set() };
  entries.set(request.id, entry);

  model.onDidChangeContent(() => host.send({ type: 'editorChanged', id: request.id, text: model.getValue() }));
  editor.onDidChangeCursorSelection((e) => host.send({ type: 'editorSelection', id: request.id, selection: toSpan(e.selection) }));
  editor.onDidFocusEditorWidget(() => touched(entry.tab));
  bindKeys(entry, request.keys);

  entry.tab = open(
    {
      kind: 'editor',
      id: request.id,
      title: request.title,
      tooltip: request.tooltip,
      icon: { id: request.language === 'json' ? 'json' : request.language === 'javascript' ? 'file-code' : 'file' },
      content: container,
      shown: () => editor.layout(),
      focus: () => editor.focus(),
      requestClose: () => host.send({ type: 'editorCloseRequest', id: request.id }),
      disposed: () => {
        entries.delete(request.id);
        editor.dispose();
        model.dispose();
      },
    },
    request.column,
    request.preserveFocus,
  );
  update(entry.tab, { dirty: request.dirty, actions: request.actions });
  if (request.selection) select(entry, request.selection);
}

function select(entry: Entry, selection: Span): void {
  const range = toRange(selection);
  entry.editor.setSelection(range);
  entry.editor.revealRangeInCenterIfOutsideViewport(range);
}

export function updateEditor(id: number, changes: { title?: string; tooltip?: string; language?: string; text?: string; readOnly?: boolean; dirty?: boolean; actions?: MenuAction[]; keys?: { key: string; command: string }[] }): void {
  const entry = entries.get(id);
  if (!entry) return;
  const { language, text, readOnly, keys, ...tabChanges } = changes;
  if (language !== undefined) monaco.editor.setModelLanguage(entry.model, language);
  if (text !== undefined && text !== entry.model.getValue()) entry.model.setValue(text);
  if (readOnly !== undefined) entry.editor.updateOptions({ readOnly });
  if (keys) bindKeys(entry, keys);
  const defined = Object.fromEntries(Object.entries(tabChanges).filter(([, v]) => v !== undefined));
  if (Object.keys(defined).length) update(entry.tab, defined);
}

export function revealEditor(id: number, selection: Span | undefined, preserveFocus: boolean): void {
  const entry = entries.get(id);
  if (!entry) return;
  activate(entry.tab, !preserveFocus);
  if (selection) select(entry, selection);
}

export function editEditor(id: number, edits: { range: Span; text: string }[]): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.model.pushEditOperations(null, edits.map((e) => ({ range: toRange(e.range), text: e.text })), () => null);
}

export function selectInEditor(id: number, selection: Span): void {
  const entry = entries.get(id);
  if (entry) select(entry, selection);
}

export function closeEditor(id: number): void {
  const tab = find({ kind: 'editor', id });
  if (tab) close(tab);
}

function activeEntry(): Entry | undefined {
  const tab = activeTab();
  return tab?.kind === 'editor' ? entries.get(tab.id) : undefined;
}

/** Runs an editor command (as VS Code names it) in the active editor. */
export function editorCommand(command: string): void {
  activeEntry()?.editor.trigger('host', command, {});
}

export function saveActive(): void {
  const entry = activeEntry();
  if (entry) host.send({ type: 'editorSave', id: entry.id });
}

export function revertActive(): void {
  const entry = activeEntry();
  if (entry) host.send({ type: 'editorRevert', id: entry.id });
}

// ---- completions and code lenses, asked to the host

/** VS Code's CompletionItemKind, by its number, as Monaco's. */
const KINDS = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'] as const;

const EXECUTE = 'mongoster.execute';
const lensesChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
let registered: monaco.IDisposable[] = [];

export function refreshLenses(): void {
  lensesChanged.fire(undefined as unknown as monaco.languages.CodeLensProvider);
}

export function setLanguageProviders(providers: LanguageProviders): void {
  registered.forEach((d) => d.dispose());
  registered = [];

  for (const provider of providers.completion) {
    registered.push(
      monaco.languages.registerCompletionItemProvider(provider.languages, {
        triggerCharacters: provider.triggers,
        provideCompletionItems: async (model, position) => {
          const entry = byModel(model);
          if (!entry) return { suggestions: [] };
          const data = await host.request('completions', {
            provider: provider.id,
            editor: entry.id,
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            text: model.getValue(),
          });
          if (!data) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          return {
            incomplete: data.incomplete,
            suggestions: data.items.map((item) => ({
              label: item.description ? { label: item.label, description: item.description } : item.label,
              kind: monaco.languages.CompletionItemKind[KINDS[item.kind] ?? 'Text'],
              insertText: item.insert,
              insertTextRules: item.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: item.range ? toRange(item.range) : fallback,
              sortText: item.sortText,
              filterText: item.filterText,
              detail: item.detail,
              command: item.command ? { id: item.command, title: '' } : undefined,
            })),
          };
        },
      }),
    );
  }

  for (const provider of providers.lens) {
    registered.push(
      monaco.languages.registerCodeLensProvider(provider.languages, {
        onDidChange: lensesChanged.event,
        provideCodeLenses: async (model) => {
          const entry = byModel(model);
          const lenses = entry ? await host.request('lenses', { provider: provider.id, editor: entry.id }) : [];
          return {
            lenses: lenses.map((lens) => ({
              range: toRange(lens.range),
              command: { id: EXECUTE, title: lens.title, tooltip: lens.tooltip, arguments: [lens.command] },
            })),
            dispose: () => undefined,
          };
        },
      }),
    );
  }
}

export function initEditors(initial: ThemeInfo): void {
  themeEditors(initial);
  monaco.editor.registerCommand(EXECUTE, (_accessor, command: string) => host.send({ type: 'execute', command }));
  // Mongoster's documents are relaxed JSON: comments and trailing commas are fine, there is no schema.
  monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', schemaValidation: 'ignore' });
}
