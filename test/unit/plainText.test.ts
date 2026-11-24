import { describe, expect, it } from 'vitest';
import { noLinks } from '../../src/shared/plainText';

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
