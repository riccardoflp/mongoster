// Mongoster as a desktop app: Electron's main process. It runs the same code as the VS Code extension
// (`activate` below), with the `vscode` module replaced by ./vscode, and a window (./shell) in place
// of VS Code's side bar, tabs and dialogs.
import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, Menu, MenuItemConstructorOptions, Notification, Tray, app, ipcMain, nativeImage, nativeTheme, protocol, session, shell } from 'electron';
import packageJSON from '../../package.json';
import { activate } from '../extension';
import { Scheduler } from '../scheduler';
import { TRAY_SETTING } from '../scheduledTasks';
import { appFile, appHost, mayNavigate } from './appFiles';
import type { HostMessage, ShellMessage } from './protocol';
import * as vscode from './vscode';
import { THEMES, themePreview } from './theme';
import { LAYOUT_SETTING, THEME_SETTING, activeThemeInfo, initAppearance, layout, windowBackground } from './vscode/appearance';
import { answer, dispatch, onShell } from './vscode/bridge';
import { runCommand } from './vscode/commands';
import { action, paletteCommands } from './vscode/contributions';
import { announceLanguages, confirmCloseAll, showOutput, tabActivated } from './vscode/documents';
import { PackageJson, setRuntime } from './vscode/runtime';
import { flushStorage, settings } from './vscode/storage';
import { viewTitleActions } from './vscode/tree';
import { outputChannels, refreshStatus } from './vscode/ui';
import { APP_PROTOCOL, activePanelViewType, isResourceHost, panelDocument, panelOfHost, panelsShown } from './vscode/webview';

const APP_NAME = 'Mongoster';
const REPOSITORY = 'https://github.com/riccardoflp/mongoster';
/** dist/app/main.js → the folder holding dist/ and media/. */
const appRoot = path.resolve(__dirname, '..', '..');
const shellDir = path.join(appRoot, 'dist', 'app');

app.setName(APP_NAME);
// The data folder can be moved, e.g. to try the app without touching the real connections.
app.setPath('userData', process.env.MONGOSTER_USER_DATA || path.join(app.getPath('appData'), APP_NAME));

