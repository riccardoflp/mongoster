// Backup to a gzipped archive (.agz) and restore from it, with the functions the Backup and Restore
// commands use: the documents must come back byte for byte, with their indexes, options and views.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { BSON, Document, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { readArchive } from '../../src/archive';
import { CollectionRestore, archiveOf, backupCollections, collectionsReplacedByViews, readBson, scanArchive, scanBackup, writeBackup } from '../../src/backup';

const { Long, Decimal128, Int32, Double, Binary, BSONRegExp, Timestamp, ObjectId, UUID, MinKey, MaxKey, Code } = BSON;
const SOURCE = 'mongoster_backup';
const TARGET = 'mongoster_restored';

let client: MongoClient;
/** A collection whose _id can be of any type. */
const coll = (db: string, name: string) => client.db(db).collection<{ _id?: string | number | BSON.ObjectId; [key: string]: unknown }>(name);
let dir: string;
beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoster-backup-'));
  await client.db(SOURCE).dropDatabase();
  await client.db(TARGET).dropDatabase();
});
afterAll(async () => {
  await client?.db(SOURCE).dropDatabase();
  await client?.db(TARGET).dropDatabase();
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const docs: Document[] = [
  {
    _id: new ObjectId('64b7f0c2a1b2c3d4e5f60718'),
    long: Long.fromString('-9223372036854775808'),
    int: new Int32(42),
    double: new Double(42),
    negZero: new Double(-0),
    dec: Decimal128.fromString('1234567890.123456789012345678901234'),
    date: new Date('1969-07-20T20:17:40Z'),
    re: new BSONRegExp('^http://x/[a-z]+$', 'im'),
    bin: new Binary(Buffer.from([0, 255, 1, 254]), 128),
    uuid: new UUID('0123456789abcdef0123456789abcdef'),
    ts: new Timestamp({ t: 1_700_000_000, i: 7 }),
    min: new MinKey(),
    max: new MaxKey(),
    code: new Code('function () { return 1 }'),
    nested: { deep: { arr: [1, 'two', null, [new Int32(3)], { k: true }] } },
    'dotted.key': 1,
    $dollar: 'kept',
  },
  ...Array.from({ length: 1500 }, (_, i) => ({ _id: i, email: `user${i}@example.com`, n: i % 7, at: new Date(1_700_000_000_000 + i) })),
];

/** The raw documents of a collection, sorted by _id: what a backup must keep exactly. */
async function raw(db: string, coll: string): Promise<Buffer[]> {
  const cursor = client.db(db).collection(coll).find({}, { raw: true, sort: { _id: 1 } });
  return (await cursor.toArray()) as unknown as Buffer[];
}

describe('backup to an .agz archive and restore', () => {
  it('restores documents byte for byte, with their indexes, options and views', async () => {
    const src = client.db(SOURCE);
    await src.createCollection('people', { validator: { email: { $type: 'string' } }, validationLevel: 'moderate' });
    // The first document has no email: inserted without validation, as a restore does.
    await src.collection('people').insertMany(docs, { bypassDocumentValidation: true });
    await src.collection('people').createIndexes([
      { key: { email: 1 }, name: 'email_unique', unique: true, partialFilterExpression: { email: { $exists: true } } },
      { key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 3600 * 24 * 365 * 10 },
      { key: { n: 1, at: -1 } },
    ]);
    await src.createCollection('small', { capped: true, size: 1 << 20 });
    await coll(SOURCE, 'small').insertOne({ _id: 'only', v: Long.fromNumber(1) });
    await src.createCollection('empty');
    await src.createCollection('sevens', { viewOn: 'people', pipeline: [{ $match: { n: 0 } }] });

    // Backup, as the Backup command does for a whole database.
    const collections = (await src.listCollections({}, { nameOnly: false }).toArray()).filter((c) => !c.name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name));
    const stats = { collections: 0, documents: 0, bytes: 0, cancelled: false };
    const progress: string[] = [];
    const hooks = (database: string, info: { name: string }) => ({ progress: (n: number) => progress.push(`${database}.${info.name}:${n}`), cancelled: () => false });
    const file = path.join(dir, 'backup.agz');
    await pipeline(archiveOf(client, [{ database: SOURCE, collections: collections as never }], stats, hooks), zlib.createGzip(), fs.createWriteStream(file));
    expect(stats).toMatchObject({ collections: 4, documents: docs.length + 1, cancelled: false });
    expect(progress).toContain(`${SOURCE}.people:${docs.length}`);

    // What the restore dialog lists.
    const scanned = await scanArchive(file);
    expect(scanned.map((d) => [d.name, d.collections.map((c) => `${c.name}:${c.meta?.type}`)])).toEqual([
      [SOURCE, ['empty:collection', 'people:collection', 'sevens:view', 'small:collection']],
    ]);

    // Restore into another database, as the Restore command does with an archive.
    const metas = new Map(scanned[0].collections.map((c) => [c.name, c.meta!]));
    const restores = new Map<string, CollectionRestore>();
    const results: Record<string, Awaited<ReturnType<CollectionRestore['finish']>>> = {};
    for await (const item of readArchive(file)) {
      expect(item.database).toBe(SOURCE);
      let restore = restores.get(item.collection);
      if (!restore) restores.set(item.collection, (restore = await CollectionRestore.open(client.db(TARGET), item.collection, metas.get(item.collection)!, true)));
      if (item.data) await restore.add(item.data);
      else results[item.collection] = await restore.finish(false);
    }
    expect(Object.keys(results).sort()).toEqual(['empty', 'people', 'sevens', 'small']);
    expect(results.people).toMatchObject({ inserted: docs.length, skipped: 0, failed: 0, indexes: 3, indexErrors: [] });

    // The documents, exactly.
    for (const coll of ['people', 'small', 'empty']) {
      const [before, after] = [await raw(SOURCE, coll), await raw(TARGET, coll)];
      expect(after.length).toBe(before.length);
      expect(after.every((d, i) => d.equals(before[i]))).toBe(true);
    }
    const first = await client.db(TARGET).collection('people').findOne({ _id: docs[0]._id }, { promoteValues: false, bsonRegExp: true });
    expect(first!.long).toBeInstanceOf(Long);
    expect(first!.int).toBeInstanceOf(Int32);
    expect(first!.double).toBeInstanceOf(Double);
    expect(first!.dec.toString()).toBe('1234567890.123456789012345678901234');
    expect(first!.re).toEqual(new BSONRegExp('^http://x/[a-z]+$', 'im'));

    // The indexes, options and the view.
    const indexes = (await client.db(TARGET).collection('people').listIndexes().toArray()).map(({ v: _v, ...spec }) => spec);
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email_unique', unique: true, partialFilterExpression: { email: { $exists: true } } }),
      expect.objectContaining({ name: 'at_ttl', expireAfterSeconds: 3600 * 24 * 365 * 10 }),
      expect.objectContaining({ name: 'n_1_at_-1', key: { n: 1, at: -1 } }),
    ]));
    const infos = Object.fromEntries(((await client.db(TARGET).listCollections().toArray()) as Document[]).map((c) => [c.name, c]));
    expect(infos.people.options).toMatchObject({ validator: { email: { $type: 'string' } }, validationLevel: 'moderate' });
    expect(infos.small.options).toMatchObject({ capped: true });
    expect(infos.sevens).toMatchObject({ type: 'view', options: { viewOn: 'people', pipeline: [{ $match: { n: 0 } }] } });
    expect(await client.db(TARGET).collection('sevens').countDocuments()).toBe(docs.filter((d) => d.n === 0).length);
  });

  it('skips documents whose _id already exists when restoring without dropping', async () => {
    await coll(TARGET, 'existing').insertOne({ _id: 'only', v: 1 });
    const restore = await CollectionRestore.open(client.db(TARGET), 'existing', { indexes: [] }, false);
    await restore.add(Buffer.from(BSON.serialize({ _id: 'only', v: 2 })));
    await restore.add(Buffer.from(BSON.serialize({ _id: 'new', v: 3 })));
    expect(await restore.finish(false)).toMatchObject({ inserted: 1, skipped: 1, failed: 0 });
    expect(await coll(TARGET, 'existing').findOne({ _id: 'only' })).toMatchObject({ v: 1 });
  });
});

