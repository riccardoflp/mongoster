// The names of a folder backup's files: hostile collection and database names stay inside the backup's
// folder, and what was written is read back, as are the backups written before the names were encoded.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusedDatabase, scanBackup, scanDatabase } from '../../src/backup';
import { backupCollectionName, backupDatabaseName, backupFileName } from '../../src/backupNames';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoster-names-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const LONG = `${'long/'.repeat(60)}end`;
const HOSTILE = ['../x', '../../../etc/passwd', 'a/b', 'a\\b', 'con', 'CON', 'nul.txt', 'com1', 'a:b', '%2e%2e', '..', '.hidden', 'ends.', 'a b', 'a*b?"<>|', 'été', '100%', LONG];

describe('backupFileName', () => {
  it('keeps ordinary names as they are', () => {
    for (const name of ['users', 'order_items', 'logs-2026', 'fs.files', 'Users2']) expect(backupFileName(name)).toBe(name);
  });

  it('encodes what a path or a file system gives a meaning to', () => {
    expect(backupFileName('../x')).toBe('%2E.%2Fx');
    expect(backupFileName('a/b')).toBe('a%2Fb');
    expect(backupFileName('a\\b')).toBe('a%5Cb');
    expect(backupFileName('a:b')).toBe('a%3Ab');
    expect(backupFileName('%2e%2e')).toBe('%252e%252e');
    expect(backupFileName('..')).toBe('%2E%2E');
    expect(backupFileName('.')).toBe('%2E');
    expect(backupFileName('con')).toBe('%63on');
    expect(backupFileName('nul.txt')).toBe('%6Eul.txt');
    expect(backupFileName('console')).toBe('console');
    expect(backupFileName('a b')).toBe('a%20b');
    expect(backupFileName('été')).toBe('%C3%A9t%C3%A9');
  });

  it('gives names that are a single, portable path component', () => {
    for (const name of HOSTILE) {
      const file = backupFileName(name);
      expect(file).toMatch(/^[A-Za-z0-9_%-][A-Za-z0-9_.%-]*$/);
      expect(file.endsWith('.')).toBe(false);
      expect(file).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i);
      expect(Buffer.byteLength(`${file}.metadata.json.gz`)).toBeLessThanOrEqual(255);
      expect(path.dirname(path.join(dir, `${file}.bson`))).toBe(dir);
      expect(path.win32.dirname(path.win32.join('C:\\backup', `${file}.bson`))).toBe('C:\\backup');
    }
  });

  it('gives different names to different collections', () => {
    const names = [...HOSTILE, `${LONG}2`, 'a%2Fb', 'a%20b', '%63on'];
    expect(new Set(names.map(backupFileName)).size).toBe(names.length);
  });

  it('cuts a name that is too long, as mongodump does, never inside an escape', () => {
    const file = backupFileName(LONG);
    expect(file).toMatch(/^(long%2F)+(l|lo|lon|long)?%24[A-Za-z0-9_-]{27}$/);
    expect(file.length).toBeLessThanOrEqual(238);
    expect(backupFileName('x'.repeat(238))).toBe('x'.repeat(238));
    expect(backupFileName('x'.repeat(239))).toMatch(/^x{208}%24[A-Za-z0-9_-]{27}$/);
  });
});

describe('backupCollectionName', () => {
  it('reads back every name that was written, with or without the metadata', () => {
    for (const name of HOSTILE) {
      expect(backupCollectionName(backupFileName(name), name)).toBe(name);
      if (name !== LONG) expect(backupCollectionName(backupFileName(name))).toBe(name);
    }
  });

  it('reads the names of backups written before they were encoded', () => {
    expect(backupCollectionName('users')).toBe('users');
    expect(backupCollectionName('a:b', 'a:b')).toBe('a:b');
    // The file has the collection's own name, which holds a %: the metadata says so.
    expect(backupCollectionName('a%2Fb', 'a%2Fb')).toBe('a%2Fb');
    expect(backupCollectionName('100%', '100%')).toBe('100%');
    expect(backupCollectionName('100%')).toBe('100%');
  });

  it("reads mongodump's names, which encode fewer characters", () => {
    expect(backupCollectionName('a:b%2Fc', 'a:b/c')).toBe('a:b/c');
    expect(backupCollectionName('a%20b')).toBe('a b');
  });

  it('keeps the name of a file whose metadata is of another collection', () => {
    expect(backupCollectionName('copy%20of%20users', 'users')).toBe('copy of users');
  });
});

