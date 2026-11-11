// The Scheduled Tasks tab: the periodic backups and exports with their next and last runs and run
// log; creating, editing, enabling, running, cancelling and deleting them. The scheduler runs them.
import * as vscode from 'vscode';
import * as os from 'os';
import type { ConnectionManager } from './connections';
import type { Scheduler } from './scheduler';
import { errorMessage } from './tree';
import { DEFAULT_PATTERN, describeSchedule, taskErrors, type ScheduledTask } from './shared/schedule';
import type { ScheduleHostMessage, ScheduleViewMessage, ScheduledTaskView } from './shared/messages';

/** Where the Back Up command saved last: the default folder of a new task. */
const BACKUP_FOLDER_KEY = 'mongoster.backupFolder';
export const TRAY_SETTING = 'mongoster.scheduledTasks.keepRunningInTray';

/** What `Schedule…` on the tree fills in. */
export interface TaskPrefill {
  connectionId: string;
  database?: string;
  collection?: string;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export class ScheduledTasksPanel {
  private static instance: ScheduledTasksPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** A form to open once the webview is ready. */
  private pending?: ScheduleHostMessage;
  private ready = false;

  static show(context: vscode.ExtensionContext, scheduler: Scheduler, connections: ConnectionManager, prefill?: TaskPrefill): void {
    const instance = ScheduledTasksPanel.instance ?? (ScheduledTasksPanel.instance = new ScheduledTasksPanel(context, scheduler, connections));
    instance.panel.reveal();
    if (prefill) instance.openForm(instance.newTask(prefill), true);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly scheduler: Scheduler,
    private readonly connections: ConnectionManager,
  ) {
    this.panel = vscode.window.createWebviewPanel('mongoster.scheduledTasks', 'Scheduled Tasks', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.disposables.push(
      scheduler.onDidChange(() => this.postInit()),
      connections.onDidChange(() => this.postInit()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(TRAY_SETTING)) this.postInit();
      }),
    );
    this.panel.onDidDispose(() => {
      ScheduledTasksPanel.instance = undefined;
      this.disposables.forEach((d) => d.dispose());
    });
    this.panel.webview.onDidReceiveMessage((m: ScheduleViewMessage) => void this.receive(m));
  }

