// What `Copy` and `Paste` of the connections view work out before touching anything: the name a copy takes, which
// collection goes where when collections are pasted into a database, and what happens to the ones that exist there.
// No vscode, mongodb or Node dependency.

/** What `Copy` took from the tree: connections, databases, or collections and views of one database. */
export type Clipboard =
  | { kind: 'connection'; connectionIds: string[] }
  | { kind: 'database'; connectionId: string; databases: string[] }
  | { kind: 'collection'; connectionId: string; database: string; collections: PasteSource[] };

export interface PasteSource {
  name: string;
  isView: boolean;
  /** The GridFS bucket the collection is the `.files` or `.chunks` of, when the bucket was copied: they stay together. */
  bucket?: string;
}

/** What a tree node gives to `Copy`. */
export type CopiedNode =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'database'; connectionId: string; database: string }
  | { kind: 'collection'; connectionId: string; database: string; collection: string; isView: boolean }
  /** A GridFS bucket: its two collections. */
  | { kind: 'bucket'; connectionId: string; database: string; bucket: string }
  | { kind: 'other' };

/**
 * The clipboard for the selected nodes, or why they can't be copied together: they must be of one kind, databases of
 * one connection, collections of one database. A bucket is its `.files` and `.chunks` collections.
 */
export function clipboardOf(selected: CopiedNode[]): Clipboard | string {
  const bucketOf = new Map<string, string>();
  const nodes = selected.flatMap((n): CopiedNode[] => {
    if (n.kind !== 'bucket') return [n];
    return ['files', 'chunks'].map((part) => {
      bucketOf.set(`${n.bucket}.${part}`, n.bucket);
      return { kind: 'collection', connectionId: n.connectionId, database: n.database, collection: `${n.bucket}.${part}`, isView: false };
    });
  });
  const first = nodes[0];
  if (!first) return 'Select a connection, a database or a collection to copy it.';
  if (nodes.some((n) => n.kind === 'other')) return 'Only connections, databases, collections, views and buckets can be copied.';
  if (nodes.some((n) => n.kind !== first.kind)) return 'Copy only connections, only databases or only collections at a time.';
  if (first.kind === 'connection') {
    return { kind: 'connection', connectionIds: [...new Set(nodes.flatMap((n) => (n.kind === 'connection' ? [n.connectionId] : [])))] };
  }
  if (first.kind === 'database') {
    const databases = nodes.flatMap((n) => (n.kind === 'database' && n.connectionId === first.connectionId ? [n.database] : []));
    if (databases.length < nodes.length) return 'Copy the databases of one connection at a time.';
    return { kind: 'database', connectionId: first.connectionId, databases: [...new Set(databases)] };
  }
  if (first.kind === 'collection') {
    const collections = nodes.flatMap((n) =>
      n.kind === 'collection' && n.connectionId === first.connectionId && n.database === first.database
        ? [{ name: n.collection, isView: n.isView, ...(bucketOf.has(n.collection) && { bucket: bucketOf.get(n.collection) }) }]
        : [],
    );
    if (collections.length < nodes.length) return 'Copy the collections of one database at a time.';
    return {
      kind: 'collection',
      connectionId: first.connectionId,
      database: first.database,
      collections: collections.filter((c, i) => collections.findIndex((o) => o.name === c.name) === i),
    };
  }
  return 'Only connections, databases, collections, views and buckets can be copied.';
}

/**
 * A free name for a copy: `Production copy`, `Production copy 2` for a connection (`label`), `orders_copy`,
 * `orders_copy2` for a database or a collection (`identifier`).
 */
export function copyName(name: string, taken: Iterable<string>, style: 'label' | 'identifier'): string {
  const used = new Set(taken);
  const base = style === 'label' ? `${name} copy` : `${name}_copy`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = style === 'label' ? `${base} ${n}` : `${base}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export type ExistingKind = 'collection' | 'view';

export interface PasteItem {
  /** The collection or view copied. */
  source: string;
  /** Its name in the destination database. */
  target: string;
  isView: boolean;
  /** What has the target's name in the destination, if anything. */
  exists?: ExistingKind;
}

/**
 * Where each copied collection goes. In another database it keeps its name, and `exists` says what is there under
 * it; in its own database it gets a free `_copy` name. The two collections of a copied bucket `fs` become those of
 * the bucket `fs_copy`.
 */
export function planPaste(sources: PasteSource[], existing: ReadonlyMap<string, ExistingKind>, sameDatabase: boolean): PasteItem[] {
  const taken = new Set(existing.keys());
  const buckets = new Map<string, string>();
  const bucketCopy = (bucket: string) => {
    if (!buckets.has(bucket)) {
      // A bucket's name is taken when either of its collections is.
      const used = [...taken].flatMap((name) => (/\.(files|chunks)$/.test(name) ? [name.replace(/\.(files|chunks)$/, '')] : []));
      buckets.set(bucket, copyName(bucket, used, 'identifier'));
    }
    return buckets.get(bucket)!;
  };
  return sources.map((s) => {
    if (!sameDatabase) return { source: s.name, target: s.name, isView: s.isView, ...(existing.has(s.name) && { exists: existing.get(s.name) }) };
    const target = s.bucket ? `${bucketCopy(s.bucket)}${s.name.slice(s.bucket.length)}` : copyName(s.name, taken, 'identifier');
    taken.add(target);
    return { source: s.name, target, isView: s.isView };
  });
}

/** What to do with the collections that exist in the destination. */
export type ExistingMode = 'skip' | 'append' | 'upsert' | 'drop';

export type PasteAction = { do: 'create' | 'append' | 'upsert' | 'drop' } | { do: 'skip'; why: string };

/**
 * What pasting an item does. Documents can be appended or replaced only from a collection into a collection: a view
 * has none of its own, so with those two modes an existing view stays, and so does a collection a view would replace.
 */
export function pasteAction(item: PasteItem, mode: ExistingMode): PasteAction {
  if (!item.exists) return { do: 'create' };
  if (mode === 'drop') return { do: 'drop' };
  if (mode === 'skip') return { do: 'skip', why: 'it exists' };
  if (item.isView) return { do: 'skip', why: item.exists === 'view' ? 'the view exists' : 'a collection has this name' };
  if (item.exists === 'view') return { do: 'skip', why: 'a view has this name' };
  return { do: mode };
}