describe('backup to a folder and restore', () => {
  // Names MongoDB accepts and a path gives a meaning to.
  const NAMES = ['plain', 'a/b', 'a\\b', 'a:b', 'con', '%2e%2e', 'up/../../../escaped', 'with space', `long/${'é'.repeat(100)}`];
  const DB = 'mongoster_backup_names';

  afterAll(async () => {
    await client?.db(DB).dropDatabase();
    await client?.db(`${DB}_restored`).dropDatabase();
  });

  it('keeps every file inside the backup folder, whatever the collections are called, and restores them by name', async () => {
    const src = client.db(DB);
    await src.dropDatabase();
    for (const [i, name] of NAMES.entries()) await src.collection<Document>(name).insertMany([{ _id: 1, name, i } as Document, { _id: 2, name } as Document]);
    await src.collection('plain').createIndex({ name: 1 }, { name: 'by_name' });

    const outer = path.join(dir, 'outer');
    const root = path.join(outer, 'deep', 'deeper', 'root');
    fs.mkdirSync(path.dirname(root), { recursive: true });
    const hooks = () => ({ progress: () => undefined, cancelled: () => false });
    for (const format of ['gzip', 'plain'] as const) {
      fs.rmSync(root, { recursive: true, force: true });
      const stats = await writeBackup(client, [{ database: DB, collections: await backupCollections(client, DB) }], format, root, hooks);
      expect(stats).toMatchObject({ collections: NAMES.length, documents: NAMES.length * 2, cancelled: false });

      // Nothing but the database's folder, with two files per collection directly in it.
      const written = (fs.readdirSync(outer, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(outer, f)).isFile());
      expect(written.length).toBe(NAMES.length * 2);
      for (const f of written) expect(path.dirname(path.join(outer, f))).toBe(path.join(root, DB));

      const scanned = scanBackup(root);
      expect(scanned.map((d) => d.name)).toEqual([DB]);
      expect(scanned[0].collections.map((c) => c.name).sort()).toEqual([...NAMES].sort());

      const target = client.db(`${DB}_restored`);
      await target.dropDatabase();
      for (const files of scanned[0].collections) {
        const meta = BSON.EJSON.parse((files.metadata!.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(files.metadata!)) : fs.readFileSync(files.metadata!)).toString('utf8'), { relaxed: false }) as Document;
        expect(meta.collectionName).toBe(files.name);
        const restore = await CollectionRestore.open(target, files.name, meta, true);
        for await (const data of readBson(files.bson!)) await restore.add(data);
        expect(await restore.finish(false)).toMatchObject({ inserted: 2, failed: 0, indexErrors: [] });
      }
      for (const name of NAMES) {
        const [before, after] = [await raw(DB, name), await raw(`${DB}_restored`, name)];
        expect(after.length).toBe(2);
        expect(after.every((d, i) => d.equals(before[i]))).toBe(true);
      }
      expect((await target.collection('plain').listIndexes().toArray()).map((i) => i.name)).toContain('by_name');
    }
  });
});

