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
import { CollectionRestore, archiveOf, scanArchive } from '../../src/backup';

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
