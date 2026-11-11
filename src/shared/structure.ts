// Comparing the structure of two databases (e.g. development and production before a release):
// collections and views on one side only, their options, indexes, search indexes and shard keys; and
// the steps, as driver operations and as a mongosh script, that make the right side like the left one.
// Values are relaxed EJSON plain values, as everywhere between the webview and the extension host.
import { FieldDiff, fieldDiff } from './compare';
import { IndexSpec, editableSpec, indexCommand, planIndexChange, stable } from './indexes';
import { isPlainObject, prettyShell, toShell } from './query';
import { SearchIndexType, searchIndexCommand } from './searchIndexes';

type Obj = Record<string, unknown>;

export type CollectionType = 'collection' | 'view' | 'timeseries';

export interface IndexShape {
  name: string;
  /** As createIndex takes them (a text index has its fields back). */
  keys: Obj;
  /** createIndex options without the name, defaults left out. */
  options: Obj;
}

export interface SearchIndexShape {
  name: string;
  /** search or vectorSearch. */
  type: string;
  definition: Obj;
}

export interface ShardKeyShape {
  key: Obj;
  unique?: boolean;
}

export interface CollectionShape {
  name: string;
  type: CollectionType;
  /** The compared options (normalizeOptions). */
  options: Obj;
  /** Without _id_, which every collection has. Empty for views. */
  indexes: IndexShape[];
  /** Undefined when they weren't read (views, time series, a server without search). */
  searchIndexes?: SearchIndexShape[];
  shardKey?: ShardKeyShape;
}

export interface DatabaseShape {
  collections: CollectionShape[];
  /** Whether search indexes could be read: `unsupported` for a server without search. */
  search: 'ok' | 'unsupported' | 'error';
  searchError?: string;
  /** Through a mongos: shard keys are known. */
  sharded: boolean;
}

// ---- normalizing what the server reports

/** Options of listCollections that make a collection behave differently. */
const COLLECTION_OPTIONS = [
  'validator',
  'validationLevel',
  'validationAction',
  'capped',
  'size',
  'max',
  'timeseries',
  'expireAfterSeconds',
  'clusteredIndex',
  'collation',
  'changeStreamPreAndPostImages',
];
const VIEW_OPTIONS = ['viewOn', 'pipeline', 'collation'];

/** The options as compared: only those that matter, without what means the default. */
export function normalizeOptions(type: CollectionType, raw: Obj): Obj {
  const o: Obj = {};
  for (const k of type === 'view' ? VIEW_OPTIONS : COLLECTION_OPTIONS) if (raw[k] !== undefined && raw[k] !== null) o[k] = raw[k];
  if (type === 'view') {
    if (!Array.isArray(o.pipeline)) o.pipeline = [];
  } else {
    if (isPlainObject(o.validator) && !Object.keys(o.validator).length) delete o.validator;
    if (o.validationLevel === 'strict') delete o.validationLevel;
    if (o.validationAction === 'error') delete o.validationAction;
    if (!o.capped) {
      delete o.capped;
      delete o.size;
      delete o.max;
    } else {
      o.capped = true;
      if (!o.max) delete o.max;
    }
    if (isPlainObject(o.changeStreamPreAndPostImages) && !o.changeStreamPreAndPostImages.enabled) delete o.changeStreamPreAndPostImages;
    if (isPlainObject(o.clusteredIndex)) {
      const { v: _v, ...clustered } = o.clusteredIndex;
      if (clustered.name === '_id_') delete clustered.name;
      o.clusteredIndex = clustered;
    }
    // The bucketing that a granularity implies is reported by some versions only.
    if (isPlainObject(o.timeseries) && typeof o.timeseries.granularity === 'string') {
      const { bucketMaxSpanSeconds: _m, bucketRoundingSeconds: _r, ...ts } = o.timeseries;
      o.timeseries = ts;
    }
  }
  if (isPlainObject(o.collation)) {
    const { version: _version, ...collation } = o.collation;
    o.collation = collation;
  }
  return o;
}

