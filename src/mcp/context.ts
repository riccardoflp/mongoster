// What every group of MCP tools shares: finding the connection, database and collection named in the
// arguments, parsing filters and pipelines in mongosh syntax, and writing values and counts as text.
// No vscode dependency, so the tools can be tested against a real mongod.
import { BSON, Collection, Document, MongoClient, MongoServerError } from 'mongodb';
import type { ConnectionInfo } from '../connections';
import { ToolError, stringArg } from '../shared/mcp';
import { buildPipeline, toBson } from '../queries';
import { PipelineStage, isWriteStage, joinedCollections, notPlainReadStage, parseStageBody, textToPipeline } from '../shared/pipeline';
import { shapeOf } from '../shared/profile';
import { isPlainObject, relaxEjson, toShell } from '../shared/query';

const { EJSON } = BSON;

/** Characters of output per call, so a result doesn't flood the model's context. */
export const MAX_OUTPUT = 60_000;
/** maxTimeMS of the queries and commands the tools run. */
export const MAX_TIME_MS = 30_000;
/** Counts stop here: past it the tools say "at least". */
export const COUNT_CAP = 100_000;
/** The largest `skip` of a find: past it the server only burns time walking documents it throws away. */
export const SKIP_MAX = 1_000_000;
/** The setting that lets the tools return documents and field values. */
export const READ_DOCUMENTS = 'mongoster.mcp.readDocuments';

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
  /** `connection`, `database` and `collection`, checked to exist; a `system.*` collection is refused. */
  target(args: Record<string, unknown>): Promise<Target>;
  /** `filter`, `sort` and `projection` in mongosh syntax. */
  query(args: Record<string, unknown>): ParsedQuery;
  /**
   * `pipeline` in mongosh syntax. Refused: the stages that are not a plain read ($out, $merge,
   * $changeStream, $currentOp, $queryStats…) and a $lookup, $unionWith or $graphLookup from a `system.*` collection,
   * in the nested pipelines too.
   */
  pipeline(args: Record<string, unknown>): ParsedPipeline;
  /** `mongoster.mcp.readDocuments`: whether the tools may return documents and field values. */
  readDocuments(): boolean;
  /**
   * An error as the model reads it. A server's error text can quote the values of the documents it
   * failed on, so with readDocuments off a server error is reduced to its code and code name.
   */
  errorText(err: unknown): string;
  /**
   * A definition stored on the server that can hold literal values (a view's pipeline, a partial filter
   * expression): in mongosh syntax, or with readDocuments off as its shape, the values replaced by ?.
   */
  definition(v: unknown, indent?: number): string;
}

/** A value in mongosh syntax: ObjectId("…"), ISODate("…"), NumberLong(…). */
export const shell = (v: unknown, indent?: number): string => toShell(relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v), indent);
/** "1,234 documents", "1 document". */
export const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
/** Documents in mongosh syntax, separated by commas (to put inside [ ]). */
export const documentsText = (docs: Document[]): string => docs.map((d) => shell(d, 2)).join(',\n');
/** The error's message. */
export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether the error is the server's answer to a command (as opposed to a network or driver error). */
const isServerError = (err: unknown): boolean =>
  err instanceof MongoServerError || typeof (err as { codeName?: unknown } | null)?.codeName === 'string' || typeof (err as { errmsg?: unknown } | null)?.errmsg === 'string';

/** A server error without its text: "server error 241 (ConversionFailure)". */
export function errorCode(err: unknown): string {
  const { code, codeName } = (err ?? {}) as { code?: unknown; codeName?: unknown };
  const number = typeof code === 'number' || typeof code === 'string' ? ` ${String(code).slice(0, 20)}` : '';
  const name = typeof codeName === 'string' && /^\w{1,80}$/.test(codeName) ? ` (${codeName})` : '';
  return `server error${number}${name}`;
}

/** The error for the model: its message, or only its code when it comes from the server and values must not be shown. */
export const safeErrorText = (err: unknown, values: boolean): string =>
  values || !isServerError(err) ? message(err) : `${errorCode(err)}; its text is left out because ${READ_DOCUMENTS} is off`;

/** A name of the collections the server keeps for itself (users and their credentials, the profiler's queries, views…). */
export const isSystemCollection = (collection: string): boolean => collection.startsWith('system.');

/** Refuses a `system.*` collection named by the caller: the tools that need one read it by themselves. */
export function refuseSystemCollection(database: string, collection: string): void {
  if (isSystemCollection(collection)) {
    throw new ToolError(`${database}.${collection} is a system collection: Mongoster's MCP server doesn't read the system.* collections (users, profiler, views…).`);
  }
}

