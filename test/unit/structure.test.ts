import { describe, expect, it } from 'vitest';
import {
  CollectionShape,
  DatabaseShape,
  StructureDiff,
  StructureOp,
  diffStructure,
  diffTitle,
  indexShape,
  normalizeOptions,
  opCommand,
  optionSteps,
  orderForScript,
  planSummary,
  stepLines,
  structureScript,
} from '../../src/shared/structure';

const db = (collections: CollectionShape[], more: Partial<DatabaseShape> = {}): DatabaseShape => ({ collections, search: 'unsupported', sharded: false, ...more });
const coll = (name: string, more: Partial<CollectionShape> = {}): CollectionShape => ({ name, type: 'collection', options: {}, indexes: [], ...more });
const view = (name: string, viewOn: string, pipeline: unknown[] = [], more: Partial<CollectionShape> = {}): CollectionShape => ({
  name,
  type: 'view',
  options: { viewOn, pipeline },
  indexes: [],
  ...more,
});
const ix = (name: string, keys: Record<string, unknown>, options: Record<string, unknown> = {}) => ({ name, keys, options });
const ops = (d: StructureDiff | undefined) => d?.steps.map((s) => s.op);
const find = (diffs: StructureDiff[], object: string, name?: string, kind?: string) =>
  diffs.find((d) => d.object === object && (name === undefined || d.name === name) && (kind === undefined || d.kind === kind));
const SCRIPT = { database: 'shop', left: 'dev › shop', right: 'prod › shop', drops: false };

describe('normalizeOptions', () => {
  it('keeps the options that matter, without the defaults', () => {
    expect(
      normalizeOptions('collection', {
        validator: {},
        validationLevel: 'strict',
        validationAction: 'error',
        capped: false,
        size: 0,
        changeStreamPreAndPostImages: { enabled: false },
        uuid: 'x',
        storageEngine: { wiredTiger: {} },
      }),
    ).toEqual({});
    expect(
      normalizeOptions('collection', {
        validator: { $jsonSchema: { required: ['a'] } },
        validationLevel: 'moderate',
        validationAction: 'warn',
        capped: true,
        size: 4096,
        max: 0,
        collation: { locale: 'fr', strength: 2, version: '57.1' },
        changeStreamPreAndPostImages: { enabled: true },
      }),
    ).toEqual({
      validator: { $jsonSchema: { required: ['a'] } },
      validationLevel: 'moderate',
      validationAction: 'warn',
      capped: true,
      size: 4096,
      collation: { locale: 'fr', strength: 2 },
      changeStreamPreAndPostImages: { enabled: true },
    });
  });

  it('drops what the server adds to clustered and time series collections', () => {
    expect(normalizeOptions('collection', { clusteredIndex: { v: 2, key: { _id: 1 }, name: '_id_', unique: true }, expireAfterSeconds: 60 })).toEqual({
      clusteredIndex: { key: { _id: 1 }, unique: true },
      expireAfterSeconds: 60,
    });
    expect(normalizeOptions('timeseries', { timeseries: { timeField: 't', metaField: 'm', granularity: 'seconds', bucketMaxSpanSeconds: 3600 } })).toEqual({
      timeseries: { timeField: 't', metaField: 'm', granularity: 'seconds' },
    });
    // Custom bucketing has no granularity: kept.
    expect(normalizeOptions('timeseries', { timeseries: { timeField: 't', bucketMaxSpanSeconds: 600, bucketRoundingSeconds: 600 } })).toEqual({
      timeseries: { timeField: 't', bucketMaxSpanSeconds: 600, bucketRoundingSeconds: 600 },
    });
  });

  it('keeps the definition of a view', () => {
    expect(normalizeOptions('view', { viewOn: 'orders', pipeline: [{ $match: { a: 1 } }], validator: { a: 1 } })).toEqual({ viewOn: 'orders', pipeline: [{ $match: { a: 1 } }] });
    expect(normalizeOptions('view', { viewOn: 'orders' })).toEqual({ viewOn: 'orders', pipeline: [] });
  });
});