protocol.registerSchemesAsPrivileged([
  { scheme: APP_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let window: BrowserWindow | undefined;
let shellReady = false;
const queued: HostMessage[] = [];

function post(message: HostMessage): void {
  if (shellReady && window && !window.isDestroyed()) window.webContents.send('host', message);
  else queued.push(message);
}

// ---- the app's protocol: the shell's files, the webviews' files and documents

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** The folders of the app the webviews read from: the extension's scripts and styles. */
const RESOURCE_FOLDERS = ['dist', 'media'];

async function serveFile(root: string, pathname: string, folders?: readonly string[]): Promise<Response> {
  const found = appFile(root, pathname, folders);
  if ('status' in found) return new Response(found.status === 400 ? 'Bad request' : 'Forbidden', { status: found.status });
  try {
    const body = await fs.promises.readFile(found.file);
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': MIME[path.extname(found.file).toLowerCase()] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function handleProtocol(): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.host === 'shell') return serveFile(shellDir, url.pathname);
    // The webviews only get what the extension ships: its scripts and its styles.
    if (isResourceHost(url.host)) return serveFile(appRoot, url.pathname, RESOURCE_FOLDERS);
    const panel = panelOfHost(url.host);
    const html = panel === undefined ? undefined : panelDocument(panel);
    if (html === undefined) return new Response('Not found', { status: 404 });
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  });
}

/**
 * Nothing in the app needs the camera, the position and the like. Only the editor reads the clipboard
 * (Paste in its menu), and it is in the shell: the webviews copy and paste through the extension.
 */
function restrictPermissions(): void {
  const granted = (permission: string, origin: string | undefined) =>
    (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') && appHost(origin, APP_PROTOCOL) === 'shell';
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(granted(permission, details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => granted(permission, origin));
}

// ---- the window

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const windowStateFile = () => path.join(app.getPath('userData'), 'window.json');

function readWindowState(): WindowState {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')) as WindowState;
    if (state.width >= 400 && state.height >= 300) return state;
  } catch {
    // First run, or an unreadable file.
  }
  return { width: 1280, height: 800 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds();
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(windowStateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
  } catch {
    // Not remembered: the default size next time.
  }
}

function createWindow(): void {
  const state = readWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: APP_NAME,
    icon: path.join(appRoot, 'media', 'icon.png'),
    backgroundColor: windowBackground(),
    // No title bar of the system: the shell draws its own, with the menus and the window's buttons
    // (shell/titleBar.ts). macOS keeps its buttons, drawn over the shell's title bar.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 10 },
    webPreferences: {
      preload: path.join(shellDir, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window = win;
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  const stateChanged = () => postWindowState(win);
  win.on('focus', () => {
    vscode.windowFocusChanged(true);
    stateChanged();
  });
  win.on('blur', () => {
    vscode.windowFocusChanged(false);
    stateChanged();
  });
  win.on('maximize', stateChanged);
  win.on('unmaximize', stateChanged);
  win.on('enter-full-screen', stateChanged);
  win.on('leave-full-screen', stateChanged);

  // The window only shows the app: links open in the browser, nothing else is loaded in it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-frame-navigate', (event) => {
    if (!mayNavigate(event.url, event.isMainFrame, APP_PROTOCOL)) event.preventDefault();
  });

  let closing = false;
  win.on('close', (event) => {
    saveWindowState(win);
    if (closing) return;
    event.preventDefault();
    if (!quitting && keepInTray()) {
      hideToTray(win);
      return;
    }
    // Quitting from the tray: the confirmation of unsaved files is in the window.
    if (!win.isVisible()) showWindow();
    void confirmCloseAll().then((ok) => {
      if (!ok) {
        quitting = false;
        return;
      }
      closing = true;
      win.close();
    });
  });
  win.on('closed', () => {
    window = undefined;
    shellReady = false;
  });

  void win.loadURL(`${APP_PROTOCOL}://shell/shell.html`);
}

/** The title bar shows the button to maximize or to restore, and is dimmed while the window is not the active one. */
function postWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  post({ type: 'window', maximized: win.isMaximized(), fullScreen: win.isFullScreen(), focused: win.isFocused() });
}

// ---- the tray: with scheduled tasks enabled and the setting on, closing the window keeps the app running

let tray: Tray | undefined;
/** Quit was chosen (menu, tray, Cmd+Q): the window really closes. */
let quitting = false;

function keepInTray(): boolean {
  return settings.value(TRAY_SETTING) === true && !!Scheduler.current?.hasEnabledTasks();
}

/** Shows the window again (from the tray, a second start, the dock); the tray icon goes. */
function showWindow(): void {
  tray?.destroy();
  tray = undefined;
  if (!window || window.isDestroyed()) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function hideToTray(win: BrowserWindow): void {
  win.hide();
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(appRoot, 'media', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME}: scheduled tasks keep running`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showWindow());
}

/** While the window is in the tray, a task that fails or is skipped is told by the system. */
function notifyFromTray(task: { name: string }, status: string, error: string | undefined): void {
  if ((window && !window.isDestroyed() && window.isVisible()) || !Notification.isSupported()) return;
  if (status !== 'failed' && status !== 'skipped') return;
  const notification = new Notification({ title: APP_NAME, body: `Scheduled task "${task.name}" ${status === 'failed' ? 'failed' : 'was skipped'}: ${error ?? ''}` });
  notification.on('click', () => showWindow());
  notification.show();
}

/** The shell loaded: it is told what there is, then gets what was said while it wasn't listening. */
function shellStarted(): void {
  const pkg = packageJSON as PackageJson;
  const view = Object.values(pkg.contributes?.views ?? {}).flat()[0];
  const welcome = pkg.contributes?.viewsWelcome?.find((w) => w.view === view?.id)?.contents ?? '';
  const link = /\[([^\]]+)\]\(command:([^)]+)\)/.exec(welcome);
  shellReady = true;
  post({
    type: 'init',
    title: APP_NAME,
    viewTitle: view?.name ?? APP_NAME,
    welcome: { text: welcome.replace(/\[[^\]]+\]\([^)]+\)/g, '').trim(), button: link ? { command: link[2], title: link[1] } : undefined },
    theme: activeThemeInfo(),
    layout: layout(),
    platform: process.platform,
    themes: THEMES.map(themePreview),
    themeSetting: String(settings.value(THEME_SETTING)),
    menus: process.platform === 'darwin' ? [] : (Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []),
  });
  if (window) postWindowState(window);
  post({ type: 'viewTitle', actions: viewTitleActions() });
  announceLanguages();
  refreshStatus();
  for (const message of queued.splice(0)) post(message);
}

function listenToShell(): void {
  const fromShell = (frame: Electron.WebFrameMain | null) => !!window && !window.isDestroyed() && frame === window.webContents.mainFrame;
  ipcMain.on('shell', (event, message: ShellMessage) => {
    if (!fromShell(event.senderFrame)) return;
    if (message.type === 'ready') shellStarted();
    dispatch(message);
  });
  ipcMain.handle('shell-request', (event, name: string, args: unknown) => {
    if (!fromShell(event.senderFrame)) throw new Error('Not allowed');
    return answer(name, args);
  });

  onShell('tabs', (m) => {
    panelsShown(new Set(m.visible.filter((t) => t.kind === 'panel').map((t) => t.id)), m.active?.kind === 'panel' ? m.active.id : undefined);
    tabActivated(m.active?.kind, m.active?.id);
  });
  onShell('tabContext', (m) => {
    const send = (command: 'close' | 'closeOthers' | 'closeAll' | 'move') => () => post({ type: 'tabCommand', command, tab: m.tab });
    Menu.buildFromTemplate([
      { label: 'Close', click: send('close') },
      { label: 'Close Others', enabled: m.others, click: send('closeOthers') },
      { label: 'Close All', click: send('closeAll') },
      { type: 'separator' },
      { label: 'Move to the Other Side', click: send('move') },
    ]).popup({ window });
  });
  onShell('openExternal', (m) => {
    if (/^https?:\/\//.test(m.url)) void shell.openExternal(m.url);
  });
  // The title bar's menus are the application menu's, opened under their names: the application menu
  // itself is not shown without the system's title bar, but its shortcuts still work.
  onShell('openMenu', (m) => {
    const menu = Menu.getApplicationMenu()?.items[m.index]?.submenu;
    if (!window || !menu) return post({ type: 'menuClosed' });
    const zoom = window.webContents.getZoomFactor();
    menu.popup({ window, x: Math.round(m.x * zoom), y: Math.round(m.y * zoom), callback: () => post({ type: 'menuClosed' }) });
  });
  onShell('windowControl', (m) => {
    if (!window) return;
    if (m.action === 'minimize') window.minimize();
    else if (m.action === 'close') window.close();
    else if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
}

// ---- the menu bar

async function commandPalette(): Promise<void> {
  const name = vscode.window.activeTextEditor?.document.name;
  const items = paletteCommands({ resourceFilename: name, editorTextFocus: !!name, activeWebviewPanelId: activePanelViewType() }).map((c) => ({ label: c.title, command: c.command }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Type the name of a command to run' });
  if (picked) runCommand(picked.command);
}

/** Opens files in the editor: the playgrounds saved before, mostly. */
async function openFiles(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({ title: 'Open File', canSelectMany: true, filters: { 'Playgrounds and JSON': ['js', 'json'], 'All Files': ['*'] } });
  for (const uri of picked ?? []) {
    try {
      await vscode.window.showTextDocument(uri, { preview: false });
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function buildMenu(): void {
  const command = (id: string, accelerator?: string): MenuItemConstructorOptions => ({ label: action(id).title, accelerator, click: () => runCommand(id) });
  const shellCommand = (label: string, name: Extract<HostMessage, { type: 'shellCommand' }>['command'], accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => post({ type: 'shellCommand', command: name }),
  });
  const radio = (key: string, label: string, value: string): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: settings.value(key) === value,
    click: () => settings.set(key, value),
  });
  const themeItems = (kind: 'dark' | 'light') => THEMES.filter((t) => t.kind === kind).map((t) => radio(THEME_SETTING, t.label, t.id));
  const outputs = outputChannels();
  const mac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: '&File',
      submenu: [
        command('mongoster.newPlayground', 'CmdOrCtrl+N'),
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => void openFiles() },
        command('mongoster.addConnection'),
        command('mongoster.addConnectionWithOptions'),
        { type: 'separator' },
        shellCommand('Save', 'save', 'CmdOrCtrl+S'),
        shellCommand('Revert File', 'revert'),
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => vscode.openSettings() },
        { type: 'separator' },
        shellCommand('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
        ...(mac ? [] : [{ role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    { role: 'editMenu', label: '&Edit' },
    {
      label: '&View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => void commandPalette() },
        { type: 'separator' },
        shellCommand('Toggle Side Bar', 'toggleSidebar', 'CmdOrCtrl+B'),
        command('mongoster.refresh'),
        shellCommand('Next Tab', 'nextTab', 'Ctrl+PageDown'),
        shellCommand('Previous Tab', 'previousTab', 'Ctrl+PageUp'),
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [radio(THEME_SETTING, 'Follow the System', 'system'), { type: 'separator' }, ...themeItems('dark'), { type: 'separator' }, ...themeItems('light')],
        },
        { label: 'Layout', submenu: [radio(LAYOUT_SETTING, 'Islands', 'islands'), radio(LAYOUT_SETTING, 'Compact', 'compact')] },
        { label: 'Output', enabled: outputs.length > 0, submenu: outputs.map((name) => ({ label: name, click: () => void showOutput(name) })) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Tools',
      submenu: [
        command('mongoster.undoLast'),
        command('mongoster.showHistory'),
        command('mongoster.clearHistory'),
        { type: 'separator' },
        command('mongoster.showScheduledTasks'),
        { type: 'separator' },
        command('mongoster.mcp.setup'),
        command('mongoster.mcp.changePort'),
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Documentation', click: () => void shell.openExternal(`${REPOSITORY}#readme`) },
        { label: 'Report an Issue', click: () => void shell.openExternal(`${REPOSITORY}/issues`) },
        { type: 'separator' },
        {
          label: `About ${APP_NAME}`,
          click: () =>
            void vscode.window.showInformationMessage(`${APP_NAME} ${packageJSON.version}`, {
              modal: true,
              detail: `MongoDB client. Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node.js ${process.versions.node}.`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- start

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    showWindow();
  });

  void app.whenReady().then(() => {
    setRuntime({ appRoot, userData: app.getPath('userData'), packageJSON: packageJSON as PackageJson, post, window: () => window });
    handleProtocol();
    restrictPermissions();
    listenToShell();
    initAppearance();

    const context = vscode.createExtensionContext();
    context.subscriptions.push(vscode.registerBuiltinCommands());
    activate(context as never);

    buildMenu();
    // The radio buttons of the theme and the layout follow the settings, wherever they were changed from.
    settings.onDidChange((e) => {
      if (e.affectsConfiguration(THEME_SETTING) || e.affectsConfiguration(LAYOUT_SETTING)) {
        buildMenu();
        window?.setBackgroundColor(windowBackground());
      }
    });
    nativeTheme.on('updated', () => window?.setBackgroundColor(windowBackground()));
    createWindow();

    // One window, and the open tabs live in it: closing it quits the app, on macOS too, unless it goes
    // to the tray for the scheduled tasks (it is hidden then, not closed).
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', () => (quitting = true));
    app.on('activate', () => {
      if (tray) showWindow();
    });
    const ran = Scheduler.current?.onDidRun(({ task, run }) => notifyFromTray(task, run.status, run.error));
    if (ran) context.subscriptions.push(ran);
    app.on('will-quit', () => {
      for (const subscription of context.subscriptions.splice(0).reverse()) {
        try {
          subscription.dispose();
        } catch (err) {
          console.error(err);
        }
      }
      flushStorage();
    });
  });
}
