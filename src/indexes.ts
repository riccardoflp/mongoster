// The indexes of a collection for the Indexes tab: what the server reports about them (definition,
// size, usage, builds in progress) and their changes: create, modify in place, drop and recreate.
import * as vscode from 'vscode';
import type { Collection, Db, Document } from 'mongodb';
import { relaxed } from './documentFs';
import { fromRelaxed } from './queries';
import { errorMessage } from './tree';
import { isPlainObject, parseQuery } from './shared/query';
import { IndexSpec, editableSpec, indexCommand, indexName, planIndexChange, ttlParts } from './shared/indexes';
import type { IndexInfo, IndexTotals } from './shared/messages';

/** IndexOptionsConflict, IndexKeySpecsConflict: an index with the same keys or name already exists. */
const CONFLICT_CODES = new Set([85, 86]);

export async function loadIndexes(db: Db, coll: Collection): Promise<{ indexes: IndexInfo[]; totals: IndexTotals }> {
  const list = await coll.listIndexes().toArray();
  const [stats, storage] = await Promise.all([
    coll
      .aggregate<Document>([{ $indexStats: {} }])
      .toArray()
      .catch(() => [] as Document[]),
    // One document per shard on a sharded cluster.
    coll
      .aggregate<Document>([{ $collStats: { storageStats: {} } }])
      .toArray()
      .then((r) => r.map((s) => s.storageStats as Document | undefined).filter((s): s is Document => !!s))
      .catch(() => [] as Document[]),
  ]);

  // An index being built may be missing from listIndexes: $indexStats has its definition.
  for (const s of stats) {
    if (s.building && s.spec && !list.some((ix) => ix.name === s.name)) list.push(s.spec as Document);
  }
  const builds = new Set<string>(storage.flatMap((s) => (s.indexBuilds as string[] | undefined) ?? []));
  for (const s of stats) if (s.building) builds.add(String(s.name));
  const progress = builds.size ? await buildProgress(db, coll) : new Map<string, IndexInfo['progress']>();

  const sum = (field: string) => (storage.length ? storage.reduce((n, s) => n + Number(s[field] ?? 0), 0) : undefined);
  const indexes = list.map((ix): IndexInfo => {
    const { key, name, ns: _ns, ...options } = relaxed(ix) as Record<string, unknown>;
    const usage = stats
      .filter((s) => s.name === ix.name && s.accesses)
      .map((s) => ({
        host: String(s.host ?? ''),
        shard: s.shard ? String(s.shard) : undefined,
        ops: Number(s.accesses.ops),
        since: s.accesses.since instanceof Date ? s.accesses.since.toISOString() : undefined,
      }));
    const sizes = storage.map((s) => s.indexSizes?.[ix.name]).filter((n) => n !== undefined);
    return {
      name: String(name),
      key: key as Record<string, unknown>,
      options,
      size: sizes.length ? sizes.reduce((n, s) => n + Number(s), 0) : undefined,
      ops: usage.length ? usage.reduce((n, u) => n + u.ops, 0) : undefined,
      // Counted on every member since at least the most recent of their starts.
      since: usage.map((u) => u.since).filter((s): s is string => !!s).sort().pop(),
      hosts: usage.length > 1 ? usage : undefined,
      building: builds.has(ix.name) || undefined,
      progress: progress.get(ix.name),
    };
  });
  return { indexes, totals: { documents: sum('count'), dataSize: sum('size'), indexSize: sum('totalIndexSize') } };
}

/**
 * How far the index builds running on the collection are, by index name (needs the inprog privilege).
 * A build has phases (scanning the collection, then inserting the keys), each counted from zero.
 */
async function buildProgress(db: Db, coll: Collection): Promise<Map<string, IndexInfo['progress']>> {
  const result = new Map<string, IndexInfo['progress']>();
  try {
    const res = await db.client.db('admin').command({ currentOp: 1, 'command.createIndexes': coll.collectionName, 'command.$db': db.databaseName });
    for (const op of (res.inprog ?? []) as Document[]) {
      const total = Number(op.progress?.total);
      if (!total) continue;
      const phase = typeof op.msg === 'string' ? op.msg.replace(/^Index Build: /, '').replace(/ Index Build:.*$/, '') : undefined;
      for (const ix of (op.command?.indexes ?? []) as Document[]) result.set(String(ix.name), { done: Number(op.progress.done), total, phase });
    }
  } catch {
    // Without the privilege the tab only says that the index is being built.
  }
  return result;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = parseQuery(text);
  } catch (err) {
    throw new Error(`${label}: ${errorMessage(err)}`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

/**
 * Creates the index. The command is sent as it is, rather than through the driver's createIndex which
 * silently leaves out the options it doesn't know: the server refuses a mistyped one.
 * Resolves with the index's name, or undefined when an identical index was already there.
 */
async function createIndex(db: Db, coll: Collection, spec: IndexSpec): Promise<string | undefined> {
  const { name: _name, commitQuorum, ...options } = spec.options;
  const name = indexName(spec);
  const res = await db.command({
    createIndexes: coll.collectionName,
    indexes: [{ key: fromRelaxed(spec.keys), name, ...(fromRelaxed(options) as Document) }],
    ...(commitQuorum !== undefined && { commitQuorum }),
  });
  return res.note || (res.numIndexesBefore !== undefined && res.numIndexesBefore === res.numIndexesAfter) ? undefined : name;
}

const list = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]);