describe('indexShape', () => {
  it('leaves out _id_ and what listIndexes adds', () => {
    expect(indexShape({ v: 2, key: { _id: 1 }, name: '_id_' })).toBeUndefined();
    expect(indexShape({ v: 2, key: { a: 1, b: -1 }, name: 'a_1_b_-1', ns: 'x.y', background: true, unique: true, sparse: false })).toEqual({
      name: 'a_1_b_-1',
      keys: { a: 1, b: -1 },
      options: { unique: true },
    });
  });

  it('puts the fields of a text index back in its keys', () => {
    expect(
      indexShape({
        v: 2,
        key: { _fts: 'text', _ftsx: 1 },
        name: 'title_text_body_text',
        weights: { body: 1, title: 3 },
        default_language: 'english',
        language_override: 'language',
        textIndexVersion: 3,
      }),
    ).toEqual({ name: 'title_text_body_text', keys: { body: 'text', title: 'text' }, options: { weights: { title: 3 } } });
  });

  it('drops the collation version', () => {
    expect(indexShape({ v: 2, key: { a: 1 }, name: 'a_fr', collation: { locale: 'fr', version: '57.1' } })?.options).toEqual({ collation: { locale: 'fr' } });
  });
});

describe('collections on one side only', () => {
  it('creates a collection missing on the right with its options and indexes', () => {
    const left = db([coll('orders', { options: { validator: { a: { $exists: true } } }, indexes: [ix('status_1', { status: 1 }), ix('byDate', { date: -1 }, { expireAfterSeconds: 3600 })] })]);
    const r = diffStructure(left, db([]));
    expect(r.counts).toEqual({ same: 0, different: 0, onlyLeft: 1, onlyRight: 0 });
    const d = r.diffs[0];
    expect(d).toMatchObject({ object: 'collection', kind: 'onlyLeft', collection: 'orders', summary: 'Collection missing on the right, with 2 indexes' });
    expect(ops(d)).toEqual([
      { type: 'createCollection', collection: 'orders', options: { validator: { a: { $exists: true } } } },
      { type: 'createIndex', collection: 'orders', keys: { status: 1 }, options: { name: 'status_1' } },
      { type: 'createIndex', collection: 'orders', keys: { date: -1 }, options: { expireAfterSeconds: 3600, name: 'byDate' } },
    ]);
    expect(d.steps.some((s) => s.destructive)).toBe(false);
  });

  it('drops a collection only on the right, as a destructive step', () => {
    const r = diffStructure(db([]), db([coll('old', { indexes: [ix('a_1', { a: 1 })] })]));
    const d = r.diffs[0];
    expect(d).toMatchObject({ object: 'collection', kind: 'onlyRight', summary: 'Collection only on the right' });
    expect(d.steps).toEqual([{ op: { type: 'drop', collection: 'old' }, destructive: true, note: 'Its documents and indexes are deleted.' }]);
  });

  it('creates a missing view and drops an extra one', () => {
    const r = diffStructure(db([coll('orders'), view('open', 'orders', [{ $match: { open: true } }])]), db([coll('orders'), view('legacy', 'orders')]));
    expect(ops(find(r.diffs, 'view', undefined, 'onlyLeft'))).toEqual([
      { type: 'createCollection', collection: 'open', options: { viewOn: 'orders', pipeline: [{ $match: { open: true } }] } },
    ]);
    expect(find(r.diffs, 'view', undefined, 'onlyLeft')?.summary).toBe('View missing on the right (on orders)');
    expect(find(r.diffs, 'view', undefined, 'onlyRight')?.steps[0]).toMatchObject({ op: { type: 'drop', collection: 'legacy' }, destructive: true });
  });

  it('recreates a collection that is a view on the other side, destructively', () => {
    const r = diffStructure(db([coll('x', { indexes: [ix('a_1', { a: 1 })] })]), db([view('x', 'y')]));
    const d = r.diffs[0];
    expect(d).toMatchObject({ kind: 'different', object: 'collection', summary: 'A collection on the left, a view on the right' });
    expect(ops(d)).toEqual([
      { type: 'drop', collection: 'x' },
      { type: 'createCollection', collection: 'x', options: {} },
      { type: 'createIndex', collection: 'x', keys: { a: 1 }, options: { name: 'a_1' } },
    ]);
    expect(d.steps.every((s) => s.destructive)).toBe(true);
  });
});

