import { describe, expect, it } from 'vitest';
import {
  defaultIndexName,
  editableSpec,
  indexCommand,
  indexName,
  isWildcard,
  misspelledWildcards,
  normalizeSpec,
  planIndexChange,
  ttlParts,
  ttlSeconds,
  wildcardWarnings,
} from '../../src/shared/indexes';
import { parseQuery } from '../../src/shared/query';

describe('defaultIndexName and indexName', () => {
  it('names an index as MongoDB does', () => {
    expect(defaultIndexName({ a: 1, 'b.c': -1 })).toBe('a_1_b.c_-1');
    expect(defaultIndexName({ loc: '2dsphere', name: 'text' })).toBe('loc_2dsphere_name_text');
  });

  it('uses the given name, or the generated one', () => {
    expect(indexName({ keys: { a: 1 }, options: { name: 'mine' } })).toBe('mine');
    expect(indexName({ keys: { a: 1 }, options: { name: '' } })).toBe('a_1');
    expect(indexName({ keys: { a: 1 }, options: {} })).toBe('a_1');
  });
});

describe('normalizeSpec', () => {
  it('drops false flags, the generated name, background and text weights of 1', () => {
    expect(
      normalizeSpec({
        keys: { title: 'text', body: 'text' },
        options: { unique: false, sparse: false, hidden: false, background: true, name: 'title_text_body_text', weights: { title: 1, body: 5 }, extra: null },
      }),
    ).toEqual({ keys: { title: 'text', body: 'text' }, options: { weights: { body: 5 } } });
  });

  it('keeps true flags and a custom name', () => {
    expect(normalizeSpec({ keys: { a: 1 }, options: { unique: true, name: 'u' } }).options).toEqual({ unique: true, name: 'u' });
  });
});

describe('editableSpec', () => {
  it('turns what listIndexes reports back into createIndex arguments', () => {
    expect(
      editableSpec('email_1', { email: 1 }, { v: 2, key: { email: 1 }, name: 'email_1', unique: true, ns: 'app.users', background: false }),
    ).toEqual({ keys: { email: 1 }, options: { unique: true } });
  });

  it('puts the fields of a text index back in its keys', () => {
    const spec = editableSpec(
      'cat_1_title_text_body_text',
      { cat: 1, _fts: 'text', _ftsx: 1 },
      { weights: { title: 1, body: 3 }, default_language: 'english', language_override: 'language', textIndexVersion: 3 },
    );
    expect(spec.keys).toEqual({ cat: 1, title: 'text', body: 'text' });
    expect(spec.options).toEqual({ weights: { body: 3 } });
  });

  it('keeps a non-default text language and removes the collation version', () => {
    const spec = editableSpec('t', { _fts: 'text', _ftsx: 1 }, { weights: { t: 1 }, default_language: 'italian', collation: { locale: 'it', strength: 2, version: '57.1' } });
    expect(spec.options).toEqual({ name: 't', default_language: 'italian', collation: { locale: 'it', strength: 2 } });
  });

  it('gives an unchanged definition no change to make', () => {
    const current = editableSpec('a_1', { a: 1 }, { v: 2, expireAfterSeconds: 60 });
    expect(planIndexChange(current, { keys: { a: 1 }, options: { expireAfterSeconds: 60, unique: false } })).toEqual({ kind: 'none' });
  });
});

describe('planIndexChange', () => {
  const base = { keys: { a: 1 }, options: {} };

  it('ignores the order of options but not the order of keys', () => {
    expect(
      planIndexChange({ keys: { a: 1 }, options: { collation: { locale: 'fr', strength: 1 } } }, { keys: { a: 1 }, options: { collation: { strength: 1, locale: 'fr' } } }),
    ).toEqual({ kind: 'none' });
    expect(planIndexChange({ keys: { a: 1, b: 1 }, options: {} }, { keys: { b: 1, a: 1 }, options: {} })).toEqual({ kind: 'recreate', changed: ['keys', 'name'] });
  });

  it('hides or shows an index in place', () => {
    expect(planIndexChange(base, { keys: { a: 1 }, options: { hidden: true } })).toEqual({ kind: 'modify', hidden: true });
    expect(planIndexChange({ keys: { a: 1 }, options: { hidden: true } }, base)).toEqual({ kind: 'modify', hidden: false });
  });

  it('changes a TTL in place, but adding or removing one rebuilds the index', () => {
    expect(planIndexChange({ keys: { a: 1 }, options: { expireAfterSeconds: 60 } }, { keys: { a: 1 }, options: { expireAfterSeconds: 120, hidden: true } })).toEqual({
      kind: 'modify',
      hidden: true,
      expireAfterSeconds: 120,
    });
    expect(planIndexChange(base, { keys: { a: 1 }, options: { expireAfterSeconds: 60 } })).toEqual({ kind: 'recreate', changed: ['expireAfterSeconds'] });
    expect(planIndexChange({ keys: { a: 1 }, options: { expireAfterSeconds: 60 } }, base)).toEqual({ kind: 'recreate', changed: ['expireAfterSeconds'] });
  });

  it('rebuilds for anything else, listing what changed', () => {
    expect(planIndexChange(base, { keys: { a: 1 }, options: { unique: true, hidden: true } })).toEqual({ kind: 'recreate', changed: ['unique', 'hidden'] });
    expect(planIndexChange(base, { keys: { a: 1 }, options: { name: 'renamed' } })).toEqual({ kind: 'recreate', changed: ['name'] });
  });
});

