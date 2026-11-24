// The window's title bar, drawn by the shell: the window has none of the system's (main.ts). It holds
// the app's icon, the menus (File, Edit, …: the application menu's, which the host opens under their
// names), the name of the active tab and, outside macOS, the buttons that minimize, maximize and close
// the window. Dragging the bar moves the window (`-webkit-app-region` in shell.css).
import { h, host, icon, plain } from './dom';

const menuBar = document.getElementById('menubar')!;
const title = document.getElementById('window-title')!;
const controls = document.getElementById('window-controls')!;

let appName = '';
let tabTitle: string | undefined;
/** The menu shown, under its name. */
let openButton: HTMLButtonElement | undefined;
/** The letter that opens each menu with Alt, lower case, and the menu's index. */
const mnemonics = new Map<string, number>();
let maximize: HTMLButtonElement | undefined;

function openMenu(index: number): void {
  const button = menuBar.children[index] as HTMLButtonElement | undefined;
  if (!button) return;
  openButton?.classList.remove('open');
  openButton = button;
  button.classList.add('open');
  const rect = button.getBoundingClientRect();
  host.send({ type: 'openMenu', index, x: rect.left, y: rect.bottom });
}

/** A menu's name, with the letter after `&` underlined while Alt is held (`&&` is an `&`). */
function menuButton(name: string, index: number): HTMLButtonElement {
  const button = h('button', { class: 'menubar-item', type: 'button', role: 'menuitem', 'aria-haspopup': 'true', tabindex: -1 });
  for (const [i, part] of name.split(/(&&|&.)/).entries()) {
    if (i % 2 === 0) button.append(part);
    else if (part === '&&') button.append('&');
    else {
      button.append(h('u', {}, part[1]));
      mnemonics.set(part[1].toLowerCase(), index);
    }
  }
  // On the press, like the system's menus: the menu opens while the mouse button is still down.
  button.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    openMenu(index);
  });
  return button;
}

function controlButton(action: 'minimize' | 'maximize' | 'close', codicon: string, label: string): HTMLButtonElement {
  const button = h('button', { class: `window-control ${action}`, type: 'button', title: label, 'aria-label': label, tabindex: -1 }, icon(codicon));
  button.addEventListener('click', () => host.send({ type: 'windowControl', action }));
  return button;
}

function drawTitle(): void {
  const text = tabTitle ? `${tabTitle} — ${appName}` : appName;
  title.textContent = text;
  document.title = text;
}

export function initTitleBar(name: string, menus: string[], platform: string): void {
  appName = name;
  drawTitle();
  mnemonics.clear();
  menuBar.replaceChildren(...menus.map(menuButton));
  if (platform === 'darwin') {
    // macOS keeps its own buttons, drawn by the system over the left end of the bar.
    controls.replaceChildren();
    maximize = undefined;
    return;
  }
  maximize = controlButton('maximize', 'chrome-maximize', 'Maximize');
  controls.replaceChildren(controlButton('minimize', 'chrome-minimize', 'Minimize'), maximize, controlButton('close', 'chrome-close', 'Close'));
}

/** The name of the active tab, shown in the bar and given to the system as the window's title. */
export function setWindowTitle(text: string | undefined): void {
  const next = text ? plain(text) : undefined;
  if (next === tabTitle) return;
  tabTitle = next;
  drawTitle();
}

export function windowState(state: { maximized: boolean; fullScreen: boolean; focused: boolean }): void {
  document.body.classList.toggle('window-maximized', state.maximized);
  document.body.classList.toggle('window-fullscreen', state.fullScreen);
  document.body.classList.toggle('window-inactive', !state.focused);
  if (!maximize) return;
  const label = state.maximized ? 'Restore' : 'Maximize';
  maximize.title = label;
  maximize.setAttribute('aria-label', label);
  maximize.replaceChildren(icon(state.maximized ? 'chrome-restore' : 'chrome-maximize'));
}

export function menuClosed(): void {
  openButton?.classList.remove('open');
  openButton = undefined;
}

/** Alt and a menu's letter opens it, F10 the first one; holding Alt underlines the letters. */
export function initMenuKeys(): void {
  const showLetters = (on: boolean) => menuBar.classList.toggle('mnemonics', on);
  window.addEventListener(
    'keydown',
    (e) => {
      showLetters(e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey);
      if (!menuBar.children.length || e.ctrlKey || e.metaKey || e.shiftKey) return;
      let index: number | undefined;
      if (e.key === 'F10' && !e.altKey) index = 0;
      else if (e.altKey && e.code.startsWith('Key')) index = mnemonics.get(e.code.slice(3).toLowerCase());
      if (index === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      showLetters(false);
      openMenu(index);
    },
    true,
  );
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') showLetters(false);
  });
  window.addEventListener('blur', () => showLetters(false));
}