/** An index of listIndexes (relaxed) as compared; undefined for _id_, which every collection has. */
export function indexShape(raw: Obj): IndexShape | undefined {
  const { key, name, ...reported } = raw;
  if (name === '_id_' || !isPlainObject(key)) return undefined;
  const { keys, options } = editableSpec(String(name), key, reported);
  const { name: _name, ...rest } = options;
  return { name: String(name), keys, options: rest };
}

/** A search index of $listSearchIndexes as compared. */
export function searchIndexShape(info: { name: string; type: string; definition: Obj }): SearchIndexShape {
  return { name: info.name, type: info.type, definition: info.definition };
}

// ---- operations

export type StructureOp =
  /** A view has viewOn and pipeline in its options. */
  | { type: 'createCollection'; collection: string; options: Obj }
  | { type: 'collMod'; collection: string; changes: Obj }
  | { type: 'convertToCapped'; collection: string; size: number }
  | { type: 'drop'; collection: string }
  /** `options` has the name. */
  | { type: 'createIndex'; collection: string; keys: Obj; options: Obj }
  | { type: 'dropIndex'; collection: string; name: string }
  | { type: 'createSearchIndex'; collection: string; name: string; searchType: string; definition: Obj }
  | { type: 'updateSearchIndex'; collection: string; name: string; definition: Obj }
  | { type: 'dropSearchIndex'; collection: string; name: string }
  | { type: 'shardCollection'; collection: string; key: Obj; unique?: boolean };

export interface StructureStep {
  /** Null for what can't be done by a command: the script says it as a comment. */
  op: StructureOp | null;
  /** Drops something, or loses data: commented out in the script, applied only when asked. */
  destructive?: boolean;
  /** Said above the command in the script. */
  note?: string;
}

export type StructureKind = 'same' | 'different' | 'onlyLeft' | 'onlyRight';
export type StructureObject = 'collection' | 'view' | 'options' | 'index' | 'searchIndex' | 'shardKey';

export interface StructureDiff {
  /** Identifies the difference in messages. */
  id: string;
  collection: string;
  /** The collection's type on the left (on the right when it is only there). */
  collectionType: CollectionType;
  object: StructureObject;
  /** Index or search index name. */
  name?: string;
  kind: StructureKind;
  summary: string;
  /** The definition on each side (absent on the side that lacks it). */
  left?: unknown;
  right?: unknown;
  /** What differs, field by field. */
  fields?: FieldDiff[];
  /** What makes the right side like the left one. */
  steps: StructureStep[];
}

export interface StructureCounts {
  same: number;
  different: number;
  onlyLeft: number;
  onlyRight: number;
}

export interface StructureResult {
  diffs: StructureDiff[];
  counts: StructureCounts;
  /** What wasn't compared, and why. */
  notes: string[];
}

// ---- comparing