describe('indexCommand', () => {
  it('writes a createIndex that parses back to the definition', () => {
    const cmd = indexCommand('my users', { keys: { email: 1, at: -1 }, options: { unique: true, name: 'email_1_at_-1', partialFilterExpression: { at: { $exists: true } } } });
    expect(cmd.startsWith('db.getCollection("my users").createIndex(')).toBe(true);
    const args = parseQuery(`[${cmd.slice('db.getCollection("my users").createIndex('.length, -1)}]`);
    expect(args).toEqual([{ email: 1, at: -1 }, { unique: true, partialFilterExpression: { at: { $exists: true } } }]);
  });

  it('leaves out empty options', () => {
    expect(indexCommand('c', { keys: { a: 1 }, options: { unique: false } })).toBe('db.getCollection("c").createIndex({ a: 1 })');
  });
});

describe('wildcards', () => {
  it('recognizes wildcard keys', () => {
    expect(isWildcard('$**')).toBe(true);
    expect(isWildcard('a.b.$**')).toBe(true);
    expect(isWildcard('a.*')).toBe(false);
    expect(isWildcard('**')).toBe(false);
    expect(isWildcard('a.$**.b')).toBe(false);
    expect(isWildcard('$a.$**')).toBe(false);
    expect(isWildcard('a*.$**')).toBe(false);
  });

  it('finds keys that look like wildcards but are not', () => {
    expect(misspelledWildcards({ 'a.*': 1, '$**': 1, b: 1, '**': 1 })).toEqual(['a.*', '**']);
  });

  it('warns about wrong wildcard definitions', () => {
    expect(wildcardWarnings({ keys: { 'address.*': 1 }, options: {} })[0]).toContain("address.* isn't a wildcard");
    expect(wildcardWarnings({ keys: { '$**': 1, 'a.$**': 1 }, options: {} })).toContain('An index can have only one wildcard field.');
    expect(wildcardWarnings({ keys: { '$**': 'hashed' }, options: {} })[0]).toContain('ascending or descending');
    expect(wildcardWarnings({ keys: { '$**': 1 }, options: { unique: true, expireAfterSeconds: 5 } })).toContain("A wildcard index can't be unique or TTL.");
    expect(wildcardWarnings({ keys: { 'a.$**': 1 }, options: { wildcardProjection: { b: 1 } } })[0]).toContain('wildcardProjection only goes with $**');
    expect(wildcardWarnings({ keys: { a: 1 }, options: { wildcardProjection: { b: 1 } } })).toEqual(['wildcardProjection is only for wildcard indexes.']);
    expect(wildcardWarnings({ keys: { '$**': 1, status: 1 }, options: {} })[0]).toContain('wildcardProjection: { status: 0 }');
  });

  it('accepts correct wildcard and text definitions', () => {
    expect(wildcardWarnings({ keys: { '$**': 1 }, options: {} })).toEqual([]);
    expect(wildcardWarnings({ keys: { 'a.$**': -1 }, options: {} })).toEqual([]);
    expect(wildcardWarnings({ keys: { '$**': 1, status: 1 }, options: { wildcardProjection: { status: 0 } } })).toEqual([]);
    // A text index on every string field.
    expect(wildcardWarnings({ keys: { '$**': 'text' }, options: {} })).toEqual([]);
    expect(wildcardWarnings({ keys: { a: 1 }, options: {} })).toEqual([]);
  });
});

describe('TTL units', () => {
  it('expresses seconds in the largest unit that divides them', () => {
    expect(ttlParts(86400 * 3)).toEqual({ value: 3, unit: 'days' });
    expect(ttlParts(7200)).toEqual({ value: 2, unit: 'hours' });
    expect(ttlParts(90)).toEqual({ value: 90, unit: 'seconds' });
    expect(ttlParts(120)).toEqual({ value: 2, unit: 'minutes' });
    expect(ttlParts(0)).toEqual({ value: 0, unit: 'seconds' });
  });

  it('round-trips through ttlSeconds', () => {
    for (const s of [0, 1, 59, 60, 3600, 5400, 86400, 172800]) {
      const { value, unit } = ttlParts(s);
      expect(ttlSeconds(value, unit)).toBe(s);
    }
    expect(ttlSeconds(5, 'unknown')).toBe(5);
  });
});