describe('backupDatabaseName', () => {
  it('decodes only what backupFileName writes', () => {
    expect(backupDatabaseName('shop')).toBe('shop');
    expect(backupDatabaseName(backupFileName('con'))).toBe('con');
    expect(backupDatabaseName(backupFileName('a*b'))).toBe('a*b');
    expect(backupDatabaseName('50%')).toBe('50%');
    expect(backupDatabaseName('a%2fb')).toBe('a%2fb');
  });
});

describe('scanDatabase and scanBackup', () => {
  const write = (folder: string, collection: string, stem: string, gzip = false) => {
    fs.mkdirSync(folder, { recursive: true });
    const meta = Buffer.from(JSON.stringify({ indexes: [], collectionName: collection, type: 'collection' }));
    fs.writeFileSync(path.join(folder, `${stem}.metadata.json${gzip ? '.gz' : ''}`), gzip ? zlib.gzipSync(meta) : meta);
    fs.writeFileSync(path.join(folder, `${stem}.bson${gzip ? '.gz' : ''}`), Buffer.alloc(0));
  };

  it('lists the collections by their names, from encoded and from plain file names', () => {
    const folder = path.join(dir, 'mixed');
    for (const name of ['../x', 'a/b', 'con', LONG]) write(folder, name, backupFileName(name), name === 'a/b');
    // Written before the names were encoded.
    write(folder, 'plain', 'plain');
    write(folder, '100%25', '100%25');
    // Without metadata: decoded.
    fs.writeFileSync(path.join(folder, 'no%20meta.bson'), Buffer.alloc(0));
    const found = scanDatabase(folder);
    expect(found.map((f) => f.name).sort()).toEqual(['../x', '100%25', LONG, 'a/b', 'con', 'no meta', 'plain'].sort());
    for (const f of found) expect(path.dirname(f.bson!)).toBe(folder);
    expect(path.basename(found.find((f) => f.name === 'a/b')!.metadata!)).toBe('a%2Fb.metadata.json.gz');
  });

  it('leaves out system collections, whatever their file is called', () => {
    const folder = path.join(dir, 'system');
    write(folder, 'system.users', 'system.users');
    write(folder, 'system.js', 'system%2Ejs');
    write(folder, 'kept', 'kept');
    expect(scanDatabase(folder).map((f) => f.name)).toEqual(['kept']);
  });

  it('decodes the database folders', () => {
    const root = path.join(dir, 'root');
    write(path.join(root, backupFileName('nul')), 'c', 'c');
    write(path.join(root, 'shop'), 'c', 'c');
    expect(scanBackup(root).map((d) => [d.name, path.basename(d.dir)])).toEqual([
      ['nul', '%6Eul'],
      ['shop', 'shop'],
    ]);
  });
});

describe('refusedDatabase', () => {
  it('refuses the system databases and the names MongoDB refuses', () => {
    expect(refusedDatabase('admin')).toBe('a system database');
    expect(refusedDatabase('config')).toBe('a system database');
    expect(refusedDatabase('local')).toBe('a system database');
    expect(refusedDatabase('Admin')).toBe('a system database');
    expect(refusedDatabase('a.b')).toBe('not a valid database name');
    expect(refusedDatabase('a b')).toBe('not a valid database name');
    expect(refusedDatabase('')).toBe('not a valid database name');
    expect(refusedDatabase('x'.repeat(64))).toBe('not a valid database name');
    expect(refusedDatabase('shop')).toBeUndefined();
    expect(refusedDatabase('administration')).toBeUndefined();
  });
});