describe('indexes', () => {
  const compare = (left: ReturnType<typeof ix>[], right: ReturnType<typeof ix>[]) => diffStructure(db([coll('c', { indexes: left })]), db([coll('c', { indexes: right })])).diffs.filter((d) => d.object === 'index');

  it('reports the same, missing and extra indexes', () => {
    const diffs = compare([ix('a_1', { a: 1 }), ix('b_1', { b: 1 })], [ix('a_1', { a: 1 }), ix('z_1', { z: 1 })]);
    expect(diffs.map((d) => [d.name, d.kind])).toEqual([
      ['a_1', 'same'],
      ['b_1', 'onlyLeft'],
      ['z_1', 'onlyRight'],
    ]);
    expect(ops(find(diffs, 'index', 'b_1'))).toEqual([{ type: 'createIndex', collection: 'c', keys: { b: 1 }, options: { name: 'b_1' } }]);
    expect(find(diffs, 'index', 'z_1')?.steps).toEqual([{ op: { type: 'dropIndex', collection: 'c', name: 'z_1' }, destructive: true }]);
  });

  it('pairs indexes by keys when their names differ', () => {
    const diffs = compare([ix('byStatus', { status: 1 })], [ix('status_1', { status: 1 })]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'different', name: 'byStatus', summary: 'Same keys { status: 1 }, named status_1 on the right' });
    expect(ops(diffs[0])).toEqual([
      { type: 'dropIndex', collection: 'c', name: 'status_1' },
      { type: 'createIndex', collection: 'c', keys: { status: 1 }, options: { name: 'byStatus' } },
    ]);
    expect(diffs[0].steps.every((s) => s.destructive)).toBe(true);
    expect(diffs[0].fields).toEqual([{ path: 'name', left: 'byStatus', right: 'status_1' }]);
  });

  it('reports the same name with different keys', () => {
    const diffs = compare([ix('main', { a: 1, b: 1 })], [ix('main', { b: 1, a: 1 })]);
    expect(diffs[0]).toMatchObject({ kind: 'different', summary: 'Same name, different keys: { a: 1, b: 1 } on the left, { b: 1, a: 1 } on the right' });
    expect(ops(diffs[0])?.map((o) => o?.type)).toEqual(['dropIndex', 'createIndex']);
  });

  it('changes hidden and TTL in place, and rebuilds for the other options', () => {
    const hidden = compare([ix('a_1', { a: 1 }, { hidden: true, expireAfterSeconds: 60 })], [ix('a_1', { a: 1 }, { expireAfterSeconds: 30 })]);
    expect(hidden[0]).toMatchObject({ kind: 'different', summary: 'Different hidden, expireAfterSeconds' });
    expect(hidden[0].steps).toEqual([{ op: { type: 'collMod', collection: 'c', changes: { index: { name: 'a_1', hidden: true, expireAfterSeconds: 60 } } } }]);

    const unique = compare([ix('a_1', { a: 1 }, { unique: true })], [ix('a_1', { a: 1 })]);
    expect(unique[0]).toMatchObject({ kind: 'different', summary: 'Different unique' });
    expect(unique[0].fields).toEqual([{ path: 'unique', left: true }]);
    expect(unique[0].steps.map((s) => [s.op?.type, s.destructive])).toEqual([
      ['dropIndex', true],
      ['createIndex', true],
    ]);
  });

  it('tells apart indexes with the same keys and another collation or partial filter', () => {
    const diffs = compare([ix('a_fr', { a: 1 }, { collation: { locale: 'fr' } }), ix('a_1', { a: 1 })], [ix('a_1', { a: 1 }), ix('a_part', { a: 1 }, { partialFilterExpression: { b: { $gt: 1 } } })]);
    expect(diffs.map((d) => [d.name, d.kind])).toEqual([
      ['a_1', 'same'],
      ['a_fr', 'onlyLeft'],
      ['a_part', 'onlyRight'],
    ]);
  });

  it("doesn't compare the indexes of views", () => {
    const r = diffStructure(db([view('v', 'c')]), db([view('v', 'c')]));
    expect(r.diffs.map((d) => [d.object, d.kind])).toEqual([['view', 'same']]);
  });
});

