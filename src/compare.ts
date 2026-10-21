// Comparing two collections (on the same or different connections, e.g. staging and production) by _id:
// documents on one side only, or different, with their changed fields; and making one side like the other.
// The left side is read first and kept as _id → hash of the document; the right side is then streamed
// against it, so only the hashes are held in memory.
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { AnyBulkWriteOperation, BSON, Collection, Document } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { DocumentFileSystem } from './documentFs';
import { toBson } from './queries';
import { CompareCounts, CompareOptions, DiffKind, comparable, fieldDiff } from './shared/compare';
import type { CompareEntry, CompareHostMessage, CompareSide, CompareViewMessage } from './shared/messages';
import { relaxEjson, toShell } from './shared/query';
import { errorMessage } from './tree';
import { UndoHistory } from './history';

const { EJSON } = BSON;

/** Documents read on each side at most: the left side's hashes are kept in memory. */
export const MAX_DOCUMENTS = 1_000_000;
/** Differences of each kind sent to the tab with their details. */
export const SHOWN_PER_KIND = 300;
const BATCH = 500;
const PREVIEW_MAX = 240;

export interface CompareTarget {
  connectionId: string;
  database: string;
  collection: string;
  isView: boolean;
}

type Side = 'left' | 'right';

const targetKey = (t: CompareTarget) => [t.connectionId, t.database, t.collection].join('\u0000');
const canonical = (v: unknown) => EJSON.serialize(v, { relaxed: false }) as unknown;
const keyOf = (id: unknown) => JSON.stringify(canonical(id));
const idOf = (key: string) => EJSON.deserialize({ v: JSON.parse(key) } as Document, { relaxed: false }).v;
const hash = (text: string) => createHash('sha1').update(text).digest('base64');

export class ComparePanel {
  private static readonly panels = new Map<string, ComparePanel>();
  private readonly panel: vscode.WebviewPanel;
  /** Incremented by every comparison and by Cancel: an older comparison stops quietly. */
  private generation = 0;
  /** Every difference of the last comparison, by _id key. */
  private kinds = new Map<string, DiffKind>();
  private options?: CompareOptions;
  private running = false;

