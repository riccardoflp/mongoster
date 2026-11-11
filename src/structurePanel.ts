// Compare Structure tab: two databases (on the same or different connections, e.g. development and
// production) side by side, the differences of their collections, options and indexes, and the script
// or the changes that make the right one like the left one.
import * as vscode from 'vscode';
import type { ConnectionColor, ConnectionInfo, ConnectionManager } from './connections';
import { paintTab } from './connectionColors';
import { applyOp, readStructure } from './structure';
import { StructureDiff, diffStructure, diffTitle, orderForScript, planSummary } from './shared/structure';
import type { StructureHostMessage, StructureSide, StructureViewMessage } from './shared/messages';
import { errorMessage } from './tree';

export interface StructureTarget {
  connectionId: string;
  database: string;
}

type Side = 'left' | 'right';
type Item<T> = vscode.QuickPickItem & { value: T };

const targetKey = (t: StructureTarget) => `${t.connectionId}\u0000${t.database}`;
const count = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** Asks for a connection, with the given one first. */
async function pickConnection(connections: ConnectionManager, title: string, placeHolder: string, first?: ConnectionInfo): Promise<ConnectionInfo | undefined> {
  const all = connections.list();
  if (!all.length) {
    void vscode.window.showInformationMessage('Add a connection in the Mongoster view first.');
    return undefined;
  }
  const ordered = first ? [first, ...all.filter((c) => c.id !== first.id)] : all;
  const picked = await vscode.window.showQuickPick<Item<ConnectionInfo>>(
    ordered.map((c) => ({
      label: `$(${c.readOnly ? 'lock' : 'server'}) ${c.name}`,
      description: [c.id === first?.id ? 'same connection' : '', c.readOnly ? 'read-only' : '', c.folder ?? ''].filter(Boolean).join(' · '),
      value: c,
    })),
    { title, placeHolder, ignoreFocusOut: true },
  );
  return picked?.value;
}

