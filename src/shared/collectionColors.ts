// The colors of single databases, and of single collections, views and GridFS buckets, kept on their connection
// (D16): which color something of a database or a collection takes (the collection's wins over the database's, which
// wins over the connection's), and how the maps of colors change when one is colored, renamed or dropped.
// No vscode dependency: the tree, the tabs, the decorations and the import of connections use it.
import type { CollectionColor, ConnectionColor } from '../connections';
import { readColor } from './colors';

/** The colors of a connection's collections, keyed by `database.collection`. */
export type CollectionColors = Record<string, CollectionColor>;

/** The colors of a connection's databases, keyed by the database's name. */
export type DatabaseColors = Record<string, CollectionColor>;

/** What `colorOf` needs of a connection. */
export interface ColoredConnection {
  color?: ConnectionColor;
  databaseColors?: DatabaseColors;
  collectionColors?: CollectionColors;
}

/** The key of a collection: a database name has no `.`, so the first one separates it from the collection's. */
export function namespaceOf(database: string, collection: string): string {
  return `${database}.${collection}`;
}

/** The collection whose color a GridFS bucket takes: its `.files` one. */
export function bucketCollection(bucket: string): string {
  return `${bucket}.files`;
}

/**
 * The color of something of the collection, or of the database without `collection`: the collection's own, otherwise
 * the database's own, otherwise the connection's. An own `none` is no color, and ends the search there.
 */
export function colorOf(connection: ColoredConnection | undefined, database: string, collection?: string): ConnectionColor | undefined {
  if (!connection) return undefined;
  const own = (collection !== undefined ? connection.collectionColors?.[namespaceOf(database, collection)] : undefined) ?? connection.databaseColors?.[database];
  if (own === 'none') return undefined;
  return own ?? connection.color;
}

/**
 * The color of a tab opened on a connection, on one of its databases or on one of its collections: the connection's
 * without a database, otherwise the one `colorOf` gives.
 */
export function scopeColor(connection: ColoredConnection | undefined, scope: { database?: string; collection?: string }): ConnectionColor | undefined {
  return scope.database === undefined ? connection?.color : colorOf(connection, scope.database, scope.collection);
}

/**
 * The own color of the collection, or of the database without `collection`, as the quick pick shows it: undefined
 * when it follows what is above it.
 */
export function ownColorOf(connection: ColoredConnection, database: string, collection?: string): CollectionColor | undefined {
  return collection === undefined ? connection.databaseColors?.[database] : connection.collectionColors?.[namespaceOf(database, collection)];
}

/**
 * The map with `namespace` (or the database's name, in the map of the databases) given `color`, or following what
 * is above it again when `color` is undefined.
 */
export function setCollectionColor(colors: CollectionColors | undefined, namespace: string, color: CollectionColor | undefined): CollectionColors | undefined {
  const next = { ...colors };
  if (color) next[namespace] = color;
  else delete next[namespace];
  return orUndefined(next);
}

/** The map with the color of `from` moved to `to`; unchanged (the same object) when `from` has none. */
export function renameCollectionColor(colors: CollectionColors | undefined, from: string, to: string): CollectionColors | undefined {
  if (!colors || !(from in colors)) return colors;
  const { [from]: color, ...rest } = colors;
  return orUndefined({ ...rest, [to]: color });
}

/**
 * The map without the colors of a dropped collection, of the two collections of a dropped bucket (`bucket` set), or
 * of every collection of a dropped database (`collection` undefined).
 */
export function dropCollectionColors(colors: CollectionColors | undefined, database: string, collection?: string, bucket = false): CollectionColors | undefined {
  if (!colors) return colors;
  const dropped = (ns: string) => {
    if (collection === undefined) return ns.startsWith(`${database}.`);
    if (bucket) return ns === namespaceOf(database, bucketCollection(collection)) || ns === namespaceOf(database, `${collection}.chunks`);
    return ns === namespaceOf(database, collection);
  };
  const kept = Object.entries(colors).filter(([ns]) => !dropped(ns));
  if (kept.length === Object.keys(colors).length) return colors;
  return orUndefined(Object.fromEntries(kept));
}

/** The valid entries of a map read from a file: a `database.collection` key and a preset, a hex color or `none`. */
export function readCollectionColors(value: unknown): CollectionColors | undefined {
  return readColors(value, /^[^.]+\..+$/);
}

/** The valid entries of a map of databases read from a file: a database's name and a preset, a hex color or `none`. */
export function readDatabaseColors(value: unknown): DatabaseColors | undefined {
  return readColors(value, /^[^.]+$/);
}

function readColors(value: unknown, key: RegExp): Record<string, CollectionColor> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([name, value]): [string, CollectionColor][] => {
    const color = value === 'none' ? 'none' : readColor(value);
    return key.test(name) && color ? [[name, color]] : [];
  });
  return orUndefined(Object.fromEntries(entries));
}

function orUndefined(colors: CollectionColors): CollectionColors | undefined {
  return Object.keys(colors).length ? colors : undefined;
}