describe('collection options', () => {
  it('changes the validation rules with collMod, back to the defaults when the left has none', () => {
    const steps = optionSteps('c', 'collection', { validator: { a: 1 } }, { validator: { b: 1 }, validationLevel: 'moderate', validationAction: 'warn' });
    expect(steps).toEqual([{ op: { type: 'collMod', collection: 'c', changes: { validator: { a: 1 }, validationLevel: 'strict', validationAction: 'error' } } }]);
    expect(optionSteps('c', 'collection', {}, { validator: { b: 1 } })).toEqual([{ op: { type: 'collMod', collection: 'c', changes: { validator: {} } } }]);
  });

  it('reports the options that differ, field by field', () => {
    const r = diffStructure(db([coll('c', { options: { validator: { a: 1 }, changeStreamPreAndPostImages: { enabled: true } } })]), db([coll('c')]));
    const d = find(r.diffs, 'options');
    expect(d).toMatchObject({ kind: 'different', summary: 'Different validator, changeStreamPreAndPostImages' });
    expect(d?.fields).toEqual([
      { path: 'validator', left: { a: 1 } },
      { path: 'changeStreamPreAndPostImages', left: { enabled: true } },
    ]);
    expect(ops(d)).toEqual([{ type: 'collMod', collection: 'c', changes: { validator: { a: 1 }, changeStreamPreAndPostImages: { enabled: true } } }]);
  });

  it('says the same options', () => {
    const r = diffStructure(db([coll('c', { options: { validator: { a: 1 } } })]), db([coll('c', { options: { validator: { a: 1 } } })]));
    expect(r.diffs).toEqual([expect.objectContaining({ object: 'options', kind: 'same', summary: 'Same options: validator', steps: [] })]);
    expect(r.counts).toEqual({ same: 1, different: 0, onlyLeft: 0, onlyRight: 0 });
  });

  it('resizes capped collections, converts to capped, and says what needs recreating', () => {
    expect(optionSteps('c', 'collection', { capped: true, size: 8192, max: 10 }, { capped: true, size: 4096 })).toEqual([
      { op: { type: 'collMod', collection: 'c', changes: { cappedSize: 8192, cappedMax: 10 } } },
    ]);
    const convert = optionSteps('c', 'collection', { capped: true, size: 8192 }, {});
    expect(convert).toEqual([{ op: { type: 'convertToCapped', collection: 'c', size: 8192 }, destructive: true, note: expect.stringContaining('oldest documents') }]);
    expect(optionSteps('c', 'collection', {}, { capped: true, size: 1 })).toEqual([{ op: null, note: expect.stringContaining("can't be made uncapped") }]);
    expect(optionSteps('c', 'collection', { collation: { locale: 'fr' } }, {})).toEqual([{ op: null, note: expect.stringContaining('collation') }]);
    expect(optionSteps('c', 'collection', { clusteredIndex: { key: { _id: 1 }, unique: true } }, {})).toEqual([{ op: null, note: expect.stringContaining('clustered') }]);
  });

  it('changes the granularity and the expiry of a time series, nothing else', () => {
    expect(optionSteps('t', 'timeseries', { timeseries: { timeField: 't', granularity: 'hours' }, expireAfterSeconds: 60 }, { timeseries: { timeField: 't', granularity: 'seconds' } })).toEqual([
      { op: { type: 'collMod', collection: 't', changes: { expireAfterSeconds: 60, timeseries: { granularity: 'hours' } } } },
    ]);
    expect(optionSteps('t', 'timeseries', { timeseries: { timeField: 't' } }, { timeseries: { timeField: 'time' }, expireAfterSeconds: 60 })).toEqual([
      { op: { type: 'collMod', collection: 't', changes: { expireAfterSeconds: 'off' } } },
      { op: null, note: expect.stringContaining('time series') },
    ]);
  });

  it("changes a view's definition with collMod, and recreates it for another collation", () => {
    expect(optionSteps('v', 'view', { viewOn: 'a', pipeline: [{ $limit: 1 }] }, { viewOn: 'b', pipeline: [] })).toEqual([
      { op: { type: 'collMod', collection: 'v', changes: { viewOn: 'a', pipeline: [{ $limit: 1 }] } } },
    ]);
    const steps = optionSteps('v', 'view', { viewOn: 'a', pipeline: [], collation: { locale: 'fr' } }, { viewOn: 'a', pipeline: [] });
    expect(steps.map((s) => s.op)).toEqual([
      { type: 'drop', collection: 'v' },
      { type: 'createCollection', collection: 'v', options: { viewOn: 'a', pipeline: [], collation: { locale: 'fr' } } },
    ]);
    expect(steps.some((s) => s.destructive)).toBe(false);
  });
});

