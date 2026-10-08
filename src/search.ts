// Global search: a tab that reads every document of a collection, a database or the whole deployment
// and lists those with the text (or an id, number, date, regular expression) in any field, nested ones
// included. MongoDB has no "any field" query, so the documents are read and matched here.
import * as vscode from 'vscode';
import { BSON, Document, FindCursor, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { DocumentFileSystem } from './documentFs';
import { fromRelaxed } from './queries';
import type { SearchCollection, SearchHit, SearchHostMessage, SearchOptions, SearchProgress, SearchResult, SearchViewMessage } from './shared/messages';
import { bucketNames } from './shared/gridfs';
import { formatFilter, relaxEjson, toShell } from './shared/query';
import { errorMessage } from './tree';

const { EJSON } = BSON;

/** Documents listed per collection; the others are counted (and opened with Open in Collection). */
export const SHOWN_PER_COLLECTION = 50;
/** _ids kept per collection for Open in Collection. */
export const IDS_KEPT = 1000;
/** Matches listed per document. */
const HITS_PER_DOC = 5;
/** Characters shown around a match. */
const CONTEXT = 40;
const MATCH_MAX = 120;
const FLUSH_MS = 200;
/** Collections read at the same time. */
const WORKERS = 3;
const SKIPPED_DATABASES = ['admin', 'local', 'config'];
/** Characters needed to match part of an ObjectId or UUID. */
const ID_MIN = 6;

export interface SearchScope {
  connectionId: string;
  database?: string;
  collection?: string;
}

const scopeKey = (s: SearchScope) => [s.connectionId, s.database ?? '', s.collection ?? ''].join('\u0000');
const relaxed = (v: unknown) => relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v);
const scopeTitle = (scope: SearchScope, info: ConnectionInfo) => `Search: ${scope.collection ?? scope.database ?? info.name}`;

// ---------------------------------------------------------------------------
// Matching

