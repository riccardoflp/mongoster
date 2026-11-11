// What every group of MCP tools shares: finding the connection, database and collection named in the
// arguments, parsing filters and pipelines in mongosh syntax, and writing values and counts as text.
// No vscode dependency, so the tools can be tested against a real mongod.
import { BSON, Collection, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo } from '../connections';
import { ToolError, stringArg } from '../shared/mcp';
import { buildPipeline, toBson } from '../queries';
import { PipelineStage, isWriteStage, textToPipeline } from '../shared/pipeline';
import { relaxEjson, toShell } from '../shared/query';

const { EJSON } = BSON;

/** Characters of output per call, so a result doesn't flood the model's context. */
export const MAX_OUTPUT = 60_000;
/** maxTimeMS of the queries and commands the tools run. */
export const MAX_TIME_MS = 30_000;
/** Counts stop here: past it the tools say "at least". */
export const COUNT_CAP = 100_000;

/** The part of the ConnectionManager the tools use (a fake one in the tests). */
export interface ToolConnections {
  list(): ConnectionInfo[];
  getClient(id: string): Promise<MongoClient>;
  isConnected(id: string): boolean;
}

export interface Target {
  info: ConnectionInfo;
  database: string;
  collection: string;
  coll: Collection<Document>;
}

export interface ParsedQuery {
  text: { filter: string; sort: string; projection: string };
  filter: Document;
  sort?: Document;
  projection?: Document;
}

export interface ParsedPipeline {
  stages: PipelineStage[];
  pipeline: Document[];
}

export interface ToolContext {
  connections: ToolConnections;
  /** The connection named by `connection` (name or id); a ToolError lists them when there's none. */
  connection(args: Record<string, unknown>): ConnectionInfo;
  client(info: ConnectionInfo): Promise<MongoClient>;
  /** A required string argument. */
  required(args: Record<string, unknown>, key: string): string;
  /** `connection`, `database` and `collection`, checked to exist. */
  target(args: Record<string, unknown>): Promise<Target>;
  /** `filter`, `sort` and `projection` in mongosh syntax. */
  query(args: Record<string, unknown>): ParsedQuery;
  /** `pipeline` in mongosh syntax; $out and $merge are refused. */
  pipeline(args: Record<string, unknown>): ParsedPipeline;
}

/** A value in mongosh syntax: ObjectId("…"), ISODate("…"), NumberLong(…). */
export const shell = (v: unknown, indent?: number): string => toShell(relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v), indent);
/** "1,234 documents", "1 document". */
export const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
/** Documents in mongosh syntax, separated by commas (to put inside [ ]). */
export const documentsText = (docs: Document[]): string => docs.map((d) => shell(d, 2)).join(',\n');
/** The error's message. */
export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const connectionProp = { type: 'string', description: 'Connection name or id, from list_connections.' };
export const databaseProp = { type: 'string', description: 'Database name.' };
export const collectionProp = { type: 'string', description: 'Collection or view name.' };
export const filterProp = {
  type: 'string',
  description: 'Filter in mongosh syntax, e.g. { status: "active", createdAt: { $gte: ISODate("2024-01-01") }, _id: ObjectId("…") }. Empty for all documents.',
};
export const sortProp = { type: 'string', description: 'Sort in mongosh syntax, e.g. { createdAt: -1 }.' };
export const projectionProp = { type: 'string', description: 'Projection in mongosh syntax, e.g. { name: 1, email: 1 }.' };
export const pipelineProp = {
  type: 'string',
  description: 'Aggregation pipeline in mongosh syntax, e.g. [ { $match: { status: "active" } }, { $group: { _id: "$city", n: { $sum: 1 } } } ]. $out and $merge are refused.',
};

export function toolContext(connections: ToolConnections): ToolContext {
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
  return {
    connections,
    connection,
    client,
    required,
    target: async (args) => {
      const info = connection(args);
      const database = required(args, 'database');
      const collection = required(args, 'collection');
      const db = (await client(info)).db(database);
      const [found] = await db.listCollections({ name: collection }, { nameOnly: true }).toArray();
      if (!found) throw new ToolError(`${database}.${collection} doesn't exist on ${info.name}: use list_collections.`);
      return { info, database, collection, coll: db.collection(collection) };
    },
    query: (args) => {
      const text = { filter: stringArg(args, 'filter') ?? '', sort: stringArg(args, 'sort') ?? '', projection: stringArg(args, 'projection') ?? '' };
      try {
        return { text, filter: toBson(text.filter, 'Filter') ?? {}, sort: toBson(text.sort, 'Sort'), projection: toBson(text.projection, 'Projection') };
      } catch (err) {
        throw new ToolError(message(err));
      }
    },
    pipeline: (args) => {
      const text = required(args, 'pipeline');
      try {
        const stages = textToPipeline(text);
        if (!stages.length) throw new ToolError('The pipeline is empty.');
        const write = stages.find(isWriteStage);
        if (write) throw new ToolError(`${write.op} writes to the database: Mongoster's MCP server only reads.`);
        return { stages, pipeline: buildPipeline(stages, stages.length - 1).pipeline };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError(`Pipeline: ${message(err)}`);
      }
    },
  };
}