describe('search indexes', () => {
  const search = (name: string, definition: Record<string, unknown>, type = 'search') => ({ name, type, definition });

  it('compares them when both servers have search', () => {
    const left = db([coll('c', { searchIndexes: [search('default', { mappings: { dynamic: true } }), search('vec', { fields: [] }, 'vectorSearch'), search('kind', { mappings: { dynamic: false } })] })], { search: 'ok' });
    const right = db([coll('c', { searchIndexes: [search('default', { mappings: { dynamic: false } }), search('kind', { fields: [] }, 'vectorSearch'), search('old', { mappings: { dynamic: true } })] })], { search: 'ok' });
    const diffs = diffStructure(left, right).diffs.filter((d) => d.object === 'searchIndex');
    expect(diffs.map((d) => [d.name, d.kind, d.summary])).toEqual([
      ['default', 'different', 'Different definition'],
      ['vec', 'onlyLeft', 'Missing on the right (vectorSearch)'],
      ['kind', 'different', 'search on the left, vectorSearch on the right'],
      ['old', 'onlyRight', 'Only on the right (search)'],
    ]);
    expect(ops(diffs[0])).toEqual([{ type: 'updateSearchIndex', collection: 'c', name: 'default', definition: { mappings: { dynamic: true } } }]);
    expect(ops(diffs[1])).toEqual([{ type: 'createSearchIndex', collection: 'c', name: 'vec', searchType: 'vectorSearch', definition: { fields: [] } }]);
    expect(diffs[2].steps.map((s) => [s.op?.type, s.destructive])).toEqual([
      ['dropSearchIndex', true],
      ['createSearchIndex', true],
    ]);
    expect(diffs[3].steps).toEqual([{ op: { type: 'dropSearchIndex', collection: 'c', name: 'old' }, destructive: true }]);
  });

  it('creates the search indexes of a missing collection', () => {
    const left = db([coll('c', { searchIndexes: [search('default', { mappings: { dynamic: true } })] })], { search: 'ok' });
    const d = diffStructure(left, db([], { search: 'ok' })).diffs[0];
    expect(ops(d)?.map((o) => o?.type)).toEqual(['createCollection', 'createSearchIndex']);
  });

  it("doesn't compare them when a server has no search, and says so when the other has some", () => {
    const left = db([coll('c', { searchIndexes: [search('default', { mappings: { dynamic: true } })] })], { search: 'ok' });
    const r = diffStructure(left, db([coll('c')]));
    expect(r.diffs.some((d) => d.object === 'searchIndex')).toBe(false);
    expect(r.notes).toEqual(['Search indexes are not compared: the right server has no search (1 search index on the left).']);
    expect(diffStructure(left, db([]), ).diffs[0].steps.map((s) => s.op?.type)).toEqual(['createCollection']);
    // Neither has search: nothing to say.
    expect(diffStructure(db([coll('c')]), db([coll('c')])).notes).toEqual([]);
    expect(diffStructure(db([coll('c')], { search: 'error', searchError: 'mongot down' }), db([coll('c')])).notes).toEqual([
      'Search indexes are not compared: they could not be read on the left: mongot down',
    ]);
  });
});