export interface Needle {
  re: RegExp;
  /** The same, ignoring case: for hex ids, UUIDs and dates. */
  ci: RegExp;
  /** Text mode: the text, compared with numbers and booleans as a whole value. */
  exact?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ObjectId("…"), ISODate("…"), UUID("…"), NumberLong(…), "text": the value inside. */
function unwrap(text: string): string {
  const call = /^(?:new\s+)?(?:ObjectId|ISODate|Date|UUID|NumberLong|NumberInt|NumberDecimal|Long|Int32|Double|Decimal128)\(\s*(['"]?)(.*?)\1\s*\)$/is.exec(text);
  if (call) return call[2];
  const quoted = /^(['"])(.*)\1$/s.exec(text);
  return quoted ? quoted[2] : text;
}

/** What to look for. Throws on an empty text or an invalid regular expression. */
export function needleOf(o: Pick<SearchOptions, 'text' | 'mode' | 'matchCase'>): Needle {
  const raw = o.text.trim();
  if (!raw) throw new Error('Type something to search.');
  if (o.mode === 'regex') {
    const literal = /^\/(.+)\/([a-z]*)$/s.exec(raw);
    const source = literal ? literal[1] : raw;
    let flags = (literal ? literal[2] : '').replace(/[gy]/g, '');
    if (!o.matchCase && !flags.includes('i')) flags += 'i';
    try {
      return { re: new RegExp(source, flags), ci: new RegExp(source, flags.includes('i') ? flags : `${flags}i`) };
    } catch (err) {
      // "Invalid regular expression: /([/: Unterminated character class"
      throw new Error((err as Error).message);
    }
  }
  const text = unwrap(raw);
  if (!text) throw new Error('Type something to search.');
  return { re: new RegExp(escapeRe(text), o.matchCase ? '' : 'i'), ci: new RegExp(escapeRe(text), 'i'), exact: text };
}

interface Leaf {
  kind: string;
  text: string;
  /** Matched as a whole value in text mode (numbers, booleans). */
  whole?: boolean;
  /** Matched ignoring case (hex, dates). */
  ci?: boolean;
  /** Text mode: shorter texts don't match part of it ("42" is a number, not a piece of an ObjectId). */
  minLength?: number;
}

/** The text a value is matched on; undefined for values not searched (null, MinKey, binary data…). */
function leafOf(v: unknown): Leaf | undefined {
  if (typeof v === 'string') return { kind: 'string', text: v };
  if (typeof v === 'boolean') return { kind: 'bool', text: String(v), whole: true };
  if (typeof v === 'number' || typeof v === 'bigint') return { kind: 'number', text: String(v), whole: true };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : { kind: 'date', text: v.toISOString(), ci: true };
  const b = v as { _bsontype?: string } & Record<string, unknown>;
  switch (b?._bsontype) {
    case 'ObjectId':
      return { kind: 'objectId', text: (v as BSON.ObjectId).toHexString(), ci: true, minLength: ID_MIN };
    case 'Int32':
    case 'Double':
      return { kind: 'number', text: String((v as BSON.Double).value), whole: true };
    case 'Long':
    case 'Decimal128':
      return { kind: 'number', text: String(v), whole: true };
    case 'Binary': {
      const bin = v as BSON.Binary;
      return bin.sub_type === BSON.Binary.SUBTYPE_UUID && bin.position === 16 ? { kind: 'uuid', text: bin.toUUID().toHexString(true), ci: true, minLength: ID_MIN } : undefined;
    }
    case 'BSONRegExp':
      return { kind: 'regex', text: (v as BSON.BSONRegExp).pattern };
    case 'Code':
      return { kind: 'code', text: (v as BSON.Code).code };
    case 'BSONSymbol':
      return { kind: 'string', text: String((v as BSON.BSONSymbol).value) };
    default:
      return undefined;
  }
}

const isDocument = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array) && !('_bsontype' in v);

const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ');

function hit(path: string, on: SearchHit['on'], kind: string, text: string, start: number, end: number): SearchHit {
  const from = Math.max(0, start - CONTEXT);
  const to = Math.min(text.length, end + CONTEXT);
  const match = text.slice(start, end);
  return {
    path,
    on,
    kind,
    before: (from > 0 ? '…' : '') + oneLine(text.slice(from, start)),
    match: oneLine(match.length > MATCH_MAX ? `${match.slice(0, MATCH_MAX)}…` : match),
    after: oneLine(text.slice(end, to)) + (to < text.length ? '…' : ''),
  };
}

function find(re: RegExp, text: string): [number, number] | undefined {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : undefined;
}

function sameNumber(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Number(a);
  const y = Number(b);
  return b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/** The matches in a document (deserialized with promoteValues: false); undefined when none. */
export function matchDocument(doc: Document, needle: Needle, fieldNames: boolean): SearchResult | undefined {
  const hits: SearchHit[] = [];
  let count = 0;
  const add = (h: () => SearchHit) => {
    if (++count <= HITS_PER_DOC) hits.push(h());
  };
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
      return;
    }
    if (isDocument(value)) {
      for (const [k, x] of Object.entries(value)) {
        const p = path ? `${path}.${k}` : k;
        if (fieldNames) {
          const m = find(needle.re, k);
          if (m) add(() => hit(p, 'key', 'field', k, m[0], m[1]));
        }
        walk(x, p);
      }
      return;
    }
    const leaf = leafOf(value);
    if (!leaf) return;
    let m: [number, number] | undefined;
    if (leaf.whole && needle.exact !== undefined) m = sameNumber(leaf.text, needle.exact) ? [0, leaf.text.length] : undefined;
    else if (leaf.minLength && needle.exact !== undefined && needle.exact.length < leaf.minLength && needle.exact.toLowerCase() !== leaf.text) m = undefined;
    else m = find(leaf.ci ? needle.ci : needle.re, leaf.text);
    if (m) add(() => hit(path, 'value', leaf.kind, leaf.text, m[0], m[1]));
  };
  walk(doc, '');
  if (!count) return undefined;
  const id = relaxed(doc._id);
  return { id, key: toShell(id), hits, more: count - hits.length };
}

// ---------------------------------------------------------------------------
// The tab

export class SearchPanel {
  private static readonly panels = new Map<string, SearchPanel>();
  private readonly panel: vscode.WebviewPanel;
  /** Incremented on every search and stop: the scans of an older search end quietly. */
  private generation = 0;
  private plan: SearchCollection[] = [];
  /** _ids of the matching documents, per collection of the plan. */
  private ids: unknown[][] = [];
  private matches: number[] = [];
  private cursors = new Set<FindCursor>();
  private pending = new Map<number, SearchProgress>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private searchId = 0;
  private running = false;
  private started = 0;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, documents: DocumentFileSystem, info: ConnectionInfo, scope: SearchScope): void {
    const existing = SearchPanel.panels.get(scopeKey(scope));
    if (existing) {
      existing.panel.reveal();
      return;
    }
    SearchPanel.panels.set(scopeKey(scope), new SearchPanel(context, connections, documents, info, scope));
  }

  static connectionChanged(info: ConnectionInfo): void {
    for (const p of SearchPanel.panels.values()) {
      if (p.scope.connectionId !== info.id) continue;
      p.info = info;
      p.panel.title = scopeTitle(p.scope, info);
      p.postInit();
    }
  }

  static close(connectionId: string): void {
    for (const p of [...SearchPanel.panels.values()]) if (p.scope.connectionId === connectionId) p.panel.dispose();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly documents: DocumentFileSystem,
    private info: ConnectionInfo,
    private readonly scope: SearchScope,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.search',
      scopeTitle(scope, info),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      SearchPanel.panels.delete(scopeKey(scope));
      this.stop();
    });
    this.panel.webview.onDidReceiveMessage((m: SearchViewMessage) => void this.receive(m));
  }

  private post(m: SearchHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private postInit(): void {
    this.post({ type: 'init', connectionName: this.info.name, color: this.info.color, database: this.scope.database, collection: this.scope.collection });
  }

  private client(): Promise<MongoClient> {
    return this.connections.getClient(this.info.id);
  }

  private async receive(m: SearchViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postInit();
        break;
      case 'search':
        await this.search(m.searchId, m.options);
        break;
      case 'stop': {
        const running = this.stop();
        if (running) this.post({ type: 'done', searchId: this.searchId, ms: Date.now() - this.started, stopped: true });
        break;
      }
      case 'openDocument':
        await this.documents.open(
          { connectionId: this.info.id, database: m.database, collection: m.collection, readOnly: !!this.info.readOnly || m.view },
          fromRelaxed(m.id),
        );
        break;
      case 'showInCollection':
        await this.showInCollection(m.index);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
    }
  }

  /** The collections to read, in order. */
  private async collections(options: SearchOptions): Promise<SearchCollection[]> {
    const client = await this.client();
    const { database, collection } = this.scope;
    let databases: string[];
    if (database) databases = [database];
    else {
      try {
        const res = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
        databases = res.databases.map((d) => d.name).filter((d) => !SKIPPED_DATABASES.includes(d));
      } catch {
        // Users without listDatabases privileges: the database named in the URI.
        databases = [client.options.dbName];
      }
      databases.sort((a, b) => a.localeCompare(b));
    }
    const plan: SearchCollection[] = [];
    for (const db of databases) {
      const infos = await client
        .db(db)
        .listCollections(collection ? { name: collection } : {}, { nameOnly: false, authorizedCollections: true })
        .toArray();
      // GridFS chunks are file contents, not documents to search.
      const chunks = new Set(bucketNames(infos.map((c) => c.name)).map((b) => `${b}.chunks`));
      const names = infos
        .filter((c) => collection || (!c.name.startsWith('system.') && !chunks.has(c.name) && (options.views || c.type !== 'view')))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const c of names) plan.push({ database: db, collection: c.name, view: c.type === 'view' });
    }
    await Promise.all(
      plan.map(async (c) => {
        if (c.view) return;
        c.estimate = await client
          .db(c.database)
          .collection(c.collection)
          .estimatedDocumentCount()
          .catch(() => undefined);
      }),
    );
    return plan;
  }

