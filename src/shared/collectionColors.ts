// The colors of single collections, views and GridFS buckets, kept on their connection (D16): which color something
// of a collection takes, and how the map of colors changes when a collection is colored, renamed or dropped.
// No vscode dependency: the tree, the tabs, the decorations and the import of connections use it.
import type { CollectionColor, ConnectionColor } from '../connections';

const COLORS: readonly string[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'none'];

/** The colors of a connection's collections, keyed by `database.collection`. */
export type CollectionColors = Record<string, CollectionColor>;

/** What `colorOf` needs of a connection. */
export interface ColoredConnection {
  color?: ConnectionColor;
  collectionColors?: CollectionColors;
}

/** The colored circle before a color's name in the quick picks. */
export const COLOR_EMOJI: Record<ConnectionColor, string> = { red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢', blue: '🔵', purple: '🟣' };

export interface CollectionColorChoice {
  label: string;
  /** Undefined for `Connection's Color`: the collection follows its connection again. */
  color: CollectionColor | undefined;
  description?: string;
}

/**
 * The choices of `Set Color…` on a collection: the six colors, `None`, and `Connection's Color` described with the
 * connection's color; the collection's current choice is described `current`.
 */
export function collectionColorChoices(connectionColor: ConnectionColor | undefined, current: CollectionColor | undefined): CollectionColorChoice[] {
  const colors = (COLORS.filter((c) => c !== 'none') as ConnectionColor[]).map((color) => ({
    label: `${COLOR_EMOJI[color]} ${color[0].toUpperCase()}${color.slice(1)}`,
    color: color as CollectionColor | undefined,
  }));
  const choices = [...colors, { label: '⚪ None', color: 'none' as CollectionColor | undefined }, { label: "Connection's Color", color: undefined }];
  return choices.map((c) => {
    const notes = [c.color === undefined && (connectionColor ?? 'none'), c.color === current && 'current'].filter(Boolean);
    return notes.length ? { ...c, description: notes.join(' · ') } : c;
  });
}

/** The key of a collection: a database name has no `.`, so the first one separates it from the collection's. */
export function namespaceOf(database: string, collection: string): string {
  return `${database}.${collection}`;
}

/** The collection whose color a GridFS bucket takes: its `.files` one. */
export function bucketCollection(bucket: string): string {
  return `${bucket}.files`;
}

/** The color of something of the collection: its own, none when it is `none`, otherwise the connection's. */
export function colorOf(connection: ColoredConnection | undefined, database: string, collection: string): ConnectionColor | undefined {
  if (!connection) return undefined;
  const own = connection.collectionColors?.[namespaceOf(database, collection)];
  if (own === 'none') return undefined;
  return own ?? connection.color;
}

/** The collection's own color, as the quick pick shows it: undefined when it follows the connection. */
export function ownColorOf(connection: ColoredConnection, database: string, collection: string): CollectionColor | undefined {
  return connection.collectionColors?.[namespaceOf(database, collection)];
}

/** The map with `namespace` given `color`, or following the connection's again when `color` is undefined. */
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

/** The valid entries of a map read from a file or from storage: a `database.collection` key and a known color. */
export function readCollectionColors(value: unknown): CollectionColors | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([ns, color]) => /^[^.]+\..+$/.test(ns) && typeof color === 'string' && COLORS.includes(color),
  );
  return orUndefined(Object.fromEntries(entries) as CollectionColors);
}

function orUndefined(colors: CollectionColors): CollectionColors | undefined {
  return Object.keys(colors).length ? colors : undefined;
}
