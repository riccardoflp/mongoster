// MCP tools on Mongoster's own state and tabs: the writes made through Mongoster (its undo history), the
// redis-oplog publishing of a connection, the queries the user saved, and tabs opened for the user (Watch,
// server monitor, explain, Undo History). Everything that touches VS Code goes through WorkspaceHost.
import type { Document } from 'mongodb';
import type { ConnectionInfo } from '../connections';
import type { HistoryEntry, HistoryUsage, MonitorTab, QueryText, SavedQuery } from '../shared/messages';
import { McpTool, ToolError, boolArg, intArg, stringArg, truncate } from '../shared/mcp';
import { inScope, oplogMessage } from '../shared/oplog';
import type { PipelineStage } from '../shared/pipeline';
import {
  MAX_OUTPUT,
  ToolContext,
  collectionProp,
  connectionProp,
  databaseProp,
  documentsText,
  filterProp,
  message,
  pipelineProp,
  plural,
  projectionProp,
  shell,
  sortProp,
} from './context';

/** Sections of the server monitor, as the tool names them. */
export const MONITOR_SECTIONS = ['operations', 'slow-queries', 'stats', 'replication', 'sharding'] as const;
export type MonitorSection = (typeof MONITOR_SECTIONS)[number];
/** The monitor's section (MonitorTab) of each section name. */
export const MONITOR_TABS: Record<MonitorSection, MonitorTab> = {
  operations: 'ops',
  'slow-queries': 'profile',
  stats: 'stats',
  replication: 'repl',
  sharding: 'shard',
};

/** A document recorded by one write of the undo history: as it was before (null: the write inserted it). */
export interface RecordedDocument {
  id: unknown;
  before: Document | null;
  /** Fingerprint after the write; null when the write deleted it. */
  after?: string | null;
}

/** A connection, and optionally a database and collection in it. */
export interface WorkspaceScope {
  connectionId: string;
  database?: string;
  collection?: string;
}

/** The arguments of the `mongoster.openQuery` command. */
export interface OpenQueryArgs {
  connectionId: string;
  database: string;
  collection: string;
  query: QueryText;
  explain: boolean;
}

/** What the workspace tools need from the extension (a fake one in the tests). */
export interface WorkspaceHost {
  /** The undo history, newest first (UndoHistory.list()). */
  history(): Promise<HistoryEntry[]>;
  /** `mongoster.history.enabled`. */
  historyEnabled(): boolean;
  /** Limits and space of the undo history (UndoHistory.usage()). */
  historyUsage(): HistoryUsage;
  /** The documents recorded by a write; rejects when its record is gone. */
  historyDocuments(id: string): Promise<RecordedDocument[]>;
  /** The saved (named) queries of a collection, the user's (QueryHistory) and the project's (ProjectQueries, `source: 'project'`), and its recent ones. */
  queries(ref: { connectionId: string; database: string; collection: string }): { saved: SavedQuery[]; recent: SavedQuery[] };
  /** Whether the connection's Redis URL is stored (never the URL). */
  redisUrlSet(connectionId: string): Promise<boolean>;
  /** Connects to the connection's Redis and PINGs it: undefined when it answers, else the error, without the URL. */
  checkRedis(connectionId: string): Promise<string | undefined>;
  /** The last error publishing the connection's writes to Redis, if the extension keeps it. */
  redisLastError?(connectionId: string): { time: number; message: string } | undefined;
  /** Opens the Watch tab (change stream) of the scope. */
  openWatch(info: ConnectionInfo, scope: WorkspaceScope): void;
  /** Opens the server monitor of the connection, on a section when given. */
  openMonitor(info: ConnectionInfo, section?: MonitorSection): void;
  /** Runs the `mongoster.openQuery` command. */
  openQuery(args: OpenQueryArgs): Promise<void>;
  /** Opens the Undo History tab. */
  openHistory(): void;
}

