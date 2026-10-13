// Mongoster as a desktop app: Electron's main process. It runs the same code as the VS Code extension
// (`activate` below), with the `vscode` module replaced by ./vscode, and a window (./shell) in place
// of VS Code's side bar, tabs and dialogs.
import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, Menu, MenuItemConstructorOptions, app, ipcMain, nativeTheme, protocol, session, shell } from 'electron';
import packageJSON from '../../package.json';
import { activate } from '../extension';
import type { HostMessage, ShellMessage } from './protocol';
import { themeInfo } from './theme';
import * as vscode from './vscode';
import { THEME_SETTING, initAppearance, themeKind } from './vscode/appearance';
import { answer, dispatch, onShell } from './vscode/bridge';
import { runCommand } from './vscode/commands';
import { action, paletteCommands } from './vscode/contributions';
import { announceLanguages, confirmCloseAll, showOutput, tabActivated } from './vscode/documents';
import { PackageJson, setRuntime } from './vscode/runtime';
import { flushStorage, settings } from './vscode/storage';
import { viewTitleActions } from './vscode/tree';
import { outputChannels, refreshStatus } from './vscode/ui';
import { APP_PROTOCOL, isResourceHost, panelDocument, panelOfHost, panelsShown } from './vscode/webview';

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

async function serveFile(root: string, relative: string): Promise<Response> {
  const file = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const body = await fs.promises.readFile(file);
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function handleProtocol(): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname);
    if (url.host === 'shell') return serveFile(shellDir, relative);
    if (isResourceHost(url.host)) {
      // The webviews only get what the extension ships: its scripts and its styles.
      if (!/^\/(dist|media)\//.test(path.posix.normalize(relative))) return new Response('Forbidden', { status: 403 });
      return serveFile(appRoot, relative);
    }
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
    (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') && !!origin?.startsWith(`${APP_PROTOCOL}://shell`);
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
    backgroundColor: themeInfo(themeKind()).vars['editor-background'],
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
  win.on('focus', () => vscode.windowFocusChanged(true));
  win.on('blur', () => vscode.windowFocusChanged(false));

  // The window only shows the app: links open in the browser, nothing else is loaded in it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-frame-navigate', (event) => {
    const allowed = event.isMainFrame ? `${APP_PROTOCOL}://shell/` : `${APP_PROTOCOL}://`;
    if (!event.url.startsWith(allowed)) event.preventDefault();
  });

  let closing = false;
  win.on('close', (event) => {
    saveWindowState(win);
    if (closing) return;
    event.preventDefault();
    void confirmCloseAll().then((ok) => {
      if (!ok) return;
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
    theme: themeInfo(themeKind()),
    platform: process.platform,
  });
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
}

// ---- the menu bar

async function commandPalette(): Promise<void> {
  const name = vscode.window.activeTextEditor?.document.name;
  const items = paletteCommands({ resourceFilename: name, editorTextFocus: !!name }).map((c) => ({ label: c.title, command: c.command }));
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
  const theme = settings.value(THEME_SETTING);
  const themeItem = (label: string, value: string): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme === value,
    click: () => settings.set(THEME_SETTING, value),
  });
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
    { role: 'editMenu' },
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
        { label: 'Theme', submenu: [themeItem('Follow the System', 'system'), themeItem('Dark', 'dark'), themeItem('Light', 'light')] },
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
    if (window.isMinimized()) window.restore();
    window.focus();
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
    // The theme's radio buttons follow the setting, wherever it was changed from.
    settings.onDidChange((e) => {
      if (e.affectsConfiguration(THEME_SETTING)) buildMenu();
    });
    nativeTheme.on('updated', () => window?.setBackgroundColor(themeInfo(themeKind()).vars['editor-background']));
    createWindow();

    // One window, and the open tabs live in it: closing it quits the app, on macOS too.
    app.on('window-all-closed', () => app.quit());
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
