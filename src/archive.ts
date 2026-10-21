// mongodump's archive format (`mongodump --archive [--gzip]`, usually .archive / .agz): a single file with
// a magic number, a prelude (a header, then the metadata of every collection, then a terminator) and the
// documents in blocks: a namespace header, its documents, a terminator. Blocks of different collections
// may alternate; each collection ends with an EOF header carrying the CRC-64 of its documents. With
// --gzip the whole file is gzipped. https://github.com/mongodb/mongo-tools/tree/master/common/archive
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BSON, Document } from 'mongodb';

const { EJSON, Long } = BSON;
const MAGIC = 0x8199e26d;
export const TERMINATOR = Buffer.from([0xff, 0xff, 0xff, 0xff]);
/** Above the 16 MB document limit, with room: a larger size means the file isn't BSON. */
const MAX_DOCUMENT = 48 * 1024 * 1024;

// CRC-64 with the ECMA polynomial, as Go's hash/crc64 computes it (CRC-64/XZ), in two 32-bit halves.
const CRC_LO = new Uint32Array(256);
const CRC_HI = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let lo = n;
  let hi = 0;
  for (let k = 0; k < 8; k++) {
    const odd = lo & 1;
    lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
    hi >>>= 1;
    if (odd) {
      lo = (lo ^ 0xd7870f42) >>> 0;
      hi = (hi ^ 0xc96c5795) >>> 0;
    }
  }
  CRC_LO[n] = lo;
  CRC_HI[n] = hi;
}

export class Crc64 {
  // Kept inverted, as Go does between updates.
  private lo = 0xffffffff;
  private hi = 0xffffffff;

  update(data: Uint8Array): void {
    let { lo, hi } = this;
    for (let i = 0; i < data.length; i++) {
      const t = (lo ^ data[i]) & 0xff;
      lo = ((lo >>> 8) | (hi << 24)) ^ CRC_LO[t];
      hi = (hi >>> 8) ^ CRC_HI[t];
    }
    this.lo = lo >>> 0;
    this.hi = hi >>> 0;
  }

  /** The checksum, as the int64 of the archive. */
  value(): BSON.Long {
    return Long.fromBits(~this.lo, ~this.hi);
  }
}

/** The start of an archive, up to the end of its prelude. */
export function archivePrelude(serverVersion: string, collections: { database: string; collection: string; metadata: Document; type: string }[]): Buffer {
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(MAGIC);
  const header = { concurrent_collections: 1, version: '0.1', server_version: serverVersion, tool_version: 'Mongoster' };
  return Buffer.concat([
    magic,
    BSON.serialize(header),
    ...collections.map((c) =>
      BSON.serialize({ db: c.database, collection: c.collection, metadata: EJSON.stringify(c.metadata, { relaxed: false }), size: 0, type: c.type }),
    ),
    TERMINATOR,
  ]);
}

/** The header of a block of documents, or with a checksum the EOF header that ends a collection. */
export function namespaceHeader(database: string, collection: string, crc?: Crc64): Buffer {
  return Buffer.from(BSON.serialize({ db: database, collection, EOF: !!crc, CRC: crc?.value() ?? Long.ZERO }));
}

/** The BSON documents of a stream, one raw buffer each; with `terminators`, null for each archive terminator. */
export async function* bsonFrames(stream: AsyncIterable<Buffer>, name: string, terminators = false): AsyncGenerator<Buffer | null> {
  let pending: Buffer = Buffer.alloc(0);
  let offset = 0;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const size = pending.readInt32LE(0);
      if (terminators && size === -1) {
        yield null;
        pending = pending.subarray(4);
        offset += 4;
        continue;
      }
      if (size < 5 || size > MAX_DOCUMENT) {
        throw new Error(`${name} is not ${terminators ? 'a mongodump archive' : 'a BSON file'} (invalid document at byte ${offset.toLocaleString('en-US')}).`);
      }
      if (pending.length < size) break;
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
      offset += size;
    }
  }
  if (pending.length) throw new Error(`${name} is truncated: its last document is incomplete.`);
}

export interface ArchiveCollection {
  database: string;
  collection: string;
  metadata: Document;
  type: string;
}