/** Asks for a database of the connection, `prefer` first; `exclude` is left out. */
async function pickDatabase(connections: ConnectionManager, info: ConnectionInfo, title: string, prefer?: string, exclude?: string): Promise<string | undefined> {
  let databases: string[];
  try {
    const client = await connections.getClient(info.id);
    databases = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not connect to ${info.name}: ${errorMessage(err)}`);
    return undefined;
  }
  const candidates = databases.filter((d) => d !== exclude && !['admin', 'local', 'config'].includes(d));
  const ordered = [...candidates.filter((d) => d === prefer), ...candidates.filter((d) => d !== prefer).sort((a, b) => a.localeCompare(b))];
  if (!ordered.length) {
    void vscode.window.showInformationMessage(`${info.name} has no other database to compare with.`);
    return undefined;
  }
  return vscode.window.showQuickPick(ordered, { title, ignoreFocusOut: true });
}

export class StructurePanel {
  private static readonly panels = new Map<string, StructurePanel>();
  private readonly panel: vscode.WebviewPanel;
  /** Incremented by every comparison: an older one stops quietly. */
  private generation = 0;
  private diffs: StructureDiff[] = [];
  private running = false;

  /** "Compare Structure With…": picks the databases (the left one too from the Command Palette), then opens the comparison. */
  static async start(context: vscode.ExtensionContext, connections: ConnectionManager, left?: StructureTarget): Promise<void> {
    if (!left) {
      const info = await pickConnection(connections, 'Compare Structure: connection of the left database', 'The connection of the database to compare (the model)');
      if (!info) return;
      const database = await pickDatabase(connections, info, `Compare Structure: left database on ${info.name}`);
      if (!database) return;
      left = { connectionId: info.id, database };
    }
    const leftInfo = connections.get(left.connectionId);
    if (!leftInfo) return;
    const title = (step: string) => `Compare the structure of ${left!.database} with: ${step}`;
    const info = await pickConnection(connections, title('connection'), 'The connection of the other database, which the script changes (e.g. production)', leftInfo);
    if (!info) return;
    const database = await pickDatabase(connections, info, title(`database on ${info.name}`), left.database, info.id === leftInfo.id ? left.database : undefined);
    if (!database) return;
    StructurePanel.show(context, connections, left, { connectionId: info.id, database });
  }

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, left: StructureTarget, right: StructureTarget): StructurePanel {
    const key = `${targetKey(left)}\u0001${targetKey(right)}`;
    const existing = StructurePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const p = new StructurePanel(context, connections, left, right);
    StructurePanel.panels.set(key, p);
    p.panel.onDidDispose(() => {
      p.generation++;
      for (const [k, v] of StructurePanel.panels) if (v === p) StructurePanel.panels.delete(k);
    });
    return p;
  }

  /** Closes the comparisons that involve the connection (e.g. removed). */
  static close(connectionId: string): void {
    for (const p of [...StructurePanel.panels.values()]) if (p.left.connectionId === connectionId || p.right.connectionId === connectionId) p.panel.dispose();
  }

  /** Name, color and read-only changes. */
  static connectionChanged(info: ConnectionInfo): void {
    for (const p of StructurePanel.panels.values()) if (p.left.connectionId === info.id || p.right.connectionId === info.id) p.postInit();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private left: StructureTarget,
    private right: StructureTarget,
  ) {
    this.panel = vscode.window.createWebviewPanel('mongoster.compareStructure', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    paintTab(this.panel, context.extensionUri, this.color());
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: StructureViewMessage) => void this.receive(m));
  }

  private title(): string {
    return this.left.database === this.right.database ? `Structure: ${this.left.database}` : `Structure: ${this.left.database} ↔ ${this.right.database}`;
  }

  private post(m: StructureHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private target(side: Side): StructureTarget {
    return side === 'left' ? this.left : this.right;
  }

  private sideInfo(side: Side): StructureSide {
    const t = this.target(side);
    const info = this.connections.get(t.connectionId);
    const why = info?.readOnly ? `The connection ${info.name} is read-only.` : undefined;
    return { connectionName: info?.name ?? '?', database: t.database, readOnly: !!why, why, color: info?.color };
  }

  private where(side: Side): string {
    const s = this.sideInfo(side);
    return `${s.connectionName} › ${s.database}`;
  }

  /** The tab's color: the one both sides have, or the only one there is (comparing with production, say). */
  private color(): ConnectionColor | undefined {
    const [left, right] = [this.connections.get(this.left.connectionId)?.color, this.connections.get(this.right.connectionId)?.color];
    return left === right || !right ? left : !left ? right : undefined;
  }

  private postInit(): void {
    this.panel.title = this.title();
    paintTab(this.panel, this.context.extensionUri, this.color());
    this.post({ type: 'init', left: this.sideInfo('left'), right: this.sideInfo('right') });
  }

  private async receive(m: StructureViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postInit();
        break;
      case 'compare':
        await this.compare();
        break;
      case 'swap':
        this.generation++;
        [this.left, this.right] = [this.right, this.left];
        this.diffs = [];
        this.postInit();
        break;
      case 'apply':
        await this.apply(m.ids);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
      case 'openPlayground': {
        const info = this.connections.get(this.right.connectionId);
        await vscode.commands.executeCommand('mongoster.newPlayground', { connection: info, database: this.right.database, content: m.script });
        break;
      }
    }
  }

  private async compare(): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.running = true;
    const started = Date.now();
    const read = { left: [0, 0], right: [0, 0] };
    const progress = () => {
      const part = (side: Side) => (read[side][1] ? `${read[side][0]} of ${count(read[side][1], 'collection')}` : '…');
      if (current()) this.post({ type: 'progress', text: `Reading the structures… left ${part('left')}, right ${part('right')}` });
    };
    try {
      progress();
      const shape = async (side: Side) => {
        const t = this.target(side);
        const client = await this.connections.getClient(t.connectionId);
        return readStructure(client, t.database, (done, total) => {
          read[side] = [done, total];
          progress();
        });
      };
      const [left, right] = await Promise.all([shape('left'), shape('right')]);
      if (!current()) return;
      const result = diffStructure(left, right);
      this.diffs = result.diffs;
      this.post({ type: 'result', ...result, durationMs: Date.now() - started });
    } catch (err) {
      if (current()) this.post({ type: 'error', message: errorMessage(err) });
    } finally {
      if (current()) this.running = false;
    }
  }

  /** Makes the right side like the left one for the given differences (null: all of them), after a confirmation. */
  private async apply(ids: string[] | null): Promise<void> {
    const reply = (ok: boolean, message?: string, comparing?: boolean) => this.post({ type: 'applied', ok, message, comparing });
    const side = this.sideInfo('right');
    if (side.readOnly) return reply(false, `${side.why} Its structure can't be changed.`);
    if (this.running) return reply(false, 'Wait for the comparison to finish.');
    const selected = (ids ? this.diffs.filter((d) => ids.includes(d.id)) : this.diffs).filter((d) => d.kind !== 'same' && d.steps.length);
    if (!selected.length) return reply(false, 'Nothing to change: compare again.');
    const plan = planSummary(selected);
    if (!plan.steps && !plan.destructive) return reply(false, "These differences can't be applied by a command: the script says what to do.");

    const where = this.where('right');
    const single = selected.length === 1 ? selected[0] : undefined;
    const detail = [
      plan.steps ? `${count(plan.steps, 'change')}: ${this.describe(selected, false)}.` : '',
      plan.destructive ? `${count(plan.destructive, 'step')} ${plan.destructive === 1 ? 'drops' : 'drop'} something: ${this.describe(selected, true)}.` : '',
      plan.manual ? `${count(plan.manual, 'difference')} can't be applied by a command and ${plan.manual === 1 ? 'is' : 'are'} left out (the script says what to do).` : '',
      "Index builds can take a while on large collections. These changes can't be undone from the undo history.",
    ]
      .filter(Boolean)
      .join('\n');
    let drops: boolean;
    if (single) {
      const label = plan.destructive ? (plan.steps ? 'Apply and Drop' : 'Drop') : 'Apply';
      const answer = await vscode.window.showWarningMessage(`Apply to ${where}: ${single.collection} ${diffTitle(single)}?`, { modal: true, detail }, label);
      if (answer !== label) return reply(false);
      drops = true;
    } else {
      const withDrops = plan.steps ? 'Apply Including Drops' : 'Apply Drops';
      const buttons = [...(plan.steps ? ['Apply'] : []), ...(plan.destructive ? [withDrops] : [])];
      const answer = await vscode.window.showWarningMessage(`Make ${where} like ${this.where('left')}?`, { modal: true, detail }, ...buttons);
      if (!answer) return reply(false);
      drops = answer === withDrops;
    }

    this.running = true;
    let done = 0;
    const failures: string[] = [];
    try {
      const client = await this.connections.getClient(this.right.connectionId);
      for (const d of orderForScript(selected)) {
        for (const step of d.steps) {
          if (!step.op || (step.destructive && !drops)) continue;
          try {
            await applyOp(client, this.right.database, step.op);
            done++;
          } catch (err) {
            // The next steps of this difference need this one.
            failures.push(`${d.collection} ${diffTitle(d)}: ${errorMessage(err)}`);
            break;
          }
        }
      }
    } catch (err) {
      failures.push(errorMessage(err));
    } finally {
      this.running = false;
    }
    const message = [
      done ? `Applied ${count(done, 'change')} to ${where}.` : `Nothing was changed in ${where}.`,
      failures.length ? `${count(failures.length, 'difference')} failed: ${failures.slice(0, 3).join(' · ')}${failures.length > 3 ? ' …' : ''}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    reply(!failures.length, message, true);
    if (done) void vscode.commands.executeCommand('mongoster.refresh');
    await this.compare();
  }

  /** "createIndex ×3, collMod ×1" for the steps applied (or the destructive ones). */
  private describe(diffs: StructureDiff[], destructive: boolean): string {
    const kinds = new Map<string, number>();
    for (const d of diffs) for (const s of d.steps) if (s.op && !!s.destructive === destructive) kinds.set(s.op.type, (kinds.get(s.op.type) ?? 0) + 1);
    return [...kinds].map(([k, n]) => (n === 1 ? k : `${k} ×${n}`)).join(', ');
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
  <link rel="stylesheet" href="${asset('media', 'compare.css')}">
  <link rel="stylesheet" href="${asset('media', 'structure.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Compare Structure</title>
</head>
<body>
  <header class="sides">
    <div class="side" id="leftSide"></div>
    <button id="swap" class="icon" title="Swap the sides: the script then changes the other database">⇄</button>
    <div class="side" id="rightSide"></div>
  </header>
  <div class="toolbar">
    <span class="info">The script and <code>Apply…</code> make the right database like the left one.</span>
    <span class="spacer"></span>
    <button id="compare" class="primary" title="Read both structures again">Compare</button>
  </div>
  <div id="error" class="error hidden"></div>
  <div id="message" class="message hidden"></div>
  <div class="summary" id="summary"></div>
  <div class="notes hidden" id="notes"></div>
  <div class="bulk hidden" id="bulk">
    <span class="tabs" role="tablist" aria-label="Shown">
      <button id="showDiffs" role="tab" title="Only what differs">Only differences</button>
      <button id="showAll" role="tab" title="Also what is the same on both sides">All</button>
    </span>
    <label class="check" title="Steps that drop indexes, collections or data are in the script without the // in front"><input id="drops" type="checkbox"> Include drops in the script</label>
    <span class="spacer"></span>
    <button id="copyScript" class="secondary" title="Copy the mongosh script that makes the right database like the left one">Copy Script</button>
    <button id="openPlayground" class="secondary" title="Open the script in a new playground on the right connection">Open in Playground</button>
    <button id="applyAll" class="secondary" title="Apply every difference to the right database, after a confirmation">Apply All…</button>
  </div>
  <main class="list" id="list"></main>
  <script nonce="${nonce}" src="${asset('dist', 'structure.js')}"></script>
</body>
</html>`;
  }
}
