// Saved queries kept in the project's repository: one JSON file per query, written so that it reads
// well and diffs well in git (fixed key order, the mongosh text as the user wrote it, multi-line text
// as one line per array element). A file names its collection by database and collection, and by
// connection name only when it is set: connection ids are local to each machine.
import type { QueryText, SavedQuery } from './messages';
import type { PipelineStage } from './pipeline';

/** The default folder of the project's saved queries, relative to the workspace folder. */
export const DEFAULT_QUERIES_FOLDER = '.mongoster/queries';

/** A saved query as kept in the project. */
export interface ProjectQuery {
  name: string;
  description?: string;
  /** The connection's name: when set, the query only shows on the connections with that name. */
  connection?: string;
  database: string;
  collection: string;
  query: QueryText;
}

/** A collection as the panel knows it. */
export interface QueryScope {
  connectionName: string;
  database: string;
  collection: string;
}

/** Text with line breaks becomes an array of lines, so that git diffs it line by line. */
function textValue(text: string): string | string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized.includes('\n') ? normalized.split('\n') : normalized;
}

/** The file's content: pretty-printed JSON with the keys in a fixed order and a final newline. */
export function serializeProjectQuery(q: ProjectQuery): string {
  const out: Record<string, unknown> = { name: q.name };
  if (q.description?.trim()) out.description = textValue(q.description.trim());
  if (q.connection?.trim()) out.connection = q.connection.trim();
  out.database = q.database;
  out.collection = q.collection;
  if (q.query.pipeline) {
    out.pipeline = q.query.pipeline.map((s) => ({ stage: s.op.trim(), body: textValue(s.body.trim()), ...(!s.enabled && { enabled: false }) }));
  } else {
    for (const key of ['filter', 'sort', 'projection'] as const) {
      const text = q.query[key].trim();
      if (text) out[key] = textValue(text);
    }
    if (!('filter' in out) && !('sort' in out) && !('projection' in out)) out.filter = '{}';
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Thrown for a file that isn't a valid saved query; the message says what is wrong. */
export class QueryFileError extends Error {}

function text(o: Record<string, unknown>, key: string, where = ''): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((l) => typeof l === 'string')) return v.join('\n');
  throw new QueryFileError(`"${key}"${where} must be a string or an array of lines.`);
}

function requiredText(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v.trim()) throw new QueryFileError(`"${key}" is missing: it must be a non-empty string.`);
  return v.trim();
}

/** Reads a saved query file; throws QueryFileError when it isn't one. */
export function parseProjectQuery(content: string): ProjectQuery {
  let data: unknown;
  try {
    data = JSON.parse(content.replace(/^﻿/, ''));
  } catch (err) {
    throw new QueryFileError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new QueryFileError('it must be a JSON object.');
  const o = data as Record<string, unknown>;
  const name = requiredText(o, 'name');
  const database = requiredText(o, 'database');
  const collection = requiredText(o, 'collection');
  const description = text(o, 'description')?.trim();
  const connection = o.connection === undefined || o.connection === null ? undefined : o.connection;
  if (connection !== undefined && typeof connection !== 'string') throw new QueryFileError('"connection" must be a string.');
  const find = { filter: text(o, 'filter') ?? '', sort: text(o, 'sort') ?? '', projection: text(o, 'projection') ?? '' };
  let query: QueryText = find;
  if (o.pipeline !== undefined) {
    if (find.filter.trim() || find.sort.trim() || find.projection.trim()) throw new QueryFileError('it has both a "pipeline" and "filter", "sort" or "projection": keep one or the other.');
    if (!Array.isArray(o.pipeline)) throw new QueryFileError('"pipeline" must be an array of stages.');
    const stages = o.pipeline.map((s: unknown, i): PipelineStage => {
      const where = ` of stage ${i + 1}`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new QueryFileError(`stage ${i + 1} of "pipeline" must be an object with "stage" and "body".`);
      const stage = s as Record<string, unknown>;
      const op = typeof stage.stage === 'string' ? stage.stage.trim() : '';
      if (!/^\$\w+$/.test(op)) throw new QueryFileError(`"stage"${where} must be a stage name such as "$match".`);
      if (stage.enabled !== undefined && typeof stage.enabled !== 'boolean') throw new QueryFileError(`"enabled"${where} must be true or false.`);
      return { op, body: text(stage, 'body', where) ?? '', enabled: stage.enabled !== false };
    });
    query = { filter: '', sort: '', projection: '', pipeline: stages };
  }
  return {
    name,
    ...(description && { description }),
    ...(typeof connection === 'string' && connection.trim() && { connection: connection.trim() }),
    database,
    collection,
    query,
  };
}

/** Whether a project query belongs to the collection: same database and collection, and same connection name when it has one. */
export function matchesCollection(q: Pick<ProjectQuery, 'database' | 'collection' | 'connection'>, scope: QueryScope): boolean {
  return (
    q.database === scope.database &&
    q.collection === scope.collection &&
    (!q.connection || q.connection.trim().toLowerCase() === scope.connectionName.trim().toLowerCase())
  );
}

/** The file name of a query: its name in lowercase letters, digits and dashes. */
export function queryFileName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'query'}.json`;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A database or collection name as a folder name that every system accepts. */
export function folderName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '_');
  return RESERVED.test(safe) ? `_${safe}` : safe || '_';
}

/**
 * Where a new query goes, relative to the queries folder: `database/collection/name.json`, with `-2`,
 * `-3`… when `taken` says the name is used.
 */
export function queryFilePath(database: string, collection: string, name: string, taken: (relative: string) => boolean = () => false): string {
  const dir = `${folderName(database)}/${folderName(collection)}`;
  const base = queryFileName(name).slice(0, -'.json'.length);
  for (let i = 1; ; i++) {
    const candidate = `${dir}/${i === 1 ? base : `${base}-${i}`}.json`;
    if (!taken(candidate)) return candidate;
  }
}

/** The project query as the history panel shows it. */
export function projectSavedQuery(q: ProjectQuery, id: string, file: string, at: number): SavedQuery {
  return {
    id,
    name: q.name,
    ...q.query,
    at,
    source: 'project',
    file,
    ...(q.description && { description: q.description }),
    ...(q.connection && { connection: q.connection }),
  };
}

/**
 * The saved queries of a collection: the user's and the project's together, by name. With the same
 * name, the project's come first, and among them the one for this connection only.
 */
export function mergeSavedQueries(user: SavedQuery[], project: SavedQuery[]): SavedQuery[] {
  const all = [...user.map((q) => ({ ...q, source: 'user' as const })), ...project.map((q) => ({ ...q, source: 'project' as const }))];
  const rank = (q: SavedQuery) => (q.source === 'project' ? (q.connection ? 0 : 1) : 2);
  return all.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base', numeric: true }) || rank(a) - rank(b) || (a.file ?? '').localeCompare(b.file ?? ''));
}
