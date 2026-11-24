// What the user excluded from searches: whole connections, and databases and collections of a connection, kept on
// the connection like the colors of its collections. Something excluded stays in the tree, dimmed; the tree's
// filter, the global search over a database or a deployment and the lists of the MCP server leave it out. What the
// user asks for by name (a search started on an excluded collection, a tool given its name) still works.
// No vscode dependency: the tree, the search, the MCP tools and the import of connections use it.
import { bucketCollection, namespaceOf } from './collectionColors';

/** What the functions here need of a connection. */
export interface ExcludingConnection {
  /** The connection itself: the tree's filter neither opens nor connects it, and the MCP server doesn't list it. */
  excluded?: boolean;
  /** Excluded databases (`shop`) and collections (`shop.orders`; a GridFS bucket by its `.files` collection). */
  exclusions?: string[];
}

/** The key of a database (its name, which has no `.`) or of a collection (`database.collection`). */
export function exclusionKey(database: string, collection?: string): string {
  return collection === undefined ? database : namespaceOf(database, collection);
}

/** The key of a GridFS bucket: the one of its `.files` collection, as for its color. */
export function bucketExclusionKey(database: string, bucket: string): string {
  return namespaceOf(database, bucketCollection(bucket));
}

/** Whether the database, or the collection, has an entry of its own (not the one of its database). */
export function ownExclusion(connection: ExcludingConnection | undefined, database: string, collection?: string): boolean {
  return !!connection?.exclusions?.includes(exclusionKey(database, collection));
}

/** Whether searches leave the database, or the collection, out: its own entry or its database's. */
export function isExcluded(connection: ExcludingConnection | undefined, database: string, collection?: string): boolean {
  return ownExclusion(connection, database) || (collection !== undefined && ownExclusion(connection, database, collection));
}

/**
 * What a search over a deployment (`database` undefined: `names` are databases) or over a database (`names` are its
 * collections) reads: the names that aren't excluded. The database a search was started on is read even when excluded;
 * its excluded collections are not.
 */
export function leaveOutExcluded(connection: ExcludingConnection | undefined, names: string[], database?: string): string[] {
  return names.filter((name) => !(database === undefined ? ownExclusion(connection, name) : ownExclusion(connection, database, name)));
}

/** The list with `keys` added (`excluded`) or removed; undefined when nothing is left. Sorted, without repeats. */
export function setExclusions(list: string[] | undefined, keys: string[], excluded: boolean): string[] | undefined {
  const next = new Set(list);
  for (const key of keys) {
    if (excluded) next.add(key);
    else next.delete(key);
  }
  return orUndefined([...next].sort((a, b) => a.localeCompare(b)));
}

/** The list with the entry of `from` moved to `to`; unchanged (the same array) when `from` has none. */
export function renameExclusion(list: string[] | undefined, from: string, to: string): string[] | undefined {
  if (!list?.includes(from)) return list;
  return setExclusions(setExclusions(list, [from], false), [to], true);
}

/**
 * The list without the entries of a dropped collection, of the collections of a dropped bucket (`bucket` set), or of a
 * dropped database and all its collections (`collection` undefined); unchanged (the same array) when none goes.
 */
export function dropExclusions(list: string[] | undefined, database: string, collection?: string, bucket = false): string[] | undefined {
  if (!list) return list;
  const dropped = (key: string) => {
    if (collection === undefined) return key === database || key.startsWith(`${database}.`);
    if (bucket) return key === bucketExclusionKey(database, collection) || key === namespaceOf(database, `${collection}.chunks`);
    return key === namespaceOf(database, collection);
  };
  const kept = list.filter((key) => !dropped(key));
  return kept.length === list.length ? list : orUndefined(kept);
}

/** The valid entries of a list read from a file: database names and `database.collection` keys. */
export function readExclusions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = value.filter((key): key is string => typeof key === 'string' && /^[^.]+(\..+)?$/.test(key));
  return setExclusions(undefined, keys, true);
}

function orUndefined(list: string[]): string[] | undefined {
  return list.length ? list : undefined;
}