/**
 * Creates an index from the texts of the dialog (mongosh syntax) or, with `original`, turns that
 * index into it: in place when only what collMod can change differs, otherwise by dropping and
 * building it again after a confirmation. Resolves with what was done, or undefined when cancelled.
 */
export async function saveIndex(db: Db, coll: Collection, original: string | undefined, keysText: string, optionsText: string): Promise<string | undefined> {
  const next: IndexSpec = { keys: parseObject(keysText, 'Keys'), options: parseObject(optionsText, 'Options') };
  if (!Object.keys(next.keys).length) throw new Error('Keys: enter the fields to index, e.g. { status: 1, age: -1 }');

  if (original === undefined) {
    const name = await createIndex(db, coll, next);
    return name ? `Created index ${name}.` : `An identical index already exists: nothing was created.`;
  }

  const current = (await coll.listIndexes().toArray()).find((ix) => ix.name === original);
  if (!current) throw new Error(`The index ${original} no longer exists.`);
  const { key, name: _name, ns: _ns, ...reported } = relaxed(current) as Record<string, unknown>;
  const before = editableSpec(original, key as Record<string, unknown>, reported);
  const change = planIndexChange(before, next);
  if (change.kind === 'none') return `No changes to the index ${original}.`;

  if (change.kind === 'modify') {
    const done: string[] = [];
    if (change.hidden !== undefined) {
      await db.command({ collMod: coll.collectionName, index: { name: original, hidden: change.hidden } });
      done.push(change.hidden ? 'hidden' : 'no longer hidden');
    }
    if (change.expireAfterSeconds !== undefined) {
      await db.command({ collMod: coll.collectionName, index: { name: original, expireAfterSeconds: change.expireAfterSeconds } });
      const { value, unit } = ttlParts(change.expireAfterSeconds);
      done.push(`documents expire after ${value.toLocaleString('en-US')} ${unit}`);
    }
    return `Index ${original}: ${done.join(', ')}.`;
  }

  const name = indexName(next);
  const answer = await vscode.window.showWarningMessage(
    `Drop and recreate the index ${original} of ${coll.collectionName}?`,
    {
      modal: true,
      detail: `MongoDB can't change the ${list(change.changed)} of an existing index: it is dropped and built again with the new definition. Building reads the whole collection, and until it ends queries can't use the index${before.options.unique ? " and duplicate values aren't rejected" : ''}.`,
    },
    'Drop and Recreate',
  );
  if (answer !== 'Drop and Recreate') return undefined;

  if (name !== original) {
    // Under another name the two can exist side by side: the old one is dropped once the new one is
    // built, and stays if the new definition is refused. Not when they only differ by the name.
    try {
      if (await createIndex(db, coll, next)) {
        await coll.dropIndex(original);
        return `Created index ${name} and dropped ${original}.`;
      }
    } catch (err) {
      if (!CONFLICT_CODES.has((err as { code?: number }).code ?? 0)) throw err;
    }
  }
  await coll.dropIndex(original);
  try {
    await createIndex(db, coll, next);
  } catch (err) {
    const { v: _v, ns: _ns2, ...old } = current;
    try {
      await db.command({ createIndexes: coll.collectionName, indexes: [old] });
    } catch (restoreErr) {
      throw new Error(
        `${errorMessage(err)}\nThe index ${original} was dropped and could not be created again as it was (${errorMessage(restoreErr)}). Its definition:\n${indexCommand(coll.collectionName, before)}`,
      );
    }
    throw new Error(`${errorMessage(err)}\nThe index ${original} was created again as it was.`);
  }
  return name === original ? `Recreated index ${name}.` : `Created index ${name} and dropped ${original}.`;
}