describe('shard keys', () => {
  it('compares them between two sharded clusters', () => {
    const left = db([coll('a', { shardKey: { key: { x: 1 } } }), coll('b', { shardKey: { key: { y: 'hashed' } } }), coll('c'), coll('d', { shardKey: { key: { z: 1 }, unique: true } })], { sharded: true });
    const right = db([coll('a', { shardKey: { key: { x: 1 } } }), coll('b', { shardKey: { key: { y: 1 } } }), coll('c', { shardKey: { key: { w: 1 } } })], { sharded: true });
    const r = diffStructure(left, right);
    const keys = r.diffs.filter((d) => d.object === 'shardKey');
    expect(keys.map((d) => [d.collection, d.kind])).toEqual([
      ['a', 'same'],
      ['b', 'different'],
      ['c', 'onlyRight'],
    ]);
    expect(keys[1].steps).toEqual([{ op: null, note: expect.stringContaining('reshardCollection') }]);
    expect(keys[2].steps).toEqual([{ op: null, note: expect.stringContaining('unshardCollection') }]);
    // A missing collection is sharded once created.
    expect(ops(find(r.diffs, 'collection', undefined, 'onlyLeft'))).toEqual([
      { type: 'createCollection', collection: 'd', options: {} },
      { type: 'shardCollection', collection: 'd', key: { z: 1 }, unique: true },
    ]);
  });

  it('shards a collection sharded on the left only', () => {
    const r = diffStructure(db([coll('a', { shardKey: { key: { x: 1 } } })], { sharded: true }), db([coll('a')], { sharded: true }));
    expect(ops(find(r.diffs, 'shardKey'))).toEqual([{ type: 'shardCollection', collection: 'a', key: { x: 1 } }]);
  });

  it("doesn't compare them when only one side is a sharded cluster", () => {
    const r = diffStructure(db([coll('a', { shardKey: { key: { x: 1 } } })], { sharded: true }), db([coll('a')]));
    expect(r.diffs.some((d) => d.object === 'shardKey')).toBe(false);
    expect(r.notes).toEqual(['Shard keys are not compared: only the left is a sharded cluster.']);
  });
});

describe('commands', () => {
  const cmd = (op: StructureOp) => opCommand(op, 'shop');

  it('writes each operation in mongosh syntax', () => {
    expect(cmd({ type: 'createCollection', collection: 'c', options: {} })).toBe('db.createCollection("c")');
    expect(cmd({ type: 'createCollection', collection: 'c', options: { capped: true, size: 4096 } })).toBe('db.createCollection("c", { capped: true, size: 4096 })');
    expect(cmd({ type: 'createCollection', collection: 'v', options: { viewOn: 'c', pipeline: [{ $match: { a: 1 } }], collation: { locale: 'fr' } } })).toBe(
      'db.createView("v", "c", [{ $match: { a: 1 } }], { collation: { locale: "fr" } })',
    );
    expect(cmd({ type: 'collMod', collection: 'c', changes: { validationLevel: 'strict' } })).toBe('db.runCommand({ collMod: "c", validationLevel: "strict" })');
    expect(cmd({ type: 'convertToCapped', collection: 'c', size: 10 })).toBe('db.runCommand({ convertToCapped: "c", size: 10 })');
    expect(cmd({ type: 'drop', collection: 'c' })).toBe('db.getCollection("c").drop()');
    expect(cmd({ type: 'createIndex', collection: 'c', keys: { a: 1 }, options: { name: 'a_1' } })).toBe('db.getCollection("c").createIndex({ a: 1 })');
    expect(cmd({ type: 'createIndex', collection: 'c', keys: { a: 1 }, options: { name: 'mine', unique: true } })).toBe('db.getCollection("c").createIndex({ a: 1 }, { name: "mine", unique: true })');
    expect(cmd({ type: 'dropIndex', collection: 'c', name: 'a_1' })).toBe('db.getCollection("c").dropIndex("a_1")');
    expect(cmd({ type: 'createSearchIndex', collection: 'c', name: 'default', searchType: 'search', definition: { mappings: { dynamic: true } } })).toBe(
      'db.getCollection("c").createSearchIndex("default", { mappings: { dynamic: true } })',
    );
    expect(cmd({ type: 'createSearchIndex', collection: 'c', name: 'v', searchType: 'vectorSearch', definition: { fields: [] } })).toBe('db.getCollection("c").createSearchIndex("v", "vectorSearch", { fields: [] })');
    expect(cmd({ type: 'updateSearchIndex', collection: 'c', name: 'default', definition: { mappings: { dynamic: false } } })).toBe(
      'db.getCollection("c").updateSearchIndex("default", { mappings: { dynamic: false } })',
    );
    expect(cmd({ type: 'dropSearchIndex', collection: 'c', name: 'default' })).toBe('db.getCollection("c").dropSearchIndex("default")');
    expect(cmd({ type: 'shardCollection', collection: 'c', key: { a: 'hashed' } })).toBe('db.adminCommand({ shardCollection: "shop.c", key: { a: "hashed" } })');
  });

  it('comments out the destructive steps unless asked', () => {
    const steps = [{ op: { type: 'dropIndex', collection: 'c', name: 'a' } as StructureOp, destructive: true, note: 'Rebuilt.' }, { op: null, note: 'By hand.' }];
    expect(stepLines(steps, 'shop', false)).toEqual(['// Rebuilt.', '// DESTRUCTIVE, optional: remove the // to run it.', '// db.getCollection("c").dropIndex("a");', '// By hand.']);
    expect(stepLines(steps, 'shop', true)).toEqual(['// Rebuilt.', '// DESTRUCTIVE', 'db.getCollection("c").dropIndex("a");', '// By hand.']);
  });
});