  private post(m: ScheduleHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private defaultFolder(): string {
    return this.context.globalState.get<string>(BACKUP_FOLDER_KEY) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private postInit(): void {
    if (!this.ready) return;
    const tasks: ScheduledTaskView[] = this.scheduler.list().map((t) => {
      const info = this.connections.get(t.task.connectionId);
      return { ...t, connectionName: info?.name, color: info?.color };
    });
    this.post({
      type: 'init',
      tasks,
      connections: this.connections.list().map((c) => ({ id: c.id, name: c.name, color: c.color })),
      defaultFolder: this.defaultFolder(),
      app: vscode.env.appName === 'Mongoster',
      tray: vscode.workspace.getConfiguration().get<boolean>(TRAY_SETTING, false),
    });
  }

  private openForm(task: ScheduledTask, isNew: boolean): void {
    const message: ScheduleHostMessage = { type: 'edit', task, isNew };
    if (this.ready) this.post(message);
    else this.pending = message;
  }

  /** A new task: a daily archive backup at 02:00 keeping the last 7, of what was right-clicked. */
  private newTask(prefill?: TaskPrefill): ScheduledTask {
    const connectionId = prefill?.connectionId ?? this.connections.list()[0]?.id ?? '';
    const info = this.connections.get(connectionId);
    const what = prefill?.collection ? `${prefill.database}.${prefill.collection}` : prefill?.database ?? info?.name ?? '';
    return {
      id: newId(),
      name: what ? `Back up ${what}` : 'Backup',
      kind: 'backup',
      enabled: true,
      connectionId,
      database: prefill?.database,
      collection: prefill?.collection,
      format: 'archive',
      folder: this.defaultFolder(),
      pattern: DEFAULT_PATTERN,
      schedule: { kind: 'daily', time: '02:00' },
      keep: 7,
      runMissed: false,
      notifySuccess: false,
      since: Date.now(),
    };
  }

  private message(text: string, failed = false): void {
    this.post({ type: 'message', text, failed });
  }

  private async receive(m: ScheduleViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.postInit();
        if (this.pending) this.post(this.pending);
        this.pending = undefined;
        break;
      case 'new':
        this.openForm(this.newTask(), true);
        break;
      case 'edit': {
        const task = this.scheduler.get(m.id);
        if (task) this.openForm(task, false);
        break;
      }
      case 'save': {
        const errors = Object.values(taskErrors(m.task));
        if (!this.connections.get(m.task.connectionId)) errors.unshift('Choose a connection');
        if (errors.length) return this.message(errors[0]!, true);
        try {
          this.scheduler.save(m.task);
        } catch (err) {
          return this.message(`Could not save the task: ${errorMessage(err)}`, true);
        }
        this.post({ type: 'saved' });
        const saved = this.scheduler.list().find((t) => t.task.id === m.task.id);
        const next = saved?.next ? ` Next run: ${new Date(saved.next).toLocaleString()}.` : '';
        this.message(`Saved "${m.task.name}" (${describeSchedule(m.task.schedule)}).${m.task.enabled ? next : ' It is disabled.'}`);
        break;
      }
      case 'toggle':
        this.scheduler.setEnabled(m.id, m.enabled);
        break;
      case 'run': {
        const task = this.scheduler.get(m.id);
        if (!task) return;
        this.message('');
        void this.scheduler.runNow(m.id).then((outcome) => {
          if (outcome === 'busy') this.message(`"${task.name}" is already running${this.scheduler.list().find((t) => t.task.id === m.id)?.running === 'elsewhere' ? ' in another window' : ''}.`, true);
        });
        // It shows as running once it has started.
        setTimeout(() => this.postInit(), 200);
        break;
      }
      case 'cancel':
        this.scheduler.cancel(m.id);
        break;
      case 'delete': {
        const task = this.scheduler.get(m.id);
        if (!task) return;
        const answer = await vscode.window.showWarningMessage(
          `Delete the scheduled task "${task.name}"?`,
          { modal: true, detail: 'Its run log is deleted too. The backups and exports it wrote stay where they are.' },
          'Delete',
        );
        if (answer === 'Delete') this.scheduler.remove(m.id);
        break;
      }
      case 'names':
        try {
          const client = await this.connections.getClient(m.connectionId);
          const names = m.database
            ? (await client.db(m.database).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'))
            : (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
          this.post({ type: 'names', connectionId: m.connectionId, database: m.database, names: names.sort() });
        } catch (err) {
          this.post({ type: 'names', connectionId: m.connectionId, database: m.database, names: [], error: errorMessage(err) });
        }
        break;
      case 'browse': {
        const [folder] =
          (await vscode.window.showOpenDialog({
            title: 'Folder of the scheduled task',
            defaultUri: vscode.Uri.file(m.folder || this.defaultFolder()),
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Choose Folder',
          })) ?? [];
        if (folder) this.post({ type: 'folder', path: folder.fsPath });
        break;
      }
      case 'reveal':
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
        break;
      case 'traySetting':
        void vscode.commands.executeCommand('workbench.action.openSettings', TRAY_SETTING);
        break;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'monitor.css')}">
  <link rel="stylesheet" href="${asset('media', 'scheduledTasks.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Scheduled Tasks</title>
</head>
<body>
  <header class="bar">
    <span class="title">Scheduled Tasks</span>
    <span id="summary" class="info"></span>
    <div class="spacer"></div>
    <button id="new" title="A periodic backup or export">New Task…</button>
  </header>
  <div id="note" class="message notice hidden"></div>
  <div id="message" class="message hidden"></div>
  <div class="content">
    <form id="form" class="hidden" autocomplete="off"></form>
    <div class="table-wrap list"><table id="tasks"></table></div>
  </div>
  <script nonce="${nonce}" src="${asset('dist', 'scheduledTasks.js')}"></script>
</body>
</html>`;
  }
}