const NO_ORDER = { ignore: [] as string[], ignoreOrder: true, numbersByValue: false };
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const keysText = (keys: Obj) => toShell(keys);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('x') ? 'es' : 's'}`;

const indexDoc = (ix: IndexShape): Obj => ({ name: ix.name, key: ix.keys, ...ix.options });
const indexSpec = (ix: IndexShape): IndexSpec => ({ keys: ix.keys, options: { ...ix.options, name: ix.name } });
/** What identifies an index for MongoDB: two indexes can have the same keys with another collation or partial filter. */
const identity = (ix: IndexShape) => `${JSON.stringify(ix.keys)}|${stable(ix.options.collation ?? null)}|${stable(ix.options.partialFilterExpression ?? null)}`;
const createIndex = (collection: string, ix: IndexShape): StructureStep => ({ op: { type: 'createIndex', collection, keys: ix.keys, options: { ...ix.options, name: ix.name } } });
const createSearch = (collection: string, ix: SearchIndexShape): StructureStep => ({
  op: { type: 'createSearchIndex', collection, name: ix.name, searchType: ix.type, definition: ix.definition },
});

/** The steps that create the collection as it is on the left, with its indexes. */
function createSteps(c: CollectionShape, withSearch: boolean, withShardKey: boolean): StructureStep[] {
  if (c.type === 'view') return [{ op: { type: 'createCollection', collection: c.name, options: c.options } }];
  const steps: StructureStep[] = [{ op: { type: 'createCollection', collection: c.name, options: c.options } }];
  for (const ix of c.indexes) steps.push(createIndex(c.name, ix));
  if (withShardKey && c.shardKey) steps.push({ op: { type: 'shardCollection', collection: c.name, key: c.shardKey.key, ...(c.shardKey.unique && { unique: true }) } });
  if (withSearch) for (const ix of c.searchIndexes ?? []) steps.push(createSearch(c.name, ix));
  return steps;
}

/** What the collection is, for the side-by-side detail of a collection found on one side only. */
function describeCollection(c: CollectionShape): Obj {
  return {
    type: c.type,
    ...(Object.keys(c.options).length && { options: c.options }),
    ...(c.type !== 'view' && { indexes: c.indexes.map(indexDoc) }),
    ...(c.searchIndexes?.length && { searchIndexes: c.searchIndexes.map((s) => ({ name: s.name, type: s.type, definition: s.definition })) }),
    ...(c.shardKey && { shardKey: c.shardKey }),
  };
}

const TYPE_NAMES: Record<CollectionType, string> = { collection: 'collection', view: 'view', timeseries: 'time series collection' };

/** The steps that give the right collection the options of the left one, and what differs. */
export function optionSteps(name: string, type: CollectionType, left: Obj, right: Obj): StructureStep[] {
  const steps: StructureStep[] = [];
  const differs = (k: string) => !same(left[k] ?? null, right[k] ?? null);
  if (type === 'view') {
    if (differs('collation')) {
      // collMod can't change a view's collation: it is created again (a view holds no data).
      steps.push(
        { op: { type: 'drop', collection: name }, note: "A view's collation can't be changed: the view is dropped and created again." },
        { op: { type: 'createCollection', collection: name, options: left } },
      );
    } else if (differs('viewOn') || differs('pipeline')) {
      steps.push({ op: { type: 'collMod', collection: name, changes: { viewOn: left.viewOn, pipeline: left.pipeline ?? [] } } });
    }
    return steps;
  }

  const changes: Obj = {};
  if (differs('validator')) changes.validator = left.validator ?? {};
  if (differs('validationLevel')) changes.validationLevel = left.validationLevel ?? 'strict';
  if (differs('validationAction')) changes.validationAction = left.validationAction ?? 'error';
  if (differs('changeStreamPreAndPostImages')) changes.changeStreamPreAndPostImages = left.changeStreamPreAndPostImages ?? { enabled: false };
  if (differs('expireAfterSeconds') && (type === 'timeseries' || left.clusteredIndex || right.clusteredIndex)) {
    changes.expireAfterSeconds = left.expireAfterSeconds ?? 'off';
  }

  const manual: string[] = [];
  if (differs('timeseries')) {
    const l = isPlainObject(left.timeseries) ? left.timeseries : {};
    const r = isPlainObject(right.timeseries) ? right.timeseries : {};
    const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
    const onlyGranularity = [...keys].every((k) => k === 'granularity' || same(l[k] ?? null, r[k] ?? null));
    if (onlyGranularity && typeof l.granularity === 'string') changes.timeseries = { granularity: l.granularity };
    else manual.push("The time series options (other than a coarser granularity) can't be changed: create the collection again and copy its documents.");
  }

  if (left.capped && right.capped) {
    if (differs('size')) changes.cappedSize = left.size;
    if (differs('max')) changes.cappedMax = left.max ?? 0;
  }
  if (Object.keys(changes).length) steps.push({ op: { type: 'collMod', collection: name, changes } });

  if (left.capped && !right.capped && typeof left.size === 'number') {
    steps.push({
      op: { type: 'convertToCapped', collection: name, size: left.size },
      destructive: true,
      note: 'convertToCapped rewrites the collection: the oldest documents beyond the size are lost, and its indexes other than _id are dropped.',
    });
  } else if (!left.capped && right.capped) {
    manual.push("A capped collection can't be made uncapped: create it again and copy its documents.");
  }
  if (differs('collation')) manual.push("The default collation of a collection can't be changed: create it again with the collation and copy its documents.");
  if (differs('clusteredIndex')) manual.push("A collection can't become clustered or stop being clustered: create it again and copy its documents.");
  for (const note of manual) steps.push({ op: null, note });
  return steps;
}

/** Index pairs: by name and identity, then by identity (another name), then by name (other keys). */
function pairIndexes(left: IndexShape[], right: IndexShape[]): { pairs: [IndexShape, IndexShape][]; onlyLeft: IndexShape[]; onlyRight: IndexShape[] } {
  const l = [...left];
  const r = [...right];
  const pairs: [IndexShape, IndexShape][] = [];
  const take = (match: (a: IndexShape, b: IndexShape) => boolean) => {
    for (const a of [...l]) {
      const i = r.findIndex((b) => match(a, b));
      if (i < 0) continue;
      pairs.push([a, r[i]]);
      r.splice(i, 1);
      l.splice(l.indexOf(a), 1);
    }
  };
  take((a, b) => a.name === b.name && identity(a) === identity(b));
  take((a, b) => identity(a) === identity(b));
  take((a, b) => a.name === b.name);
  return { pairs, onlyLeft: l, onlyRight: r };
}

function compareIndexes(collection: string, type: CollectionType, left: IndexShape[], right: IndexShape[]): StructureDiff[] {
  const out: StructureDiff[] = [];
  const base = { collection, collectionType: type, object: 'index' as const };
  const { pairs, onlyLeft, onlyRight } = pairIndexes(left, right);
  for (const [a, b] of pairs) {
    const id = `${collection}\u0000index\u0000${a.name}`;
    const change = planIndexChange(indexSpec(b), indexSpec(a));
    if (change.kind === 'none') {
      out.push({ ...base, id, name: a.name, kind: 'same', summary: keysText(a.keys), left: indexDoc(a), right: indexDoc(b), steps: [] });
      continue;
    }
    const keysDiffer = JSON.stringify(a.keys) !== JSON.stringify(b.keys);
    const summary =
      a.name !== b.name && !keysDiffer
        ? `Same keys ${keysText(a.keys)}, named ${b.name} on the right${change.kind === 'recreate' && change.changed.length > 1 ? `; different ${change.changed.filter((k) => k !== 'name').join(', ')}` : ''}`
        : keysDiffer && a.name === b.name
          ? `Same name, different keys: ${keysText(a.keys)} on the left, ${keysText(b.keys)} on the right`
          : `Different ${(change.kind === 'recreate' ? change.changed : Object.keys(change).filter((k) => k !== 'kind')).join(', ')}`;
    const steps: StructureStep[] =
      change.kind === 'modify'
        ? [
            {
              op: {
                type: 'collMod',
                collection,
                changes: {
                  index: {
                    name: b.name,
                    ...(change.hidden !== undefined && { hidden: change.hidden }),
                    ...(change.expireAfterSeconds !== undefined && { expireAfterSeconds: change.expireAfterSeconds }),
                  },
                },
              },
            },
          ]
        : [
            {
              op: { type: 'dropIndex', collection, name: b.name },
              destructive: true,
              note: `MongoDB can't change ${change.changed.join(', ')} of an index: it is dropped and built again. Queries can't use it in the meantime.`,
            },
            { ...createIndex(collection, a), destructive: true },
          ];
    out.push({ ...base, id, name: a.name, kind: 'different', summary, left: indexDoc(a), right: indexDoc(b), fields: fieldDiff(indexDoc(a), indexDoc(b), NO_ORDER), steps });
  }
  for (const a of onlyLeft) {
    out.push({ ...base, id: `${collection}\u0000index\u0000${a.name}`, name: a.name, kind: 'onlyLeft', summary: `Missing on the right: ${keysText(a.keys)}`, left: indexDoc(a), steps: [createIndex(collection, a)] });
  }
  for (const b of onlyRight) {
    out.push({
      ...base,
      id: `${collection}\u0000index-right\u0000${b.name}`,
      name: b.name,
      kind: 'onlyRight',
      summary: `Only on the right: ${keysText(b.keys)}`,
      right: indexDoc(b),
      steps: [{ op: { type: 'dropIndex', collection, name: b.name }, destructive: true }],
    });
  }
  return out.sort((x, y) => (x.name ?? '').localeCompare(y.name ?? ''));
}

function compareSearchIndexes(collection: string, type: CollectionType, left: SearchIndexShape[], right: SearchIndexShape[]): StructureDiff[] {
  const out: StructureDiff[] = [];
  const base = { collection, collectionType: type, object: 'searchIndex' as const };
  const doc = (s: SearchIndexShape) => ({ name: s.name, type: s.type, definition: s.definition });
  const id = (name: string) => `${collection}\u0000search\u0000${name}`;
  for (const a of left) {
    const b = right.find((s) => s.name === a.name);
    if (!b) {
      out.push({ ...base, id: id(a.name), name: a.name, kind: 'onlyLeft', summary: `Missing on the right (${a.type})`, left: doc(a), steps: [createSearch(collection, a)] });
      continue;
    }
    if (a.type === b.type && same(a.definition, b.definition)) {
      out.push({ ...base, id: id(a.name), name: a.name, kind: 'same', summary: a.type, left: doc(a), right: doc(b), steps: [] });
      continue;
    }
    const steps: StructureStep[] =
      a.type === b.type
        ? [{ op: { type: 'updateSearchIndex', collection, name: a.name, definition: a.definition } }]
        : [
            { op: { type: 'dropSearchIndex', collection, name: b.name }, destructive: true, note: "The type of a search index can't be changed: it is dropped and built again." },
            { ...createSearch(collection, a), destructive: true },
          ];
    out.push({
      ...base,
      id: id(a.name),
      name: a.name,
      kind: 'different',
      summary: a.type === b.type ? 'Different definition' : `${a.type} on the left, ${b.type} on the right`,
      left: doc(a),
      right: doc(b),
      fields: fieldDiff(doc(a), doc(b), NO_ORDER),
      steps,
    });
  }
  for (const b of right) {
    if (left.some((s) => s.name === b.name)) continue;
    out.push({
      ...base,
      id: `${collection}\u0000search-right\u0000${b.name}`,
      name: b.name,
      kind: 'onlyRight',
      summary: `Only on the right (${b.type})`,
      right: doc(b),
      steps: [{ op: { type: 'dropSearchIndex', collection, name: b.name }, destructive: true }],
    });
  }
  return out;
}

function compareShardKeys(collection: string, type: CollectionType, left?: ShardKeyShape, right?: ShardKeyShape): StructureDiff | undefined {
  if (!left && !right) return undefined;
  const base = { id: `${collection}\u0000shardKey\u0000`, collection, collectionType: type, object: 'shardKey' as const, left, right };
  if (left && right && same(left, right)) return { ...base, kind: 'same', summary: keysText(left.key), steps: [] };
  if (left && !right) {
    return {
      ...base,
      kind: 'onlyLeft',
      summary: `Sharded on the left by ${keysText(left.key)}, not on the right`,
      steps: [{ op: { type: 'shardCollection', collection, key: left.key, ...(left.unique && { unique: true }) }, note: 'The collection needs an index that starts with the shard key.' }],
    };
  }
  if (!left && right) {
    return {
      ...base,
      kind: 'onlyRight',
      summary: `Sharded on the right by ${keysText(right.key)}, not on the left`,
      steps: [{ op: null, note: 'A sharded collection is made unsharded with unshardCollection (MongoDB 8.0 or later), which moves its data to one shard.' }],
    };
  }
  return {
    ...base,
    kind: 'different',
    summary: `Shard key ${keysText(left!.key)} on the left, ${keysText(right!.key)} on the right`,
    fields: fieldDiff(left, right, NO_ORDER),
    steps: [{ op: null, note: `Changing the shard key means resharding: reshardCollection with key ${keysText(left!.key)} (MongoDB 5.0 or later), which copies the whole collection.` }],
  };
}

/** Every difference (and what is the same) between the two databases, grouped by collection. */
export function diffStructure(left: DatabaseShape, right: DatabaseShape): StructureResult {
  const notes: string[] = [];
  const search = left.search === 'ok' && right.search === 'ok';
  const sharded = left.sharded && right.sharded;
  const countSearch = (db: DatabaseShape) => db.collections.reduce((n, c) => n + (c.searchIndexes?.length ?? 0), 0);
  if (!search) {
    for (const [side, db, other] of [
      ['left', left, right],
      ['right', right, left],
    ] as const) {
      if (db.search === 'error') notes.push(`Search indexes are not compared: they could not be read on the ${side}: ${db.searchError ?? 'unknown error'}`);
      else if (db.search === 'unsupported' && other.search === 'ok' && countSearch(other)) {
        notes.push(`Search indexes are not compared: the ${side} server has no search (${plural(countSearch(other), 'search index')} on the ${side === 'left' ? 'right' : 'left'}).`);
      }
    }
  }
  if (left.sharded !== right.sharded) {
    const [side, db] = left.sharded ? ['left', left] : ['right', right];
    if (db.collections.some((c) => c.shardKey)) notes.push(`Shard keys are not compared: only the ${side} is a sharded cluster.`);
  }

  const diffs: StructureDiff[] = [];
  const leftBy = new Map(left.collections.map((c) => [c.name, c]));
  const rightBy = new Map(right.collections.map((c) => [c.name, c]));
  const names = [...new Set([...leftBy.keys(), ...rightBy.keys()])].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const l = leftBy.get(name);
    const r = rightBy.get(name);
    const object = (c: CollectionShape) => (c.type === 'view' ? 'view' : 'collection');
    if (l && !r) {
      diffs.push({
        id: `${name}\u0000collection\u0000`,
        collection: name,
        collectionType: l.type,
        object: object(l),
        kind: 'onlyLeft',
        summary: `${capitalize(TYPE_NAMES[l.type])} missing on the right${l.type === 'view' ? ` (on ${String(l.options.viewOn)})` : l.indexes.length ? `, with ${plural(l.indexes.length, 'index')}` : ''}`,
        left: describeCollection(l),
        steps: createSteps(l, search, sharded),
      });
      continue;
    }
    if (!l && r) {
      diffs.push({
        id: `${name}\u0000collection\u0000`,
        collection: name,
        collectionType: r.type,
        object: object(r),
        kind: 'onlyRight',
        summary: `${capitalize(TYPE_NAMES[r.type])} only on the right`,
        right: describeCollection(r),
        steps: [{ op: { type: 'drop', collection: name }, destructive: true, note: r.type === 'view' ? undefined : 'Its documents and indexes are deleted.' }],
      });
      continue;
    }
    if (!l || !r) continue;

    if ((l.type === 'view') !== (r.type === 'view') || (l.type === 'timeseries') !== (r.type === 'timeseries')) {
      diffs.push({
        id: `${name}\u0000collection\u0000`,
        collection: name,
        collectionType: l.type,
        object: object(l),
        kind: 'different',
        summary: `A ${TYPE_NAMES[l.type]} on the left, a ${TYPE_NAMES[r.type]} on the right`,
        left: describeCollection(l),
        right: describeCollection(r),
        steps: [
          { op: { type: 'drop', collection: name }, destructive: true, note: `The ${TYPE_NAMES[r.type]} is dropped and created again as a ${TYPE_NAMES[l.type]}${r.type === 'view' ? '' : ': its documents are deleted'}.` },
          ...createSteps(l, search, sharded).map((s) => ({ ...s, destructive: true })),
        ],
      });
      continue;
    }

    const optionsSame = same(l.options, r.options);
    diffs.push({
      id: `${name}\u0000options\u0000`,
      collection: name,
      collectionType: l.type,
      object: l.type === 'view' ? 'view' : 'options',
      kind: optionsSame ? 'same' : 'different',
      summary: optionsSame
        ? l.type === 'view'
          ? `View on ${String(l.options.viewOn)}`
          : Object.keys(l.options).length
            ? `Same options: ${Object.keys(l.options).join(', ')}`
            : 'Same options (none)'
        : `Different ${optionNames(l.options, r.options).join(', ')}`,
      left: l.options,
      right: r.options,
      ...(!optionsSame && { fields: fieldDiff(l.options, r.options, NO_ORDER) }),
      steps: optionsSame ? [] : optionSteps(name, l.type, l.options, r.options),
    });
    if (l.type === 'view') continue;
    if (sharded) {
      const d = compareShardKeys(name, l.type, l.shardKey, r.shardKey);
      if (d) diffs.push(d);
    }
    diffs.push(...compareIndexes(name, l.type, l.indexes, r.indexes));
    if (search && l.searchIndexes && r.searchIndexes) diffs.push(...compareSearchIndexes(name, l.type, l.searchIndexes, r.searchIndexes));
  }

  const counts: StructureCounts = { same: 0, different: 0, onlyLeft: 0, onlyRight: 0 };
  for (const d of diffs) counts[d.kind]++;
  return { diffs, counts, notes };
}

/** The top-level options that differ. */
function optionNames(a: Obj, b: Obj): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k] ?? null, b[k] ?? null));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- the script

const coll = (name: string) => `db.getCollection(${JSON.stringify(name)})`;

/** The mongosh command of an operation; `database` is the right side's (for shardCollection). */
export function opCommand(op: StructureOp, database: string): string {
  switch (op.type) {
    case 'createCollection': {
      if (typeof op.options.viewOn === 'string') {
        const { viewOn, pipeline, ...rest } = op.options;
        const args = [JSON.stringify(op.collection), JSON.stringify(viewOn), prettyShell(pipeline ?? [], 0, 70), ...(Object.keys(rest).length ? [prettyShell(rest, 0, 70)] : [])];
        return `db.createView(${args.join(', ')})`;
      }
      const options = op.options;
      return `db.createCollection(${JSON.stringify(op.collection)}${Object.keys(options).length ? `, ${prettyShell(options, 0, 70)}` : ''})`;
    }
    case 'collMod':
      return `db.runCommand(${prettyShell({ collMod: op.collection, ...op.changes }, 0, 70)})`;
    case 'convertToCapped':
      return `db.runCommand(${toShell({ convertToCapped: op.collection, size: op.size })})`;
    case 'drop':
      return `${coll(op.collection)}.drop()`;
    case 'createIndex':
      return indexCommand(op.collection, { keys: op.keys, options: op.options });
    case 'dropIndex':
      return `${coll(op.collection)}.dropIndex(${JSON.stringify(op.name)})`;
    case 'createSearchIndex':
      return searchIndexCommand(op.collection, op.name, op.searchType as SearchIndexType, op.definition);
    case 'updateSearchIndex':
      return searchIndexCommand(op.collection, op.name, 'search', op.definition, true);
    case 'dropSearchIndex':
      return `${coll(op.collection)}.dropSearchIndex(${JSON.stringify(op.name)})`;
    case 'shardCollection':
      return `db.adminCommand(${toShell({ shardCollection: `${database}.${op.collection}`, key: op.key, ...(op.unique && { unique: true }) })})`;
  }
}

/** The script lines of some steps: destructive ones commented out unless `drops`. */
export function stepLines(steps: StructureStep[], database: string, drops: boolean): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.note) lines.push(`// ${step.note}`);
    if (!step.op) continue;
    const command = `${opCommand(step.op, database)};`;
    if (step.destructive && !drops) {
      lines.push('// DESTRUCTIVE, optional: remove the // to run it.');
      lines.push(...command.split('\n').map((l) => `// ${l}`));
    } else {
      if (step.destructive) lines.push('// DESTRUCTIVE');
      lines.push(...command.split('\n'));
    }
  }
  return lines;
}