  private async search(searchId: number, options: SearchOptions): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.searchId = searchId;
    this.started = Date.now();
    this.running = true;
    let needle: Needle;
    let plan: SearchCollection[];
    try {
      needle = needleOf(options);
      plan = await this.collections(options);
    } catch (err) {
      if (generation !== this.generation) return;
      this.running = false;
      this.post({ type: 'failed', searchId, message: errorMessage(err) });
      return;
    }
    if (generation !== this.generation) return;
    this.plan = plan;
    this.ids = plan.map(() => []);
    this.matches = plan.map(() => 0);
    this.post({ type: 'plan', searchId, collections: plan });
    let next = 0;
    const worker = async () => {
      while (generation === this.generation && next < plan.length) await this.scan(next++, generation, needle, options);
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, plan.length) }, worker));
    if (generation !== this.generation) return;
    this.flush();
    this.generation++;
    this.running = false;
    this.post({ type: 'done', searchId, ms: Date.now() - this.started, stopped: false });
  }

  private async scan(index: number, generation: number, needle: Needle, options: SearchOptions): Promise<void> {
    const c = this.plan[index];
    const client = await this.client();
    const cursor = client
      .db(c.database)
      .collection(c.collection)
      .find({}, { promoteValues: false, bsonRegExp: true, batchSize: 500, ...(options.limit > 0 ? { limit: options.limit } : {}) });
    this.cursors.add(cursor);
    let scanned = 0;
    this.progress(index, { state: 'scanning', scanned });
    try {
      for await (const doc of cursor) {
        if (generation !== this.generation) return;
        scanned++;
        const result = matchDocument(doc, needle, options.fieldNames);
        if (result) {
          const n = ++this.matches[index];
          if (this.ids[index].length < IDS_KEPT) this.ids[index].push(result.id);
          this.progress(index, { scanned }, n <= SHOWN_PER_COLLECTION ? result : undefined);
        } else if (scanned % 250 === 0) this.progress(index, { scanned });
      }
      if (generation !== this.generation) return;
      this.progress(index, { state: 'done', scanned, partial: options.limit > 0 && scanned >= options.limit });
    } catch (err) {
      if (generation === this.generation) this.progress(index, { state: 'error', scanned, error: errorMessage(err) });
    } finally {
      this.cursors.delete(cursor);
      await cursor.close().catch(() => undefined);
    }
  }

  /** Queues an update of a collection's progress, sent at most every FLUSH_MS. */
  private progress(index: number, patch: Partial<SearchProgress>, result?: SearchResult): void {
    const p = this.pending.get(index) ?? { index, state: 'scanning', scanned: 0, matches: 0, results: [] };
    Object.assign(p, patch, { matches: this.matches[index] });
    if (result) p.results.push(result);
    this.pending.set(index, p);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.pending.size) return;
    this.post({ type: 'progress', searchId: this.searchId, updates: [...this.pending.values()] });
    this.pending.clear();
  }

  /** Stops the running search (at once: a stop right after a search applies to it); whether one was running. */
  private stop(): boolean {
    const running = this.running;
    this.running = false;
    this.flush();
    this.generation++;
    const cursors = [...this.cursors];
    this.cursors.clear();
    for (const c of cursors) void c.close().catch(() => undefined);
    return running;
  }

  private async showInCollection(index: number): Promise<void> {
    const c = this.plan[index];
    const ids = this.ids[index];
    if (!c || !ids?.length) return;
    const filter = formatFilter({ _id: ids.length === 1 ? ids[0] : { $in: ids } });
    await vscode.commands.executeCommand('mongoster.openQuery', {
      connectionId: this.info.id,
      database: c.database,
      collection: c.collection,
      query: { filter, sort: '', projection: '' },
      explain: false,
    });
    if (this.matches[index] > ids.length) {
      void vscode.window.showInformationMessage(`${c.collection}: the filter has the first ${ids.length.toLocaleString('en-US')} of ${this.matches[index].toLocaleString('en-US')} matching documents.`);
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
  <link rel="stylesheet" href="${asset('media', 'search.css')}">
  <title>Search</title>
</head>
<body>
  <header class="bar">
    <span id="title" class="title"></span>
    <span id="status" class="status hidden"></span>
    <div class="spacer"></div>
  </header>
  <section class="view">
    <div class="toolbar search-row">
      <input id="text" type="search" spellcheck="false" aria-label="Text to search" placeholder="Text, _id, number or date to find in any field  —  Enter searches">
      <select id="mode" aria-label="How to match" title="Contains: the text anywhere in a value (an _id, a number or a date as a whole); Regex: a regular expression">
        <option value="text">Contains</option>
        <option value="regex">Regex</option>
      </select>
      <button id="go">Search</button>
    </div>
    <div class="toolbar options">
      <label><input id="matchCase" type="checkbox"> Match case</label>
      <label title="Also find the text in field names"><input id="fieldNames" type="checkbox"> Field names</label>
      <label id="viewsOption" title="Views usually show documents of a collection already searched"><input id="views" type="checkbox"> Views</label>
      <label>Read
        <select id="limit" aria-label="Documents read per collection">
          <option value="0">every document</option>
          <option value="1000">the first 1,000</option>
          <option value="10000">the first 10,000</option>
          <option value="100000">the first 100,000</option>
        </select>
        per collection</label>
      <span id="summary" class="info"></span>
    </div>
    <div id="error" class="error hidden"></div>
    <div id="results" class="results" aria-live="polite"></div>
  </section>
  <script nonce="${nonce}" src="${asset('dist', 'search.js')}"></script>
</body>
</html>`;
  }
}