/** A document of a collection, or (without data) the end of the collection. */
export interface ArchiveItem {
  database: string;
  collection: string;
  data?: Buffer;
}

const notArchive = (name: string) => new Error(`${name} is not a mongodump archive (mongodump --archive, with or without --gzip).`);

/** The archive's bytes after the magic number, gunzipped if it's gzipped. */
async function* archiveBytes(file: string, onBytes: (n: number) => void, input: fs.ReadStream): AsyncGenerator<Buffer> {
  const head = Buffer.alloc(2);
  const fd = await fs.promises.open(file, 'r');
  try {
    await fd.read(head, 0, 2, 0);
  } finally {
    await fd.close();
  }
  input.on('data', (chunk) => onBytes(chunk.length));
  const stream = head[0] === 0x1f && head[1] === 0x8b ? input.pipe(zlib.createGunzip()) : input;
  let start: Buffer | undefined = Buffer.alloc(0);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (!start) {
      yield chunk;
      continue;
    }
    start = Buffer.concat([start, chunk]);
    if (start.length < 4) continue;
    if (start.readUInt32LE(0) !== MAGIC) throw notArchive(path.basename(file));
    if (start.length > 4) yield start.subarray(4);
    start = undefined;
  }
  if (start) throw notArchive(path.basename(file));
}

/** The prelude, then the documents and the ends of the collections; checks each collection's checksum. */
async function* parseArchive(file: string, onBytes: (n: number) => void): AsyncGenerator<ArchiveCollection[] | ArchiveItem> {
  const name = path.basename(file);
  const input = fs.createReadStream(file);
  try {
    const frames = bsonFrames(archiveBytes(file, onBytes, input), name, true);
    const header = (await frames.next()).value;
    if (!header) throw notArchive(name);
    const collections: ArchiveCollection[] = [];
    for (;;) {
      const { value, done } = await frames.next();
      if (done) throw new Error(`${name} is truncated: it ends in its list of collections.`);
      if (!value) break;
      const c = BSON.deserialize(value);
      const text = typeof c.metadata === 'string' ? c.metadata : '';
      collections.push({
        database: String(c.db ?? ''),
        collection: String(c.collection ?? ''),
        metadata: text ? (EJSON.parse(text, { relaxed: false }) as Document) : {},
        type: typeof c.type === 'string' && c.type ? c.type : 'collection',
      });
    }
    yield collections;

    let current: { database: string; collection: string; crc: Crc64 } | undefined;
    const crcs = new Map<string, Crc64>();
    for await (const frame of frames) {
      if (!frame) {
        current = undefined;
        continue;
      }
      if (current) {
        current.crc.update(frame);
        yield { database: current.database, collection: current.collection, data: frame };
        continue;
      }
      const h = BSON.deserialize(frame, { promoteLongs: false });
      const database = String(h.db ?? '');
      const collection = String(h.collection ?? '');
      const ns = `${database}.${collection}`;
      const crc = crcs.get(ns) ?? new Crc64();
      crcs.set(ns, crc);
      if (!h.EOF) {
        current = { database, collection, crc };
        continue;
      }
      if (h.CRC !== undefined && !crc.value().equals(Long.fromValue(h.CRC))) throw new Error(`${name} is damaged: the checksum of ${ns} doesn't match its documents.`);
      yield { database, collection };
    }
    if (current) throw new Error(`${name} is truncated: ${current.database}.${current.collection} is incomplete.`);
  } finally {
    input.destroy();
  }
}

/** The collections of an archive, from its prelude (the rest isn't read). */
export async function readArchiveCollections(file: string): Promise<ArchiveCollection[]> {
  const parser = parseArchive(file, () => undefined);
  try {
    const { value } = await parser.next();
    return Array.isArray(value) ? value : [];
  } finally {
    await parser.return(undefined);
  }
}

/** The documents of an archive, and the end of each collection; `onBytes` follows the bytes read from the file. */
export async function* readArchive(file: string, onBytes: (n: number) => void = () => undefined): AsyncGenerator<ArchiveItem> {
  for await (const item of parseArchive(file, onBytes)) if (!Array.isArray(item)) yield item;
}