describe('the script', () => {
  const left = db([
    coll('orders', { indexes: [ix('status_1', { status: 1 })] }),
    view('big', 'recent', [{ $match: { total: { $gt: 100 } } }]),
    view('recent', 'orders', [{ $sort: { date: -1 } }]),
    coll('users'),
  ]);
  const right = db([coll('orders', { indexes: [ix('old_1', { old: 1 })] }), coll('legacy'), coll('users', { options: { validator: { a: 1 } } })]);
  const result = diffStructure(left, right);

  it('orders the steps: collections, then changes, views after what they are on, drops last', () => {
    expect(orderForScript(result.diffs).map((d) => `${d.collection} ${diffTitle(d)} ${d.kind}`)).toEqual([
      'orders index status_1 onlyLeft',
      'users options different',
      'recent view onlyLeft',
      'big view onlyLeft',
      'legacy collection onlyRight',
      'orders index old_1 onlyRight',
    ]);
  });

  it('makes the right like the left, with the drops commented out', () => {
    expect(structureScript(result.diffs, SCRIPT)).toBe(
      [
        '// Makes prod › shop like dev › shop.',
        '// Generated by Mongoster (Compare Structure).',
        '// Steps that drop something are commented out: remove the // in front of them to run them too.',
        '',
        'use("shop");',
        '',
        '// orders: index status_1 – Missing on the right: { status: 1 }',
        'db.getCollection("orders").createIndex({ status: 1 });',
        '',
        '// users: options – Different validator',
        'db.runCommand({ collMod: "users", validator: {} });',
        '',
        '// recent: view – View missing on the right (on orders)',
        'db.createView("recent", "orders", [{ $sort: { date: -1 } }]);',
        '',
        '// big: view – View missing on the right (on recent)',
        'db.createView("big", "recent", [{ $match: { total: { $gt: 100 } } }]);',
        '',
        '// legacy: collection – Collection only on the right',
        '// Its documents and indexes are deleted.',
        '// DESTRUCTIVE, optional: remove the // to run it.',
        '// db.getCollection("legacy").drop();',
        '',
        '// orders: index old_1 – Only on the right: { old: 1 }',
        '// DESTRUCTIVE, optional: remove the // to run it.',
        '// db.getCollection("orders").dropIndex("old_1");',
        '',
      ].join('\n'),
    );
  });

  it('includes the drops when asked', () => {
    const script = structureScript(result.diffs, { ...SCRIPT, drops: true });
    expect(script).toContain('// Steps marked DESTRUCTIVE drop indexes, collections or data');
    expect(script).toContain('// DESTRUCTIVE\ndb.getCollection("legacy").drop();');
  });

  it('says when there is nothing to change', () => {
    const same = diffStructure(db([coll('a')]), db([coll('a')]));
    expect(structureScript(same.diffs, SCRIPT)).toBe('// Makes prod › shop like dev › shop.\n// Generated by Mongoster (Compare Structure).\n\nuse("shop");\n\n// Nothing to change: the structures are the same.\n');
  });

  it('counts the steps by sort', () => {
    expect(planSummary(result.diffs)).toEqual({ steps: 4, destructive: 2, manual: 0 });
    expect(planSummary([{ ...result.diffs[0], steps: [{ op: null, note: 'x' }] }])).toEqual({ steps: 0, destructive: 0, manual: 1 });
  });
});