/** "2024-05-01T10:20:30Z". */
const time = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Anything that looks like a Redis URL, in case one ends up in an error message. */
const hideUrls = (text: string) => text.replace(/rediss?:\/\/\S+/gi, '<Redis URL>');
/** Stored mongosh text on one line. */
const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, ' ');

/** One line of the undo history. */
function entryLine(e: HistoryEntry): string {
  const counts = [e.inserted && `${e.inserted.toLocaleString('en-US')} inserted`, e.updated && `${e.updated.toLocaleString('en-US')} updated`, e.deleted && `${e.deleted.toLocaleString('en-US')} deleted`].filter(Boolean);
  return [
    `- id ${e.id}`,
    time(e.time),
    `${e.connectionName} › ${e.database}.${e.collection}`,
    e.label,
    counts.join(', ') || 'no documents',
    ...(e.undone ? [`undone ${time(e.undone)}`] : []),
    ...(e.undoOf ? [`undo of ${e.undoOf}`] : []),
  ].join(' · ');
}

/** A saved or recent query as indented lines: filter, sort, projection, or the pipeline. */
function queryLines(q: SavedQuery): string[] {
  if (q.pipeline) {
    const stage = (s: PipelineStage) => `{ ${s.op.trim()}: ${oneLine(s.body)} }`;
    const enabled = q.pipeline.filter((s) => s.enabled);
    const disabled = q.pipeline.filter((s) => !s.enabled);
    return [`  pipeline: [ ${enabled.map(stage).join(', ')} ]`, ...(disabled.length ? [`  disabled stages: ${disabled.map(stage).join(', ')}`] : [])];
  }
  const parts = (['filter', 'sort', 'projection'] as const).filter((k) => q[k].trim()).map((k) => `  ${k}: ${oneLine(q[k])}`);
  return parts.length ? parts : ['  filter: {}'];
}