/** When a difference's steps run in the script: what others need first. */
function phase(d: StructureDiff): number {
  if (d.kind === 'onlyRight' && d.object !== 'shardKey') return 6;
  switch (d.object) {
    case 'collection':
      return d.kind === 'onlyLeft' ? 0 : 1;
    case 'options':
      return 2;
    case 'index':
      return 2;
    case 'shardKey':
      return 3;
    case 'view':
      return 4;
    case 'searchIndex':
      return 5;
  }
}

/** The differences in the order their steps can run: views after what they are on. */
export function orderForScript(diffs: StructureDiff[]): StructureDiff[] {
  const sorted = diffs.filter((d) => d.steps.length).sort((a, b) => phase(a) - phase(b) || a.collection.localeCompare(b.collection));
  // Views created or changed: each after the view it is on, when that one is too.
  const views = sorted.filter((d) => phase(d) === 4);
  const viewOn = (d: StructureDiff) => {
    const left = isPlainObject(d.left) ? d.left : {};
    const on = left.viewOn ?? (isPlainObject(left.options) ? left.options.viewOn : undefined);
    return typeof on === 'string' ? on : undefined;
  };
  const placed: StructureDiff[] = [];
  const visit = (d: StructureDiff, seen: Set<StructureDiff>) => {
    if (placed.includes(d) || seen.has(d)) return;
    seen.add(d);
    const on = viewOn(d);
    for (const other of views) if (other !== d && other.collection === on) visit(other, seen);
    placed.push(d);
  };
  for (const d of views) visit(d, new Set());
  const rest = sorted.filter((d) => !views.includes(d));
  return [...rest.filter((d) => phase(d) < 4), ...placed, ...rest.filter((d) => phase(d) >= 4)];
}