/** A value with its literal values replaced by ?: the field names and operators stay. */
export const shape = (v: unknown): string => shapeOf(relaxEjson(EJSON.serialize({ v }, { relaxed: false }).v));

/** The $jsonSchema keywords that say a type or a size, not a value a document can have. */
const SCHEMA_KEPT = new Set(['bsonType', 'type', 'required', 'uniqueItems', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties']);
/** The keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', 'dependencies']);
/** The keywords whose value is a schema or a list of schemas. */
const SCHEMA_NESTED = new Set(['items', 'additionalItems', 'additionalProperties', 'not', 'allOf', 'anyOf', 'oneOf']);

const keyText = (k: string): string => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
/** A type name, a size, or a list of names: what the kept keywords hold. */
const isPlainWord = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** A $jsonSchema with its field names, types and sizes; enum, pattern, bounds and descriptions are replaced by ?. */
export function schemaShape(schema: unknown): string {
  if (Array.isArray(schema)) return `[${schema.map(schemaShape).join(', ')}]`;
  if (typeof schema === 'boolean') return String(schema);
  if (!isPlainObject(schema)) return '?';
  const parts = Object.entries(schema).map(([k, v]) => {
    if (SCHEMA_KEPT.has(k)) return `${keyText(k)}: ${isPlainWord(v) || (Array.isArray(v) && v.every(isPlainWord)) ? toShell(v) : '?'}`;
    if (SCHEMA_MAPS.has(k) && isPlainObject(v)) {
      const fields = Object.entries(v).map(([name, sub]) => `${keyText(name)}: ${schemaShape(sub)}`);
      return `${keyText(k)}: ${fields.length ? `{ ${fields.join(', ')} }` : '{}'}`;
    }
    if (SCHEMA_NESTED.has(k)) return `${keyText(k)}: ${schemaShape(v)}`;
    return `${keyText(k)}: ?`;
  });
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

/** A validator without literal values: its $jsonSchema as schemaShape gives it, its query conditions as their shape. */
export function validatorShape(validator: unknown): string {
  const v = relaxEjson(EJSON.serialize({ v: validator }, { relaxed: false }).v);
  if (!isPlainObject(v)) return shapeOf(v);
  const parts = Object.entries(v).map(([k, x]) => `${keyText(k)}: ${k === '$jsonSchema' ? schemaShape(x) : shapeOf(x)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

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
  description:
    'Aggregation pipeline in mongosh syntax, e.g. [ { $match: { status: "active" } }, { $group: { _id: "$city", n: { $sum: 1 } } } ]. $out, $merge, $changeStream, $currentOp, $listSessions, $queryStats, $listSampledQueries, $planCacheStats and reading a system.* collection are refused.',
};

/**
 * The context of the tools. `readDocuments` is the setting `mongoster.mcp.readDocuments`, asked at every
 * call; without it the tools may return values (the tests of one group of tools).
 */
export function toolContext(connections: ToolConnections, readDocuments: () => boolean = () => true): ToolContext {
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
    readDocuments,
    errorText: (err) => safeErrorText(err, readDocuments()),
    definition: (v, indent) => (readDocuments() ? shell(v, indent) : shape(v)),
    target: async (args) => {
      const info = connection(args);
      const database = required(args, 'database');
      const collection = required(args, 'collection');
      refuseSystemCollection(database, collection);
      const db = (await client(info)).db(database);
      const [found] = await db.listCollections({ name: collection }, { nameOnly: true, maxTimeMS: MAX_TIME_MS }).toArray();
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
        const built = buildPipeline(stages, stages.length - 1).pipeline;
        // The same stages as plain values, to look into the pipelines nested in $facet, $lookup and $unionWith.
        const parsed = stages.map((s) => ({ [s.op.trim()]: parseStageBody(s) }));
        const refused = notPlainReadStage(parsed);
        if (refused) {
          throw new ToolError(
            refused === '$out' || refused === '$merge'
              ? `${refused} writes to the database: Mongoster's MCP server only reads.`
              : `${refused} is refused: Mongoster's MCP server runs only pipelines that read the collection (watch_changes follows the changes, current_operations lists the operations, slow_queries gives the query shapes).`,
          );
        }
        const system = joinedCollections(parsed).find(isSystemCollection);
        if (system) throw new ToolError(`The pipeline reads ${system}: Mongoster's MCP server doesn't read the system.* collections (users, profiler, views…).`);
        return { stages, pipeline: built };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError(`Pipeline: ${message(err)}`);
      }
    },
  };
}