/** The tools on Mongoster's own state (undo history, redis-oplog, saved queries) and the tabs they open. */
export function workspaceTools(ctx: ToolContext, host: WorkspaceHost): McpTool[] {
  const { connections, connection, client, required, target, query, pipeline } = ctx;

  /** Why writes through a connection aren't in the history; undefined when they are. */
  const notRecorded = (info: ConnectionInfo): string | undefined =>
    info.readOnly ? `${info.name} is read-only: Mongoster makes no writes through it.` : info.noHistory ? `The undo history is off for ${info.name}: its writes aren't recorded.` : undefined;

  return [
    {
      name: 'mongoster_writes',
      title: 'Writes made through Mongoster',
      description:
        "The writes the user made through Mongoster (its undo history), newest first: id, time (UTC), connection, database.collection, what was done, documents inserted/updated/deleted, whether it was undone or is an undo. Use it to answer \"did I change this from Mongoster, and when?\". Writes made by other clients aren't here. Pass an id to mongoster_write_details for the documents as they were before.",
      inputSchema: {
        type: 'object',
        properties: {
          connection: { ...connectionProp, description: 'Only the writes through this connection (name or id).' },
          database: { type: 'string', description: 'Only the writes on this database.' },
          collection: { type: 'string', description: 'Only the writes on this collection (needs database).' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Writes returned.' },
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = stringArg(args, 'connection') ? connection(args) : undefined;
        const database = stringArg(args, 'database');
        const collection = stringArg(args, 'collection');
        if (collection && !database) throw new ToolError('collection needs database.');
        const limit = intArg(args, 'limit', 20, 1, 200);
        const all = (await host.history()).sort((a, b) => b.time - a.time);
        const matching = all.filter((e) => (!info || e.connectionId === info.id) && (!database || e.database === database) && (!collection || e.collection === collection));
        const usage = host.historyUsage();
        const where = [info && `through ${info.name}`, collection ? `on ${database}.${collection}` : database && `on ${database}`].filter(Boolean).join(' ');
        const lines = [
          matching.length
            ? `${plural(matching.length, 'write')}${where ? ` ${where}` : ''} in the undo history${matching.length > limit ? `, the newest ${limit}` : ''} (newest first):`
            : `No writes${where ? ` ${where}` : ''} in the undo history.`,
          ...matching.slice(0, limit).map(entryLine),
          '',
          `The history keeps up to ${plural(usage.maxEntries, 'write')} from the last ${plural(usage.maxDays, 'day')}, of up to ${plural(usage.maxDocuments, 'document')} each: older or larger writes aren't listed.`,
        ];
        if (!host.historyEnabled()) lines.push("The undo history is off (setting mongoster.history.enabled): new writes aren't recorded.");
        if (info) {
          const why = notRecorded(info);
          if (why) lines.push(why);
        } else {
          const off = connections.list().filter((c) => notRecorded(c));
          if (off.length) lines.push(`Writes aren't recorded for: ${off.map((c) => `${c.name} (${c.readOnly ? 'read-only' : 'history off'})`).join(', ')}.`);
        }
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'mongoster_write_details',
      title: 'Documents before a Mongoster write',
      description:
        'The documents one write of Mongoster\'s undo history changed, as they were before it, in mongosh syntax: those updated and deleted in full, those inserted by their _id only. Take the id from mongoster_writes. Writes already undone no longer keep their documents.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The write\'s id, from mongoster_writes.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Documents returned.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      readOnly: true,
      documents: true,
      run: async (args) => {
        const id = required(args, 'id');
        const limit = intArg(args, 'limit', 20, 1, 100);
        const entry = (await host.history()).find((e) => e.id === id);
        if (!entry) throw new ToolError(`No write ${id} in the undo history: use mongoster_writes (it may have been removed by the history's limits).`);
        if (entry.undone) throw new ToolError(`The write ${id} was undone on ${time(entry.undone)}: its documents are no longer kept.`);
        let docs: RecordedDocument[];
        try {
          docs = await host.historyDocuments(id);
        } catch (err) {
          throw new ToolError(`The documents of ${id} can't be read: ${message(err)}`);
        }
        const shown = docs.slice(0, limit);
        const updated = shown.filter((d) => d.before && d.after !== null).map((d) => d.before!);
        const deleted = shown.filter((d) => d.before && d.after === null).map((d) => d.before!);
        const inserted = shown.filter((d) => !d.before).map((d) => d.id);
        const lines = [
          entryLine(entry).slice(2),
          `${plural(docs.length, 'document')} recorded${docs.length > shown.length ? `, the first ${shown.length} shown` : ''}.`,
        ];
        if (updated.length) lines.push('', 'Updated, as they were before:', `[\n${documentsText(updated)}\n]`);
        if (deleted.length) lines.push('', 'Deleted, as they were:', `[\n${documentsText(deleted)}\n]`);
        if (inserted.length) lines.push('', `Inserted (only their _id is kept): ${inserted.map((i) => shell(i)).join(', ')}`);
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'redis_oplog_status',
      title: 'Redis-oplog publishing of a connection',
      description:
        "Whether Mongoster publishes its own writes through a connection to Redis for redis-oplog (Meteor), with the channel prefix, namespaces and the database/collection patterns published; for a database or collection, whether its writes are published and on which channels. check: true also tests that Redis answers. The Redis URL is never returned.",
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: { type: 'string', description: 'Tell whether the writes on this database are published.' },
          collection: { type: 'string', description: 'Tell whether the writes on this collection are published, and the channels (needs database).' },
          check: { type: 'boolean', default: false, description: 'Connect to Redis and check it answers.' },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = stringArg(args, 'database');
        const collection = stringArg(args, 'collection');
        if (collection && !database) throw new ToolError('collection needs database.');
        const check = boolArg(args, 'check', false);
        const settings = info.redisOplog;
        if (!settings) return `${info.name} doesn't publish Mongoster's writes to Redis for redis-oplog (it can be turned on in the connection's options).`;
        const urlSet = await host.redisUrlSet(info.id);
        const scope = settings.scope ?? [];
        const lines = [
          `${info.name} publishes Mongoster's writes to Redis for redis-oplog.`,
          `Redis URL: ${urlSet ? 'set' : 'missing: nothing can be published until it is set again in the connection'}.`,
          `Channel prefix: ${settings.prefix ? JSON.stringify(settings.prefix) : 'none'}.`,
          `Namespaces: ${settings.namespaces?.length ? settings.namespaces.join(', ') : 'none'}.`,
          `Published: ${scope.length ? scope.join(', ') : 'every database and collection'}.`,
        ];
        if (info.readOnly) lines.push(`${info.name} is read-only: Mongoster makes no writes through it, so nothing is published.`);
        if (database && collection) {
          const m = oplogMessage(settings, collection, { e: 'i', id: '<_id>' });
          lines.push(
            '',
            inScope(scope, database, collection)
              ? `The writes on ${database}.${collection} are published, on the channels ${m!.channels.map((c) => JSON.stringify(c)).join(', ')} (<_id> is the document's id as redis-oplog writes it; the channel names don't include the database).`
              : `The writes on ${database}.${collection} are not published (no pattern matches).`,
          );
        } else if (database) {
          const whole = !scope.length || scope.some((p) => !p.includes('.') && inScope([p], database, ''));
          const some = scope.filter((p) => p.includes('.') && inScope([p.slice(0, p.indexOf('.'))], database, ''));
          lines.push(
            '',
            whole
              ? `The writes on every collection of ${database} are published.`
              : some.length
                ? `Only the writes on the collections of ${database} matching ${some.join(', ')} are published.`
                : `The writes on ${database} are not published (no pattern matches).`,
          );
        }
        const last = host.redisLastError?.(info.id);
        if (last) lines.push('', `Last publishing error, ${time(last.time)}: ${hideUrls(last.message)}`);
        if (check) {
          let error: string | undefined;
          try {
            error = await host.checkRedis(info.id);
          } catch (err) {
            error = message(err);
          }
          lines.push('', error ? `Redis check failed: ${hideUrls(error)}` : 'Redis check: Redis answers.');
        }
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'list_saved_queries',
      title: 'Saved and recent queries of a collection',
      description:
        "The queries saved by name in Mongoster for a collection — those in the project's repository (files shared with the team through git, with their path) and the user's own — and the ones run recently there, newest first: filter/sort/projection or pipeline stages in mongosh syntax as written. Use it to reuse or build on the user's queries (pass them to find_documents, aggregate, open_query…).",
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, database: databaseProp, collection: collectionProp },
        required: ['connection', 'database', 'collection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = required(args, 'database');
        const collection = required(args, 'collection');
        const { saved, recent } = host.queries({ connectionId: info.id, database, collection });
        if (!saved.length && !recent.length) {
          // Nothing stored: say so, unless the collection doesn't exist.
          await target(args);
          return `No saved or recent queries for ${database}.${collection} on ${info.name}.`;
        }
        const project = saved.filter((q) => q.source === 'project');
        const user = saved.filter((q) => q.source !== 'project').sort((a, b) => b.at - a.at);
        const savedLines = (q: SavedQuery) => [
          q.source === 'project'
            ? `- ${JSON.stringify(q.name ?? '')}, in the project: ${q.file}${q.connection ? ` (only on the connection ${q.connection})` : ''}`
            : `- ${JSON.stringify(q.name ?? '')}, saved for the user ${time(q.at)}`,
          ...(q.description ? [`  description: ${oneLine(q.description)}`] : []),
          ...queryLines(q),
        ];
        const counts = [project.length && `${project.length} in the project`, user.length && `${user.length} for the user`].filter(Boolean).join(', ');
        const lines = [
          `Queries of ${database}.${collection} on ${info.name}.`,
          '',
          saved.length ? `Saved (${counts}):` : 'Saved: none.',
          ...[...project, ...user].flatMap(savedLines),
          '',
          recent.length ? `Recent (${recent.length}, newest first):` : 'Recent: none.',
          ...[...recent].sort((a, b) => b.at - a.at).flatMap((q) => [`- run ${time(q.at)}`, ...queryLines(q)]),
        ];
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'open_watch',
      title: 'Watch changes in Mongoster',
      description:
        "Opens Mongoster's Watch tab in VS Code: a change stream on a whole connection, a database or one collection, so the user sees inserts, updates and deletes live. Needs a replica set or sharded cluster.",
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: { type: 'string', description: 'Watch only this database.' },
          collection: { type: 'string', description: 'Watch only this collection (needs database).' },
        },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = stringArg(args, 'database');
        const collection = stringArg(args, 'collection');
        if (collection && !database) throw new ToolError('collection needs database.');
        if (collection) await target(args);
        let standalone = false;
        try {
          const hello = await (await client(info)).db('admin').command({ hello: 1 });
          standalone = !hello.setName && hello.msg !== 'isdbgrid';
        } catch {
          // The tab shows the error.
        }
        host.openWatch(info, { connectionId: info.id, ...(database && { database }), ...(collection && { collection }) });
        return `Opened the Watch tab on ${collection ? `${database}.${collection}` : (database ?? 'every database')} of ${info.name}.${
          standalone ? ' The server is a standalone: change streams need a replica set or a sharded cluster, so the tab shows an error.' : ''
        }`;
      },
    },
    {
      name: 'open_monitor',
      title: 'Open the server monitor in Mongoster',
      description:
        "Opens Mongoster's server monitor of a connection in VS Code, optionally on a section: running operations, slow queries (profiler and server log), server/database/collection stats, replica set members and oplog, sharding.",
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, section: { type: 'string', enum: [...MONITOR_SECTIONS], description: 'The section shown.' } },
        required: ['connection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const section = stringArg(args, 'section');
        if (section && !(MONITOR_SECTIONS as readonly string[]).includes(section)) throw new ToolError(`section must be one of ${MONITOR_SECTIONS.join(', ')}.`);
        host.openMonitor(info, section as MonitorSection | undefined);
        return `Opened the server monitor of ${info.name}${section ? ` on ${section}` : ''}.`;
      },
    },
    {
      name: 'open_explain',
      title: 'Explain a query in Mongoster',
      description:
        "Opens the collection's tab in VS Code with a find query (filter, sort, projection) or a pipeline, and shows its explain plan (index used, documents examined, time) to the user. Give either the query or the pipeline.",
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, database: databaseProp, collection: collectionProp, filter: filterProp, sort: sortProp, projection: projectionProp, pipeline: pipelineProp },
        required: ['connection', 'database', 'collection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const isPipeline = !!stringArg(args, 'pipeline');
        if (isPipeline && ['filter', 'sort', 'projection'].some((k) => stringArg(args, k))) throw new ToolError('Give either filter/sort/projection or pipeline, not both.');
        const q = isPipeline ? undefined : query(args);
        const p = isPipeline ? pipeline(args) : undefined;
        const { info, database, collection } = await target(args);
        await host.openQuery({
          connectionId: info.id,
          database,
          collection,
          query: p ? { filter: '', sort: '', projection: '', pipeline: p.stages } : q!.text,
          explain: true,
        });
        return p
          ? `Opened ${database}.${collection} on ${info.name} in Aggregate mode with ${plural(p.stages.length, 'stage')} (${p.stages.map((s) => s.op).join(', ')}) and its explain plan.`
          : `Opened ${database}.${collection} on ${info.name} with the filter ${q!.text.filter || '{}'}${q!.text.sort ? `, sort ${q!.text.sort}` : ''}${q!.text.projection ? `, projection ${q!.text.projection}` : ''} and its explain plan.`;
      },
    },
    {
      name: 'open_history',
      title: 'Open the Undo History in Mongoster',
      description: "Opens Mongoster's Undo History tab in VS Code, where the user sees the writes made through Mongoster, what undoing each one does, and can undo them.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      readOnly: true,
      run: async () => {
        host.openHistory();
        const n = (await host.history()).length;
        return `Opened the Undo History tab (${plural(n, 'write')} recorded${host.historyEnabled() ? '' : '; the history is off, new writes are not recorded'}).`;
      },
    },
  ];
}
