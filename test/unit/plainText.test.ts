import { describe, expect, it } from 'vitest';
import { noCredentials, noLinks } from '../../src/shared/plainText';

/** The links VS Code finds in a notification's message (its `parseLinkedText`). */
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

describe('noLinks', () => {
  it('leaves text without links as it is', () => {
    for (const text of ['', 'E11000 duplicate key error collection: shop.orders index: _id_ dup key: { _id: 1 }', 'a [b] (c)', 'f(x)[0]'])
      expect(noLinks(text)).toBe(text);
  });

  it('breaks every link, whatever it points to', () => {
    const text = 'dup key: { name: "[Fix it](command:workbench.action.terminal.new)" } see [docs](https://evil.example.net/x "title") [a](FILE:///etc/passwd)';
    expect(text.match(LINK)).toHaveLength(3);
    const safe = noLinks(text);
    expect(safe.match(LINK)).toBeNull();
    // Nothing is taken away: only an invisible character is added.
    expect(safe.replace(/​/g, '')).toBe(text);
  });

  it('is the same when applied twice over what VS Code sees', () => {
    const once = noLinks('[a](https://b)');
    expect(noLinks(once)).toBe(once);
  });
});

// RS33: the driver quotes a connection string it cannot read, password and all.
describe('noCredentials', () => {
  it('removes the user and the password of MongoDB and Redis URLs, also where a parser would not find them', () => {
    expect(noCredentials('Invalid connection string "mongodb://ada:s3cret@/db"')).toBe('Invalid connection string "mongodb://…@/db"');
    expect(noCredentials('Protocol and host list are required in "mongodb+srv://ada:pa/ss@host/?a=1"')).toBe('Protocol and host list are required in "mongodb+srv://…@host/?a=1"');
    expect(noCredentials("can't reach redis://:p@ss@cache:6379 nor rediss://u:p@h")).toBe("can't reach redis://…@cache:6379 nor rediss://…@h");
  });

  it('leaves other text, and URLs without credentials, as they are', () => {
    for (const text of ['', 'connect ECONNREFUSED 127.0.0.1:27017', 'mongodb://db1:27017,db2:27017/app?replicaSet=rs0', 'mail ada@example.com about mongodb://h/'])
      expect(noCredentials(text)).toBe(text);
  });

  it('is what the driver needs: its error for a string it cannot read has the password', async () => {
    const { MongoClient } = await import('mongodb');
    let text = '';
    try {
      new MongoClient('mongodb://ada:s3cret@/db');
    } catch (err) {
      text = (err as Error).message;
    }
    expect(text).toContain('s3cret');
    expect(noCredentials(text)).not.toContain('s3cret');
  });
});
