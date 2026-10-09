import * as vscode from 'vscode';
import { BSON, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { SearchScope } from './search';
import type { SearchOptions } from './shared/messages';
import { McpTool, ToolError, boolArg, intArg, stringArg, truncate } from './shared/mcp';
import { buildPipeline, toBson } from './queries';
import { isWriteStage, textToPipeline } from './shared/pipeline';
import { relaxEjson, toShell } from './shared/query';
import { FieldSchema, analyzeSchema } from './shared/schema';

/** What the tools need from the extension. */
export interface ToolHost {
  connections: ConnectionManager;
  /** Opens the global search tab and starts the search. */
  openSearch(info: ConnectionInfo, scope: SearchScope, options: SearchOptions): void;
  /** `mongoster.mcp.readDocuments`: the tools that return documents are offered. */
  readDocuments(): boolean;
}

/** Characters of output per call, so a result doesn't flood the model's context. */
export const MAX_OUTPUT = 60_000;
const { EJSON } = BSON;
const MAX_TIME_MS = 30_000;
const COUNT_CAP = 100_000;
export const SEARCH_LIMITS = [0, 1000, 10_000, 100_000];

const shell = (v: unknown, indent?: number) => toShell(relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v), indent);
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

const connectionProp = { type: 'string', description: 'Connection name or id, from list_connections.' };
const databaseProp = { type: 'string', description: 'Database name.' };
const collectionProp = { type: 'string', description: 'Collection or view name.' };
const filterProp = {
  type: 'string',
  description: 'Filter in mongosh syntax, e.g. { status: "active", createdAt: { $gte: ISODate("2024-01-01") }, _id: ObjectId("…") }. Empty for all documents.',
};
const sortProp = { type: 'string', description: 'Sort in mongosh syntax, e.g. { createdAt: -1 }.' };
const projectionProp = { type: 'string', description: 'Projection in mongosh syntax, e.g. { name: 1, email: 1 }.' };
const pipelineProp = {
  type: 'string',
  description: 'Aggregation pipeline in mongosh syntax, e.g. [ { $match: { status: "active" } }, { $group: { _id: "$city", n: { $sum: 1 } } } ]. $out and $merge are refused.',
};