  /** "Compare With…": picks the other collection, then opens the comparison. */
  static async start(
    context: vscode.ExtensionContext,
    connections: ConnectionManager,
    documents: DocumentFileSystem,
    left: CompareTarget,
  ): Promise<void> {
    const leftInfo = connections.get(left.connectionId);
    if (!leftInfo) return;
    const title = (step: string) => `Compare ${left.database}.${left.collection} with: ${step}`;
    type Item<T> = vscode.QuickPickItem & { value: T };

    const all = connections.list();
    const picked = await vscode.window.showQuickPick<Item<ConnectionInfo>>(
      [leftInfo, ...all.filter((c) => c.id !== leftInfo.id)].map((c) => ({
        label: `$(${c.readOnly ? 'lock' : 'server'}) ${c.name}`,
        description: [c.id === leftInfo.id ? 'same connection' : '', c.readOnly ? 'read-only' : '', c.folder ?? ''].filter(Boolean).join(' · '),
        value: c,
      })),
      { title: title('connection'), placeHolder: 'The connection of the other collection', ignoreFocusOut: true },
    );
    if (!picked) return;
    const info = picked.value;
    let databases: string[];
    try {
      const client = await connections.getClient(info.id);
      databases = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not connect to ${info.name}: ${errorMessage(err)}`);
      return;
    }
    const ordered = [...databases.filter((d) => d === left.database), ...databases.filter((d) => d !== left.database && !['local', 'config'].includes(d))];
    const database = await vscode.window.showQuickPick(ordered, { title: title(`database on ${info.name}`), ignoreFocusOut: true });
    if (!database) return;

    let list: { name: string; type?: string }[];
    try {
      list = await (await connections.getClient(info.id)).db(database).listCollections({}, { nameOnly: true }).toArray();
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
      return;
    }
    const same = (name: string) => info.id === leftInfo.id && database === left.database && name === left.collection;
    const candidates = list
      .filter((c) => !c.name.startsWith('system.') && !same(c.name))
      .sort((a, b) => Number(b.name === left.collection) - Number(a.name === left.collection) || a.name.localeCompare(b.name));
    if (!candidates.length) {
      void vscode.window.showInformationMessage(`${info.name} › ${database} has no other collection to compare with.`);
      return;
    }
    const coll = await vscode.window.showQuickPick<Item<{ name: string; type?: string }>>(
      candidates.map((c) => ({ label: `$(${c.type === 'view' ? 'eye' : 'table'}) ${c.name}`, description: c.type === 'view' ? 'view' : '', value: c })),
      { title: title(`collection in ${info.name} › ${database}`), ignoreFocusOut: true },
    );
    if (!coll) return;
    ComparePanel.show(context, connections, documents, left, { connectionId: info.id, database, collection: coll.value.name, isView: coll.value.type === 'view' });
  }

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, documents: DocumentFileSystem, left: CompareTarget, right: CompareTarget): ComparePanel {
    const key = `${targetKey(left)}\u0001${targetKey(right)}`;
    const existing = ComparePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const p = new ComparePanel(context, connections, documents, left, right);
    ComparePanel.panels.set(key, p);
    p.panel.onDidDispose(() => {
      p.generation++;
      for (const [k, v] of ComparePanel.panels) if (v === p) ComparePanel.panels.delete(k);
    });
    return p;
  }

  /** Closes the comparisons that involve the connection (e.g. removed). */
  static close(connectionId: string): void {
    for (const p of [...ComparePanel.panels.values()]) if (p.left.connectionId === connectionId || p.right.connectionId === connectionId) p.panel.dispose();
  }

  /** Name, color and read-only changes. */
  static connectionChanged(info: ConnectionInfo): void {
    for (const p of ComparePanel.panels.values()) if (p.left.connectionId === info.id || p.right.connectionId === info.id) p.postInit();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly documents: DocumentFileSystem,
    private left: CompareTarget,
    private right: CompareTarget,
  ) {
    this.panel = vscode.window.createWebviewPanel('mongoster.compare', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: CompareViewMessage) => void this.receive(m));
  }

  private title(): string {
    return this.left.collection === this.right.collection ? `Compare: ${this.left.collection}` : `Compare: ${this.left.collection} ↔ ${this.right.collection}`;
  }

  private post(m: CompareHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private target(side: Side): CompareTarget {
    return side === 'left' ? this.left : this.right;
  }

  private sideInfo(side: Side): CompareSide {
    const t = this.target(side);
    const info = this.connections.get(t.connectionId);
    const why = info?.readOnly ? `The connection ${info.name} is read-only.` : t.isView ? `${t.collection} is a view.` : undefined;
    return { connectionName: info?.name ?? '?', database: t.database, collection: t.collection, readOnly: !!why, why, color: info?.color };
  }

  private postInit(): void {
    this.panel.title = this.title();
    this.post({ type: 'init', left: this.sideInfo('left'), right: this.sideInfo('right'), options: this.options });
  }

  private async coll(side: Side): Promise<Collection> {
    const t = this.target(side);
    return (await this.connections.getClient(t.connectionId)).db(t.database).collection(t.collection);
  }

  private async receive(m: CompareViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postInit();
        break;
      case 'compare':
        await this.compare(m.options);
        break;
      case 'cancel':
        this.generation++;
        this.running = false;
        this.post({ type: 'cancelled' });
        break;
      case 'apply':
        await this.apply(m.to, m.keys);
        break;
      case 'loadDocument':
        await this.loadDocument(m.key, m.side);
        break;
      case 'openDocument': {
        const t = this.target(m.side);
        await this.documents.open({ connectionId: t.connectionId, database: t.database, collection: t.collection, readOnly: this.sideInfo(m.side).readOnly }, idOf(m.key));
        break;
      }
      case 'swap':
        this.generation++;
        [this.left, this.right] = [this.right, this.left];
        this.kinds.clear();
        this.postInit();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
    }
  }

  private async compare(options: CompareOptions): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.options = options;
    this.running = true;
    const started = Date.now();
    const norm = { ignore: options.ignore, ignoreOrder: options.ignoreOrder, numbersByValue: options.numbersByValue };
    let lastProgress = 0;
    const counted = { left: 0, right: 0 };
    const progress = (phase: 'left' | 'right' | 'details', force = false) => {
      if (!force && Date.now() - lastProgress < 200) return;
      lastProgress = Date.now();
      this.post({ type: 'progress', phase, ...counted });
    };
    try {
      const filter = toBson(options.filter, 'Filter') ?? {};
      const [lc, rc] = await Promise.all([this.coll('left'), this.coll('right')]);
      const hashes = new Map<string, string>();
      const tooMany = (side: Side) =>
        new Error(`${this.sideInfo(side).collection} has more than ${MAX_DOCUMENTS.toLocaleString('en-US')} documents to compare: narrow them with a filter.`);

      progress('left', true);
      for await (const doc of lc.find(filter, { promoteValues: false, batchSize: 1000 })) {
        if (!current()) return;
        const c = canonical(doc) as Document;
        hashes.set(JSON.stringify(c._id), hash(comparable(c, norm)));
        if (++counted.left > MAX_DOCUMENTS) throw tooMany('left');
        progress('left');
      }

      const kinds = new Map<string, DiffKind>();
      const counts: CompareCounts = { identical: 0, different: 0, onlyLeft: 0, onlyRight: 0 };
      progress('right', true);
      for await (const doc of rc.find(filter, { promoteValues: false, batchSize: 1000 })) {
        if (!current()) return;
        const c = canonical(doc) as Document;
        const key = JSON.stringify(c._id);
        const h = hashes.get(key);
        if (h === undefined) {
          kinds.set(key, 'onlyRight');
          counts.onlyRight++;
        } else {
          hashes.delete(key);
          if (h === hash(comparable(c, norm))) counts.identical++;
          else {
            kinds.set(key, 'different');
            counts.different++;
          }
        }
        if (++counted.right > MAX_DOCUMENTS) throw tooMany('right');
        progress('right');
      }
      for (const key of hashes.keys()) {
        kinds.set(key, 'onlyLeft');
        counts.onlyLeft++;
      }
      hashes.clear();
      this.kinds = kinds;

      // Details of the first differences of each kind.
      progress('details', true);
      const first = (kind: DiffKind) => [...kinds].filter(([, k]) => k === kind).slice(0, SHOWN_PER_KIND).map(([key]) => key);
      const entries: CompareEntry[] = [];
      const different = first('different');
      const [leftDocs, rightDocs] = await Promise.all([this.fetch('left', [...different, ...first('onlyLeft')]), this.fetch('right', [...different, ...first('onlyRight')])]);
      if (!current()) return;
      for (const key of different) {
        const l = leftDocs.get(key);
        const r = rightDocs.get(key);
        if (!l || !r) continue;
        const fields = fieldDiff(l, r, norm, relaxEjson);
        entries.push({ kind: 'different', key, id: relaxEjson(l._id), fields: fields.length ? fields : [{ path: '(field order)' }] });
      }
      for (const [kind, docs] of [
        ['onlyLeft', leftDocs],
        ['onlyRight', rightDocs],
      ] as const) {
        for (const key of first(kind)) {
          const doc = docs.get(key);
          if (!doc) continue;
          const text = toShell(relaxEjson(doc));
          entries.push({ kind, key, id: relaxEjson(doc._id), preview: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text });
        }
      }
      this.post({ type: 'result', counts, entries, durationMs: Date.now() - started });
    } catch (err) {
      if (current()) this.post({ type: 'error', message: errorMessage(err) });
    } finally {
      if (current()) this.running = false;
    }
  }

  /** Documents by _id key, canonical EJSON. */
  private async fetch(side: Side, keys: string[]): Promise<Map<string, Document>> {
    const out = new Map<string, Document>();
    const coll = await this.coll(side);
    for (let i = 0; i < keys.length; i += BATCH) {
      const ids = keys.slice(i, i + BATCH).map(idOf);
      for (const doc of await coll.find({ _id: { $in: ids } }, { promoteValues: false }).toArray()) {
        const c = canonical(doc) as Document;
        out.set(JSON.stringify(c._id), c);
      }
    }
    return out;
  }

  private async loadDocument(key: string, side: Side): Promise<void> {
    try {
      const doc = await (await this.coll(side)).findOne({ _id: idOf(key) }, { promoteValues: false });
      this.post({ type: 'document', key, side, doc: doc ? relaxEjson(canonical(doc)) : undefined, error: doc ? undefined : 'The document no longer exists.' });
    } catch (err) {
      this.post({ type: 'document', key, side, error: errorMessage(err) });
    }
  }

  /**
   * Makes side `to` like the other one for the given differences (null: all of them): documents missing
   * there are inserted, different ones replaced, and those only there deleted (for all the differences,
   * only when confirmed).
   */
  private async apply(to: Side, keys: string[] | null): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'applied', ok, message });
    const side = this.sideInfo(to);
    if (side.readOnly) return reply(false, `${side.why} Its documents can't be changed.`);
    if (this.running) return reply(false, 'Wait for the comparison to finish.');
    const from: Side = to === 'right' ? 'left' : 'right';
    const missing: DiffKind = to === 'right' ? 'onlyLeft' : 'onlyRight';
    const extra: DiffKind = to === 'right' ? 'onlyRight' : 'onlyLeft';
    const selected = (keys ?? [...this.kinds.keys()]).filter((k) => this.kinds.has(k));
    const inserts = selected.filter((k) => this.kinds.get(k) === missing);
    const replaces = selected.filter((k) => this.kinds.get(k) === 'different');
    const deletes = selected.filter((k) => this.kinds.get(k) === extra);
    if (!selected.length) return reply(false, 'Nothing to change: compare again.');

    const where = `${side.connectionName} › ${side.database}.${side.collection}`;
    const n = (count: number, verb: string) => (count ? `${verb} ${count.toLocaleString('en-US')}` : '');
    const plan = (withDeletes: boolean) => [n(inserts.length, 'insert'), n(replaces.length, 'replace'), withDeletes ? n(deletes.length, 'delete') : ''].filter(Boolean).join(', ');
    const docs = (count: number) => `document${count === 1 ? '' : 's'}`;
    let withDeletes: boolean;
    if (keys) {
      const total = inserts.length + replaces.length + deletes.length;
      const answer = await vscode.window.showWarningMessage(
        `Make ${to} like ${from}: ${plan(true)} ${docs(total)} in ${where}?`,
        { modal: true, detail: `Documents are written as they are now on the other side. ${UndoHistory.note(this.target(to).connectionId, total)}` },
        'Apply',
      );
      if (answer !== 'Apply') return reply(false);
      withDeletes = true;
    } else {
      const copies = inserts.length + replaces.length;
      const buttons = [...(copies ? ['Apply'] : []), ...(deletes.length ? [copies ? `Apply and Delete ${deletes.length.toLocaleString('en-US')}` : 'Delete'] : [])];
      const answer = await vscode.window.showWarningMessage(
        `Make ${to} like ${from} in ${where}?`,
        {
          modal: true,
          detail: [
            copies ? `${plan(false)} ${docs(copies)} from the ${from} side.` : '',
            deletes.length ? `${deletes.length.toLocaleString('en-US')} ${docs(deletes.length)} only on the ${to} side can also be deleted.` : '',
            UndoHistory.note(this.target(to).connectionId, copies + deletes.length),
          ]
            .filter(Boolean)
            .join('\n'),
        },
        ...buttons,
      );
      if (!answer) return reply(false);
      withDeletes = answer !== 'Apply';
      if (answer === 'Delete') {
        inserts.length = 0;
        replaces.length = 0;
      }
    }

    try {
      const source = await this.coll(from);
      const target = await this.coll(to);
      const other = this.sideInfo(from);
      const rec = UndoHistory.start(
        this.target(to),
        `Make like ${other.connectionName} › ${other.database}.${other.collection}`,
        inserts.length + replaces.length + (withDeletes ? deletes.length : 0),
      );
      let written = 0;
      const copies = [...inserts, ...replaces];
      for (let i = 0; i < copies.length; i += BATCH) {
        const ids = copies.slice(i, i + BATCH).map(idOf);
        const ops: AnyBulkWriteOperation[] = (await source.find({ _id: { $in: ids } }, { promoteValues: false }).toArray()).map((doc) => ({
          replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
        }));
        if (ops.length) {
          await rec?.snapshotIds(target, ops.map((op) => ('replaceOne' in op ? op.replaceOne.filter._id : undefined)));
          const res = await target.bulkWrite(ops, { ordered: false });
          written += res.upsertedCount + res.modifiedCount + (res.matchedCount - res.modifiedCount);
        }
      }
      let deleted = 0;
      if (withDeletes) {
        for (let i = 0; i < deletes.length; i += BATCH) {
          const ids = deletes.slice(i, i + BATCH).map(idOf);
          await rec?.snapshotIds(target, ids);
          deleted += (await target.deleteMany({ _id: { $in: ids } })).deletedCount;
        }
      }
      await rec?.commit(target);
      const message = [written ? `Wrote ${written.toLocaleString('en-US')} ${docs(written)}` : '', deleted ? `deleted ${deleted.toLocaleString('en-US')}` : ''].filter(Boolean).join(', ') || 'Nothing changed';
      reply(true, `${message} in ${where}.`);
      void vscode.commands.executeCommand('mongoster.refresh');
    } catch (err) {
      reply(false, errorMessage(err));
    }
    if (this.options) await this.compare(this.options);
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
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Compare</title>
</head>
<body>
  <header class="sides">
    <div class="side" id="leftSide"></div>
    <button id="swap" class="icon" title="Swap the sides">⇄</button>
    <div class="side" id="rightSide"></div>
  </header>
  <div class="toolbar">
    <label for="filter">Filter</label>
    <input id="filter" spellcheck="false" placeholder="{ status: &quot;active&quot; }  —  documents compared on both sides">
    <label for="ignore">Ignore</label>
    <input id="ignore" spellcheck="false" placeholder="updatedAt, __v" title="Fields left out of the comparison, separated by commas (address.zip, items.price…)">
  </div>
  <div class="toolbar">
    <label class="check" title="Documents whose fields are the same in a different order are equal"><input id="ignoreOrder" type="checkbox" checked> Ignore field order</label>
    <label class="check" title="1 (int), 1.0 (double) and NumberLong(1) are equal"><input id="numbersByValue" type="checkbox" checked> Compare numbers by value</label>
    <span class="spacer"></span>
    <button id="compare" class="primary" title="Compare (Enter in the fields)">Compare</button>
    <button id="cancel" class="secondary hidden">Cancel</button>
  </div>
  <div id="error" class="error hidden"></div>
  <div id="message" class="message hidden"></div>
  <div class="summary" id="summary"></div>
  <div class="bulk hidden" id="bulk">
    <button id="toRight" class="secondary" title="Insert the documents missing on the right, replace the different ones (and optionally delete those only on the right)">Make right like left…</button>
    <button id="toLeft" class="secondary" title="Insert the documents missing on the left, replace the different ones (and optionally delete those only on the left)">Make left like right…</button>
    <span id="shownInfo" class="info"></span>
  </div>
  <main class="list" id="list"></main>
  <script nonce="${nonce}" src="${asset('dist', 'compare.js')}"></script>
</body>
</html>`;
  }
}
