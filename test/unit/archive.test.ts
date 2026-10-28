import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { BSON } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveItem, Crc64, TERMINATOR, archivePrelude, bsonFrames, namespaceHeader, readArchive, readArchiveCollections } from '../../src/archive';

const { Long, Decimal128, ObjectId, Int32, Double, Binary, BSONRegExp, Timestamp, EJSON } = BSON;

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoster-archive-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, data: Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
};

async function* chunks(...parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield p;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const crcOf = (...docs: Buffer[]) => {
  const crc = new Crc64();
  for (const d of docs) crc.update(d);
  return crc;
};

describe('Crc64', () => {
  it('computes CRC-64/XZ (the ECMA polynomial of Go’s hash/crc64)', () => {
    const crc = new Crc64();
    crc.update(Buffer.from('123456789'));
    // The standard check value of CRC-64/XZ, as a signed int64.
    expect(crc.value().toString(16)).toBe(Long.fromString('995dc9bbdf1939fa', true, 16).toSigned().toString(16));
  });

  it('is zero for no data and the same when the data comes in pieces', () => {
    expect(new Crc64().value().isZero()).toBe(true);
    const whole = new Crc64();
    whole.update(Buffer.from('hello, archive'));
    const pieces = new Crc64();
    pieces.update(Buffer.from('hello, '));
    pieces.update(Buffer.from('archive'));
    expect(pieces.value().equals(whole.value())).toBe(true);
  });
});

describe('bsonFrames', () => {
  const a = Buffer.from(BSON.serialize({ a: 1 }));
  const b = Buffer.from(BSON.serialize({ b: 'two', nested: { c: [1, 2, 3] } }));

  it('splits documents across chunk boundaries', async () => {
    const all = Buffer.concat([a, b]);
    const frames = await collect(bsonFrames(chunks(all.subarray(0, 3), all.subarray(3, a.length + 2), all.subarray(a.length + 2)), 'x.bson'));
    expect(frames.map((f) => BSON.deserialize(f!))).toEqual([{ a: 1 }, { b: 'two', nested: { c: [1, 2, 3] } }]);
  });

  it('gives null for terminators only when asked to', async () => {
    const frames = await collect(bsonFrames(chunks(Buffer.concat([a, TERMINATOR, b])), 'x', true));
    expect(frames.map((f) => (f ? BSON.deserialize(f) : null))).toEqual([{ a: 1 }, null, { b: 'two', nested: { c: [1, 2, 3] } }]);
    await expect(collect(bsonFrames(chunks(Buffer.concat([a, TERMINATOR])), 'x.bson'))).rejects.toThrow(/x\.bson is not a BSON file \(invalid document at byte 12\)/);
  });

  it('rejects a truncated last document', async () => {
    await expect(collect(bsonFrames(chunks(Buffer.concat([a, b.subarray(0, b.length - 1)])), 'x.bson'))).rejects.toThrow(/truncated/);
  });
});

/** An archive of `collections`, written the way backup.ts writes it (each collection: its block, then its EOF header). */
function archive(collections: { db: string; coll: string; docs: Buffer[]; metadata?: object; type?: string }[], blocks?: Buffer[]): Buffer {
  const prelude = archivePrelude(
    '8.0.0',
    collections.map((c) => ({ database: c.db, collection: c.coll, metadata: c.metadata ?? { indexes: [] }, type: c.type ?? 'collection' })),
  );
  const body =
    blocks ??
    collections.map((c) =>
      Buffer.concat([
        ...(c.docs.length ? [namespaceHeader(c.db, c.coll), ...c.docs, TERMINATOR] : []),
        namespaceHeader(c.db, c.coll, crcOf(...c.docs)),
        TERMINATOR,
      ]),
    );
  return Buffer.concat([prelude, ...body]);
}

describe('archive write → read', () => {
  // Values whose type a backup must keep: they decode to the same types with promoteValues: false.
  const docs = [
    { _id: new ObjectId('64b7f0c2a1b2c3d4e5f60718'), long: Long.fromString('9223372036854775807'), dec: Decimal128.fromString('0.1') },
    { _id: 2, int: new Int32(7), dbl: new Double(7), when: new Date('2024-02-29T12:00:00.123Z'), re: new BSONRegExp('^a/b', 'i') },
    { _id: 3, bin: new Binary(Buffer.from([0, 1, 2, 255]), 0), ts: new Timestamp({ t: 1700000000, i: 3 }), nested: { arr: [1, 'x', null] } },
  ].map((d) => Buffer.from(BSON.serialize(d)));
  const metadata = { options: { validationLevel: 'moderate' }, indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, { v: 2, key: { long: -1 }, name: 'long_-1' }], collectionName: 'things', type: 'collection' };

  it('reads back the collections of the prelude with their metadata', async () => {
    const p = file('meta.archive', archive([
      { db: 'shop', coll: 'things', docs, metadata },
      { db: 'shop', coll: 'byName', docs: [], type: 'view', metadata: { options: { viewOn: 'things', pipeline: [{ $match: { long: { $gt: Long.fromNumber(1) } } }] } } },
    ]));
    const collections = await readArchiveCollections(p);
    expect(collections.map((c) => [c.database, c.collection, c.type])).toEqual([
      ['shop', 'things', 'collection'],
      ['shop', 'byName', 'view'],
    ]);
    // The metadata is canonical EJSON: an int64 in it stays an int64.
    expect(EJSON.stringify(collections[0].metadata, { relaxed: false })).toBe(EJSON.stringify(metadata, { relaxed: false }));
    const match = (collections[1].metadata.options as { pipeline: { $match: { long: { $gt: unknown } } }[] }).pipeline[0].$match.long.$gt;
    expect(match).toBeInstanceOf(Long);
  });

  it('gives back every document byte for byte, then the end of each collection', async () => {
    const other = [Buffer.from(BSON.serialize({ _id: 'only' }))];
    const p = file('docs.archive', archive([
      { db: 'shop', coll: 'things', docs, metadata },
      { db: 'logs', coll: 'events.2024', docs: other },
      { db: 'shop', coll: 'empty', docs: [] },
    ]));
    const items = await collect(readArchive(p));
    expect(items.map((i) => [i.database, i.collection, i.data ? 'doc' : 'end'])).toEqual([
      ['shop', 'things', 'doc'],
      ['shop', 'things', 'doc'],
      ['shop', 'things', 'doc'],
      ['shop', 'things', 'end'],
      ['logs', 'events.2024', 'doc'],
      ['logs', 'events.2024', 'end'],
      ['shop', 'empty', 'end'],
    ]);
    const data = items.filter((i) => i.data).map((i) => i.data!);
    expect(data.map((d) => d.equals(docs[0]) || d.equals(docs[1]) || d.equals(docs[2]) || d.equals(other[0]))).toEqual([true, true, true, true]);
    const decoded = BSON.deserialize(data[0], { promoteValues: false, bsonRegExp: true });
    expect(decoded.long).toBeInstanceOf(Long);
    expect(decoded.dec).toBeInstanceOf(Decimal128);
    expect(BSON.deserialize(data[1], { promoteValues: false, bsonRegExp: true }).int).toBeInstanceOf(Int32);
  });

  it('reads a gzipped archive (.agz) the same way and counts the bytes read from the file', async () => {
    const plain = archive([{ db: 'shop', coll: 'things', docs, metadata }]);
    const gz = zlib.gzipSync(plain);
    const p = file('docs.agz', gz);
    let bytes = 0;
    const items = await collect(readArchive(p, (n) => (bytes += n)));
    expect(items.filter((i) => i.data).map((i) => i.data!.toString('hex'))).toEqual(docs.map((d) => d.toString('hex')));
    expect(bytes).toBe(gz.length);
    expect((await readArchiveCollections(p)).map((c) => c.collection)).toEqual(['things']);
  });

  it('accepts blocks of different collections that alternate, each checksummed over all its blocks', async () => {
    const x = docs.slice(0, 2);
    const y = [Buffer.from(BSON.serialize({ _id: 'y' }))];
    const z = docs.slice(2);
    const blocks = [
      namespaceHeader('d', 'a'), ...x, TERMINATOR,
      namespaceHeader('d', 'b'), ...y, TERMINATOR,
      namespaceHeader('d', 'a'), ...z, TERMINATOR,
      namespaceHeader('d', 'b', crcOf(...y)), TERMINATOR,
      namespaceHeader('d', 'a', crcOf(...x, ...z)), TERMINATOR,
    ];
    const p = file('alternate.archive', archive([{ db: 'd', coll: 'a', docs: [] }, { db: 'd', coll: 'b', docs: [] }], blocks));
    const items: ArchiveItem[] = await collect(readArchive(p));
    expect(items.map((i) => `${i.collection}${i.data ? '' : ' end'}`)).toEqual(['a', 'a', 'b', 'a', 'b end', 'a end']);
  });
});