export function mcpTools(host: ToolHost): McpTool[] {
  const { connections } = host;

  const connection = (args: Record<string, unknown>): ConnectionInfo => {
    const key = stringArg(args, 'connection');
    if (!key) throw new ToolError('connection is required: use list_connections to see them.');
    const all = connections.list();
    const byId = all.find((c) => c.id === key);
    if (byId) return byId;
    const byName = all.filter((c) => c.name.toLowerCase() === key.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new ToolError(`More than one connection is named "${key}": use the id (${byName.map((c) => c.id).join(', ')}).`);
    throw new ToolError(`No connection "${key}". Connections: ${all.map((c) => c.name).join(', ') || 'none'}.`);
  };
  const client = (info: ConnectionInfo): Promise<MongoClient> => connections.getClient(info.id);
  const required = (args: Record<string, unknown>, key: string): string => {
    const v = stringArg(args, key);
    if (!v) throw new ToolError(`${key} is required.`);
    return v;
  };
  const target = async (args: Record<string, unknown>) => {
    const info = connection(args);
    const database = required(args, 'database');
    const collection = required(args, 'collection');
    const db = (await client(info)).db(database);
    const [found] = await db.listCollections({ name: collection }, { nameOnly: true }).toArray();
    if (!found) throw new ToolError(`${database}.${collection} doesn't exist on ${info.name}: use list_collections.`);
    return { info, database, collection, coll: db.collection(collection) };
  };
  const query = (args: Record<string, unknown>) => {
    const text = { filter: stringArg(args, 'filter') ?? '', sort: stringArg(args, 'sort') ?? '', projection: stringArg(args, 'projection') ?? '' };
    try {
      return { text, filter: toBson(text.filter, 'Filter') ?? {}, sort: toBson(text.sort, 'Sort'), projection: toBson(text.projection, 'Projection') };
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
  };
  const pipeline = (args: Record<string, unknown>) => {
    const text = required(args, 'pipeline');
    try {
      const stages = textToPipeline(text);
      if (!stages.length) throw new ToolError('The pipeline is empty.');
      const write = stages.find(isWriteStage);
      if (write) throw new ToolError(`${write.op} writes to the database: Mongoster's MCP server only reads.`);
      return { stages, pipeline: buildPipeline(stages, stages.length - 1).pipeline };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Pipeline: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const documentsText = (docs: Document[]) => docs.map((d) => shell(d, 2)).join(',\n');

  const tools: McpTool[] = [
    {
      name: 'list_connections',
      title: 'List connections',
      description: 'The MongoDB connections saved in Mongoster (name, id, folder, whether they are read-only). Connection strings are never returned.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      readOnly: true,
      run: async () => {
        const all = connections.list();
        if (!all.length) return 'No connections are saved in Mongoster.';
        return JSON.stringify(
          all.map((c) => ({ name: c.name, id: c.id, ...(c.folder && { folder: c.folder }), ...(c.readOnly && { readOnly: true }), connected: connections.isConnected(c.id) })),
          null,
          2,
        );
      },
    },
    {
      name: 'list_databases',
      title: 'List databases',
      description: 'The databases of a connection, with their size on disk.',
      inputSchema: { type: 'object', properties: { connection: connectionProp }, required: ['connection'], additionalProperties: false },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const { databases } = await (await client(info)).db('admin').admin().listDatabases({ nameOnly: false });
        return JSON.stringify(databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty })), null, 2);
      },
    },
    {
      name: 'list_collections',
      title: 'List collections',
      description: 'The collections and views of a database.',
      inputSchema: { type: 'object', properties: { connection: connectionProp, database: databaseProp }, required: ['connection', 'database'], additionalProperties: false },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = required(args, 'database');
        const list = await (await client(info)).db(database).listCollections({}, { nameOnly: false }).toArray();
        if (!list.length) return `${database} has no collections.`;
        return JSON.stringify(
          list
            .map((c) => ({
              name: c.name,
              type: c.type,
              ...((c as { options?: Document }).options?.viewOn && { viewOn: (c as { options?: Document }).options!.viewOn }),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          null,
          2,
        );
      },
    },
    {
      name: 'describe_collection',
      title: 'Describe a collection',
      description:
        'The structure of a collection: estimated number of documents, indexes, and the fields found in a random sample of documents with their BSON types and how often they are present. Use it to write correct filters and pipelines.',
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, database: databaseProp, collection: collectionProp, sample: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Documents sampled.' } },
        required: ['connection', 'database', 'collection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const sample = intArg(args, 'sample', 200, 1, 1000);
        const { database, collection, coll } = await target(args);
        const [count, docs, indexes] = await Promise.all([
          coll.estimatedDocumentCount({ maxTimeMS: MAX_TIME_MS }).catch(() => undefined),
          coll.aggregate([{ $sample: { size: sample } }], { maxTimeMS: MAX_TIME_MS }).toArray(),
          coll.indexes().catch(() => [] as Document[]),
        ]);
        const schema = analyzeSchema(docs.map((d) => EJSON.serialize(d, { relaxed: false })));
        const lines = [
          `${database}.${collection}: ${count === undefined ? 'unknown number of' : `about ${plural(count, 'document')},`} ${plural(schema.sampled, 'document')} sampled.`,
          '',
          'Indexes:',
          ...(indexes.length ? indexes.map((ix) => `- ${ix.name}: ${shell(ix.key)}${ix.unique ? ' unique' : ''}${ix.sparse ? ' sparse' : ''}${ix.expireAfterSeconds !== undefined ? ` TTL ${ix.expireAfterSeconds}s` : ''}${ix.partialFilterExpression ? ` partial ${shell(ix.partialFilterExpression)}` : ''}${ix.hidden ? ' hidden' : ''}`) : ['- none (a view)']),
          '',
          'Fields (path: types, % of documents that have it):',
          ...flattenFields(schema.fields, schema.sampled).slice(0, 400),
          ...(schema.moreFields ? ['- … more fields were not analyzed'] : []),
        ];
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'find_documents',
      title: 'Find documents',
      description:
        'Runs a find query and returns the matching documents in mongosh syntax (ObjectId(…), ISODate(…), NumberLong(…)), with how many match in total. Read only.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: databaseProp,
          collection: collectionProp,
          filter: filterProp,
          sort: sortProp,
          projection: projectionProp,
          skip: { type: 'integer', minimum: 0, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Documents returned.' },
        },
        required: ['connection', 'database', 'collection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const q = query(args);
        const skip = intArg(args, 'skip', 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = intArg(args, 'limit', 20, 1, 100);
        const { database, collection, coll } = await target(args);
        const [docs, total] = await Promise.all([
          coll.find(q.filter, { sort: q.sort, projection: q.projection, skip, limit, maxTimeMS: MAX_TIME_MS }).toArray(),
          coll.countDocuments(q.filter, { limit: COUNT_CAP, maxTimeMS: MAX_TIME_MS }).catch(() => undefined),
        ]);
        const matching = total === undefined ? 'An unknown number of documents match' : total >= COUNT_CAP ? `At least ${plural(COUNT_CAP, 'document')} match` : `${plural(total, 'document')} match`;
        const shown = docs.length ? `showing ${(skip + 1).toLocaleString('en-US')}–${(skip + docs.length).toLocaleString('en-US')}` : 'none returned';
        return truncate(`${database}.${collection}: ${matching}, ${shown}.\n\n${docs.length ? `[\n${documentsText(docs)}\n]` : '[]'}`, MAX_OUTPUT);
      },
    },
    {
      name: 'aggregate',
      title: 'Run an aggregation',
      description: 'Runs an aggregation pipeline and returns its first results in mongosh syntax. Pipelines with $out or $merge are refused. Read only.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: databaseProp,
          collection: collectionProp,
          pipeline: pipelineProp,
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Results returned.' },
        },
        required: ['connection', 'database', 'collection', 'pipeline'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const p = pipeline(args);
        const limit = intArg(args, 'limit', 20, 1, 100);
        const { database, collection, coll } = await target(args);
        const cursor = coll.aggregate(p.pipeline, { maxTimeMS: MAX_TIME_MS });
        const docs: Document[] = [];
        let more = false;
        try {
          for await (const d of cursor) {
            if (docs.length === limit) {
              more = true;
              break;
            }
            docs.push(d);
          }
        } finally {
          await cursor.close();
        }
        const head = `${database}.${collection}: ${plural(docs.length, 'result')}${more ? ` (the first ${limit}; there are more)` : ''}.`;
        return truncate(`${head}\n\n${docs.length ? `[\n${documentsText(docs)}\n]` : '[]'}`, MAX_OUTPUT);
      },
    },
    {
      name: 'open_query',
      title: 'Open a query in Mongoster',
      description: "Opens the collection's tab in VS Code with the filter, sort and projection filled in and run, so the user sees the documents in Mongoster's table.",
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, database: databaseProp, collection: collectionProp, filter: filterProp, sort: sortProp, projection: projectionProp },
        required: ['connection', 'database', 'collection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const q = query(args);
        const { info, database, collection } = await target(args);
        await vscode.commands.executeCommand('mongoster.openQuery', { connectionId: info.id, database, collection, query: q.text, explain: false });
        return `Opened ${database}.${collection} on ${info.name} with the filter ${q.text.filter || '{}'}${q.text.sort ? `, sort ${q.text.sort}` : ''}${q.text.projection ? `, projection ${q.text.projection}` : ''}.`;
      },
    },
    {
      name: 'open_aggregation',
      title: 'Open an aggregation in Mongoster',
      description: "Opens the collection's tab in VS Code in Aggregate mode with the pipeline's stages, and runs it, so the user sees and can edit each stage.",
      inputSchema: {
        type: 'object',
        properties: { connection: connectionProp, database: databaseProp, collection: collectionProp, pipeline: pipelineProp },
        required: ['connection', 'database', 'collection', 'pipeline'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const p = pipeline(args);
        const { info, database, collection } = await target(args);
        await vscode.commands.executeCommand('mongoster.openQuery', {
          connectionId: info.id,
          database,
          collection,
          query: { filter: '', sort: '', projection: '', pipeline: p.stages },
          explain: false,
        });
        return `Opened ${database}.${collection} on ${info.name} in Aggregate mode with ${plural(p.stages.length, 'stage')}: ${p.stages.map((s) => s.op).join(', ')}.`;
      },
    },
    {
      name: 'open_search',
      title: 'Search every field in Mongoster',
      description:
        "Opens Mongoster's global search tab in VS Code and starts searching a text in any field of the documents (nested and in arrays too) of a whole connection, a database or one collection. Finds ids (ObjectId, UUID) and the documents that reference them, dates, numbers. The user sees the results there.",
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: { type: 'string', description: 'Limit the search to this database.' },
          collection: { type: 'string', description: 'Limit the search to this collection (needs database).' },
          text: { type: 'string', description: 'Text, id, number or date to find; a regular expression when regex is true.' },
          regex: { type: 'boolean', default: false },
          matchCase: { type: 'boolean', default: false },
          fieldNames: { type: 'boolean', default: false, description: 'Also match field names.' },
          views: { type: 'boolean', default: false, description: 'Also search views.' },
          limit: { type: 'integer', enum: SEARCH_LIMITS, default: 0, description: 'Documents read per collection; 0 for all.' },
        },
        required: ['connection', 'text'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = stringArg(args, 'database');
        const collection = stringArg(args, 'collection');
        if (collection && !database) throw new ToolError('collection needs database.');
        const text = required(args, 'text');
        const regex = boolArg(args, 'regex', false);
        if (regex) {
          try {
            new RegExp(text.replace(/^\/(.*)\/[a-z]*$/s, '$1'));
          } catch (err) {
            throw new ToolError(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const limit = intArg(args, 'limit', 0, 0, Number.MAX_SAFE_INTEGER);
        if (!SEARCH_LIMITS.includes(limit)) throw new ToolError(`limit must be one of ${SEARCH_LIMITS.join(', ')}.`);
        if (database) {
          const db = (await client(info)).db(database);
          if (collection) {
            const [found] = await db.listCollections({ name: collection }, { nameOnly: true }).toArray();
            if (!found) throw new ToolError(`${database}.${collection} doesn't exist on ${info.name}.`);
          }
        }
        host.openSearch(info, { connectionId: info.id, ...(database && { database }), ...(collection && { collection }) }, {
          text,
          mode: regex ? 'regex' : 'text',
          matchCase: boolArg(args, 'matchCase', false),
          fieldNames: boolArg(args, 'fieldNames', false),
          views: boolArg(args, 'views', false),
          limit,
        });
        return `Opened the search for ${JSON.stringify(text)} in ${collection ? `${database}.${collection}` : (database ?? 'every database')} on ${info.name}. The results appear in Mongoster's Search tab.`;
      },
    },
  ];
  return host.readDocuments() ? tools : tools.filter((t) => t.name !== 'find_documents' && t.name !== 'aggregate');
}

/** Fields as lines: `- address.city: string 98%, null 2% (present in 100%)`. */
export function flattenFields(fields: FieldSchema[], of: number): string[] {
  const out: string[] = [];
  const walk = (list: FieldSchema[]) => {
    for (const f of list) {
      const types = f.types.map((t) => `${t.type}${f.types.length > 1 ? ` ${Math.round((t.count / Math.max(1, f.count)) * 100)}%` : ''}`).join(', ');
      out.push(`- ${f.label}: ${types} (${Math.round((f.count / Math.max(1, f.of || of)) * 100)}%)`);
      if (f.fields) walk(f.fields);
      for (const t of f.types) if (t.elements?.fields) walk(t.elements.fields);
    }
  };
  walk(fields);
  return out;
}