describe('restore of a backup that is not trusted', () => {
  const ttl = { key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 1 };
  const other = { key: { n: 1 }, name: 'n_1' };
  const old = { _id: 'old', at: new Date('2000-01-01T00:00:00Z'), n: 1 };

  it("doesn't create a TTL index of the backup on a collection that was already there", async () => {
    await coll(TARGET, 'kept').drop().catch(() => undefined);
    await coll(TARGET, 'kept').insertOne(old);
    const restore = await CollectionRestore.open(client.db(TARGET), 'kept', { indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, ttl, other] }, false);
    await restore.add(Buffer.from(BSON.serialize({ _id: 'new', at: new Date(), n: 2 })));
    const result = await restore.finish(false);
    expect(result).toMatchObject({ inserted: 1, indexes: 1 });
    expect(result.indexErrors).toHaveLength(1);
    expect(result.indexErrors[0]).toMatch(/^kept\.at_ttl: a TTL index \(expireAfterSeconds\) would make the server delete documents that were already in the collection/);
    expect((await coll(TARGET, 'kept').listIndexes().toArray()).map((i) => i.name).sort()).toEqual(['_id_', 'n_1']);
    expect(await coll(TARGET, 'kept').findOne({ _id: 'old' })).not.toBeNull();
  });

  it('says nothing of a TTL index the collection already has', async () => {
    await coll(TARGET, 'has_ttl').drop().catch(() => undefined);
    await coll(TARGET, 'has_ttl').insertOne({ _id: 'x', at: new Date() });
    await coll(TARGET, 'has_ttl').createIndex({ at: 1 }, { name: 'at_ttl', expireAfterSeconds: 3600 * 24 * 365 });
    const restore = await CollectionRestore.open(client.db(TARGET), 'has_ttl', { indexes: [{ ...ttl, expireAfterSeconds: new Int32(3600 * 24 * 365) }] }, false);
    expect(await restore.finish(false)).toMatchObject({ indexes: 1, indexErrors: [] });
    // The same key with another delay is a change to the collection's index: refused like a new one.
    const changed = await CollectionRestore.open(client.db(TARGET), 'has_ttl', { indexes: [ttl] }, false);
    expect((await changed.finish(false)).indexErrors).toHaveLength(1);
    expect((await coll(TARGET, 'has_ttl').listIndexes().toArray()).find((i) => i.name === 'at_ttl')).toMatchObject({ expireAfterSeconds: 3600 * 24 * 365 });
  });

  it('creates the TTL indexes of a collection the restore creates, or drops first', async () => {
    await coll(TARGET, 'fresh').drop().catch(() => undefined);
    const created = await CollectionRestore.open(client.db(TARGET), 'fresh', { indexes: [{ ...ttl, expireAfterSeconds: 3600 * 24 * 365 }] }, false);
    expect(await created.finish(false)).toMatchObject({ indexes: 1, indexErrors: [] });
    const dropped = await CollectionRestore.open(client.db(TARGET), 'fresh', { indexes: [{ ...ttl, expireAfterSeconds: 3600 * 24 * 366 }] }, true);
    expect(await dropped.finish(false)).toMatchObject({ indexes: 1, indexErrors: [] });
    expect((await coll(TARGET, 'fresh').listIndexes().toArray()).find((i) => i.name === 'at_ttl')).toMatchObject({ expireAfterSeconds: 3600 * 24 * 366 });
  });

  it('tells which collections a view of the backup would replace', async () => {
    const db = client.db(TARGET);
    await db.collection('real').drop().catch(() => undefined);
    await db.collection('a_view').drop().catch(() => undefined);
    await coll(TARGET, 'real').insertOne({ _id: 1 });
    await db.createCollection('a_view', { viewOn: 'real', pipeline: [] });
    const views = ['real', 'a_view', 'missing'].map((name) => ({ database: TARGET, name }));
    expect(await collectionsReplacedByViews(client, views)).toEqual([`${TARGET}.real`]);
  });
});