describe('damaged archives', () => {
  const docs = [Buffer.from(BSON.serialize({ _id: 1 })), Buffer.from(BSON.serialize({ _id: 2 }))];

  it('refuses a collection whose checksum does not match its documents', async () => {
    const blocks = [namespaceHeader('d', 'c'), ...docs, TERMINATOR, namespaceHeader('d', 'c', crcOf(docs[0])), TERMINATOR];
    const p = file('damaged.archive', archive([{ db: 'd', coll: 'c', docs: [] }], blocks));
    await expect(collect(readArchive(p))).rejects.toThrow("damaged.archive is damaged: the checksum of d.c doesn't match its documents.");
  });

  it('refuses a file that is not an archive, gzipped or not', async () => {
    const bson = file('plain.bson', Buffer.concat(docs));
    await expect(readArchiveCollections(bson)).rejects.toThrow(/plain\.bson is not a mongodump archive/);
    const gz = file('plain.bson.gz', zlib.gzipSync(Buffer.concat(docs)));
    await expect(collect(readArchive(gz))).rejects.toThrow(/plain\.bson\.gz is not a mongodump archive/);
    await expect(readArchiveCollections(file('tiny', Buffer.from([0x6d, 0xe2])))).rejects.toThrow(/not a mongodump archive/);
  });

  it('reports where an archive is truncated', async () => {
    const whole = archive([{ db: 'd', coll: 'c', docs }]);
    const prelude = archivePrelude('8.0.0', [{ database: 'd', collection: 'c', metadata: { indexes: [] }, type: 'collection' }]);
    // In the prelude, before its terminator.
    await expect(readArchiveCollections(file('cut1.archive', prelude.subarray(0, prelude.length - 4)))).rejects.toThrow(/truncated: it ends in its list of collections/);
    // After a whole document of a block, before the block's terminator.
    const cut = prelude.length + namespaceHeader('d', 'c').length + docs[0].length;
    await expect(collect(readArchive(file('cut2.archive', whole.subarray(0, cut))))).rejects.toThrow(/truncated: d\.c is incomplete/);
    // In the middle of a document.
    await expect(collect(readArchive(file('cut3.archive', whole.subarray(0, cut - 2))))).rejects.toThrow(/truncated: its last document is incomplete/);
  });
});
