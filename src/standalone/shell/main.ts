// The window of the standalone app: the side bar with the connections, the tabs, the status bar and
// the dialogs. It draws what the host (the main process, where Mongoster's code runs) tells it.
import '@vscode/codicons/dist/codicon.css';
import './shell.css';
import type { HostMessage, StatusItem, ThemeInfo } from '../protocol';
import { h, host, label } from './dom';
import { closeEditor, editEditor, editorCommand, initEditors, openEditor, refreshLenses, revealEditor, revertActive, saveActive, selectInEditor, setLanguageProviders, themeEditors, updateEditor } from './editor';
import { closeMessage, endProgress, showMessage, showProgress } from './notifications';
import { closePanel, initPanels, openPanel, postToPanel, revealPanel, themePanels, updatePanel } from './panels';
import { hideQuickInput, inputValidation, showInputBox, showQuickPick } from './quickInput';
import { openSettings, settingsValues } from './settings';
import { collapseAll, focusTree, initTree, setTitleActions, setWelcome, treeChanged } from './tree';
import { activeTab, closeAll, closeOthers, cycle, find, initWorkbench, move, requestClose, toggleSidebar } from './workbench';

function applyTheme(theme: ThemeInfo): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(`--vscode-${name}`, value);
  root.style.colorScheme = theme.kind;
  document.body.classList.toggle('vscode-dark', theme.kind === 'dark');
  document.body.classList.toggle('vscode-light', theme.kind === 'light');
}

// ---- status bar

const statusLeft = document.getElementById('status-left')!;
const statusRight = document.getElementById('status-right')!;

function drawStatus(items: StatusItem[], message: string | undefined): void {
  const draw = (item: StatusItem) => {
    const el = h(item.command ? 'button' : 'span', { class: 'status-item', title: item.tooltip, type: item.command ? 'button' : undefined }, label(item.text));
    if (item.command) el.addEventListener('click', () => host.send({ type: 'execute', command: item.command! }));
    return el;
  };
  const byPriority = (a: StatusItem, b: StatusItem) => b.priority - a.priority;
  statusLeft.replaceChildren(...items.filter((i) => !i.right).sort(byPriority).map(draw));
  if (message) statusLeft.append(h('span', { class: 'status-item status-message' }, label(message)));
  statusRight.replaceChildren(...items.filter((i) => i.right).sort(byPriority).map(draw));
}

// ---- messages from the host

let started = false;

function receive(m: HostMessage): void {
  switch (m.type) {
    case 'init':
      document.title = m.title;
      document.body.dataset.platform = m.platform;
      document.getElementById('view-title')!.textContent = m.viewTitle;
      applyTheme(m.theme);
      setWelcome(m.welcome.text, m.welcome.button);
      if (!started) {
        started = true;
        initEditors(m.theme);
        initTree();
      }
      break;
    case 'theme':
      applyTheme(m.theme);
      themeEditors(m.theme);
      themePanels(m.theme);
      break;
    case 'viewTitle':
      setTitleActions(m.actions, m.message);
      break;
    case 'treeChanged':
      treeChanged(m.handle);
      break;
    case 'panelOpen':
      openPanel(m.id, m.title, m.icon, m.src, m.column, m.preserveFocus);
      break;
    case 'panelUpdate':
      updatePanel(m.id, m);
      break;
    case 'panelReveal':
      revealPanel(m.id, m.preserveFocus);
      break;
    case 'panelClose':
      closePanel(m.id);
      break;
    case 'panelMessage':
      postToPanel(m.id, m.message);
      break;
    case 'editorOpen':
      openEditor(m);
      break;
    case 'editorUpdate':
      updateEditor(m.id, m);
      break;
    case 'editorReveal':
      revealEditor(m.id, m.selection, m.preserveFocus);
      break;
    case 'editorEdits':
      editEditor(m.id, m.edits);
      break;
    case 'editorSelect':
      selectInEditor(m.id, m.selection);
      break;
    case 'editorClose':
      closeEditor(m.id);
      break;
    case 'editorCommand':
      editorCommand(m.command);
      break;
    case 'languages':
      setLanguageProviders(m.providers);
      break;
    case 'lensesChanged':
      refreshLenses();
      break;
    case 'quickPick':
      showQuickPick(m);
      break;
    case 'inputBox':
      showInputBox(m);
      break;
    case 'inputValidation':
      inputValidation(m.id, m.seq, m.message, m.severity);
      break;
    case 'quickInputHide':
      hideQuickInput(m.id);
      break;
    case 'notify':
      showMessage(m);
      break;
    case 'notifyClose':
      closeMessage(m.id);
      break;
    case 'progress':
      showProgress(m.id, m.title, m.message, m.percent, m.cancellable);
      break;
    case 'progressEnd':
      endProgress(m.id);
      break;
    case 'status':
      drawStatus(m.items, m.message);
      break;
    case 'settingsOpen':
      openSettings(m.fields, m.focus);
      break;
    case 'settingsValues':
      settingsValues(m.values);
      break;
    case 'shellCommand': {
      const tab = activeTab();
      if (m.command === 'closeTab' && tab) requestClose(tab);
      else if (m.command === 'save') saveActive();
      else if (m.command === 'revert') revertActive();
      else if (m.command === 'nextTab') cycle(1);
      else if (m.command === 'previousTab') cycle(-1);
      else if (m.command === 'toggleSidebar') toggleSidebar();
      else if (m.command === 'focusTree') focusTree();
      else if (m.command === 'collapseTree') collapseAll();
      break;
    }
    case 'tabCommand': {
      const tab = find(m.tab);
      if (!tab) break;
      if (m.command === 'close') requestClose(tab);
      else if (m.command === 'closeOthers') closeOthers(tab);
      else if (m.command === 'closeAll') closeAll();
      else if (m.command === 'move') move(tab);
      break;
    }
  }
}

initWorkbench();
initPanels();
host.onMessage((message) => {
  try {
    receive(message);
  } catch (err) {
    console.error(`Could not handle '${message.type}':`, err);
  }
});
host.send({ type: 'ready' });