export interface ScriptOptions {
  /** The right side's database. */
  database: string;
  /** "connection › database" of each side, for the header. */
  left: string;
  right: string;
  /** Destructive steps not commented out. */
  drops: boolean;
}

/** A mongosh script that makes the right database like the left one for the given differences. */
export function structureScript(diffs: StructureDiff[], o: ScriptOptions): string {
  const ordered = orderForScript(diffs);
  const destructive = ordered.some((d) => d.steps.some((s) => s.destructive && s.op));
  const lines = [
    `// Makes ${o.right} like ${o.left}.`,
    '// Generated by Mongoster (Compare Structure).',
    ...(destructive
      ? [o.drops ? '// Steps marked DESTRUCTIVE drop indexes, collections or data: check them before running the script.' : '// Steps that drop something are commented out: remove the // in front of them to run them too.']
      : []),
    '',
    `use(${JSON.stringify(o.database)});`,
  ];
  if (!ordered.length) lines.push('', '// Nothing to change: the structures are the same.');
  for (const d of ordered) {
    lines.push('', `// ${d.collection}: ${diffTitle(d)} – ${d.summary}`, ...stepLines(d.steps, o.database, o.drops));
  }
  return `${lines.join('\n')}\n`;
}

const OBJECT_NAMES: Record<StructureObject, string> = { collection: 'collection', view: 'view', options: 'options', index: 'index', searchIndex: 'search index', shardKey: 'shard key' };

/** "index status_1", "options", "search index default". */
export function diffTitle(d: StructureDiff): string {
  if (d.object === 'collection') return TYPE_NAMES[d.collectionType];
  return d.name ? `${OBJECT_NAMES[d.object]} ${d.name}` : OBJECT_NAMES[d.object];
}

/** How many steps the differences take: those applied, those that drop something, those to do by hand. */
export function planSummary(diffs: StructureDiff[]): { steps: number; destructive: number; manual: number } {
  const out = { steps: 0, destructive: 0, manual: 0 };
  for (const d of diffs) for (const s of d.steps) out[!s.op ? 'manual' : s.destructive ? 'destructive' : 'steps']++;
  return out;
}
