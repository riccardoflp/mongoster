import { describe, expect, it } from 'vitest';
import type { SavedQuery } from '../../src/shared/messages';
import {
  ProjectQuery,
  QueryFileError,
  folderName,
  matchesCollection,
  mergeSavedQueries,
  parseProjectQuery,
  projectSavedQuery,
  queryFileName,
  queryFilePath,
  serializeProjectQuery,
} from '../../src/shared/savedQueries';
import { globRegExp } from '../../src/standalone/vscode/watcher';

const find = (filter: string, sort = '', projection = '') => ({ filter, sort, projection });

describe('serializeProjectQuery', () => {
  it('writes the keys in a fixed order, only the parts that are set, with a final newline', () => {
    const q: ProjectQuery = {
      collection: 'orders',
      database: 'shop',
      query: find('{ status: "late" }', '{ at: -1 }'),
      description: 'Orders not shipped',
      name: 'Late orders',
    };
    expect(serializeProjectQuery(q)).toBe(
      [
        '{',
        '  "name": "Late orders",',
        '  "description": "Orders not shipped",',
        '  "database": "shop",',
        '  "collection": "orders",',
        '  "filter": "{ status: \\"late\\" }",',
        '  "sort": "{ at: -1 }"',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('keeps multi-line text as one line per array element, and the connection when set', () => {
    const text = serializeProjectQuery({
      name: 'Big',
      connection: 'Production',
      database: 'shop',
      collection: 'orders',
      query: find('{\r\n  total: { $gt: 100 }\r\n}'),
    });
    expect(JSON.parse(text)).toEqual({
      name: 'Big',
      connection: 'Production',
      database: 'shop',
      collection: 'orders',
      filter: ['{', '  total: { $gt: 100 }', '}'],
    });
    expect(Object.keys(JSON.parse(text))).toEqual(['name', 'connection', 'database', 'collection', 'filter']);
  });

  it('writes a pipeline as stages, disabled ones marked', () => {
    const text = serializeProjectQuery({
      name: 'By city',
      database: 'shop',
      collection: 'customers',
      query: {
        ...find(''),
        pipeline: [
          { op: '$match', body: '{ active: true }', enabled: true },
          { op: '$group', body: '{\n  _id: "$city",\n  n: { $sum: 1 }\n}', enabled: true },
          { op: '$limit', body: '10', enabled: false },
        ],
      },
    });
    expect(JSON.parse(text).pipeline).toEqual([
      { stage: '$match', body: '{ active: true }' },
      { stage: '$group', body: ['{', '  _id: "$city",', '  n: { $sum: 1 }', '}'] },
      { stage: '$limit', body: '10', enabled: false },
    ]);
    expect(text).not.toContain('"filter"');
  });

  it('gives an empty find query an empty filter', () => {
    expect(JSON.parse(serializeProjectQuery({ name: 'All', database: 'd', collection: 'c', query: find('') })).filter).toBe('{}');
  });
});

describe('parseProjectQuery', () => {
  it('reads back what serializeProjectQuery wrote', () => {
    const queries: ProjectQuery[] = [
      { name: 'A', description: 'Two\nlines', connection: 'Local', database: 'shop', collection: 'orders', query: find('{\n  a: 1\n}', '{ b: -1 }', '{ c: 1 }') },
      {
        name: 'B',
        database: 'shop',
        collection: 'orders',
        query: { ...find(''), pipeline: [{ op: '$match', body: '{ x: 1 }', enabled: true }, { op: '$skip', body: '5', enabled: false }] },
      },
    ];
    for (const q of queries) expect(parseProjectQuery(serializeProjectQuery(q))).toEqual(q);
  });

  it('accepts files written by hand: strings or line arrays, a BOM, unknown keys', () => {
    expect(parseProjectQuery('﻿{"name":" X ","database":"d","collection":"c","sort":["{","a: 1","}"],"note":"ignored"}')).toEqual({
      name: 'X',
      database: 'd',
      collection: 'c',
      query: { filter: '', sort: '{\na: 1\n}', projection: '' },
    });
  });

  it('says what is wrong with an invalid file', () => {
    const error = (text: string) => {
      try {
        parseProjectQuery(text);
      } catch (err) {
        expect(err).toBeInstanceOf(QueryFileError);
        return (err as Error).message;
      }
      throw new Error('no error');
    };
    expect(error('{ name: "x" }')).toMatch(/^not valid JSON/);
    expect(error('[]')).toBe('it must be a JSON object.');
    expect(error('{"database":"d","collection":"c"}')).toBe('"name" is missing: it must be a non-empty string.');
    expect(error('{"name":"n","collection":"c"}')).toBe('"database" is missing: it must be a non-empty string.');
    expect(error('{"name":"n","database":"d","collection":"c","filter":1}')).toBe('"filter" must be a string or an array of lines.');
    expect(error('{"name":"n","database":"d","collection":"c","connection":3}')).toBe('"connection" must be a string.');
    expect(error('{"name":"n","database":"d","collection":"c","filter":"{}","pipeline":[]}')).toMatch(/both a "pipeline" and/);
    expect(error('{"name":"n","database":"d","collection":"c","pipeline":{}}')).toBe('"pipeline" must be an array of stages.');
    expect(error('{"name":"n","database":"d","collection":"c","pipeline":[{"stage":"match","body":"{}"}]}')).toBe('"stage" of stage 1 must be a stage name such as "$match".');
    expect(error('{"name":"n","database":"d","collection":"c","pipeline":[{"stage":"$match","body":"{}","enabled":"no"}]}')).toBe('"enabled" of stage 1 must be true or false.');
    expect(error('{"name":"n","database":"d","collection":"c","pipeline":["$match"]}')).toBe('stage 1 of "pipeline" must be an object with "stage" and "body".');
  });
});

describe('matchesCollection', () => {
  const scope = { connectionName: 'Production', database: 'shop', collection: 'orders' };
  it('matches by database and collection, and by connection name only when set', () => {
    expect(matchesCollection({ database: 'shop', collection: 'orders' }, scope)).toBe(true);
    expect(matchesCollection({ database: 'shop', collection: 'orders', connection: 'production ' }, scope)).toBe(true);
    expect(matchesCollection({ database: 'shop', collection: 'orders', connection: 'Staging' }, scope)).toBe(false);
    expect(matchesCollection({ database: 'shop', collection: 'Orders' }, scope)).toBe(false);
    expect(matchesCollection({ database: 'shop2', collection: 'orders' }, scope)).toBe(false);
  });
});

describe('file names', () => {
  it('makes the query name a file name', () => {
    expect(queryFileName('Late orders (EU)')).toBe('late-orders-eu.json');
    expect(queryFileName('Città più grandi')).toBe('citta-piu-grandi.json');
    expect(queryFileName('★★★')).toBe('query.json');
    expect(queryFileName('x'.repeat(100))).toBe(`${'x'.repeat(60)}.json`);
  });

  it('makes database and collection names folder names every system accepts', () => {
    expect(folderName('shop')).toBe('shop');
    expect(folderName('system.users')).toBe('system.users');
    expect(folderName('a:b/c')).toBe('a_b_c');
    expect(folderName('con')).toBe('_con');
    expect(folderName('trail.')).toBe('trail_');
  });

  it('puts a query in database/collection and avoids the names taken', () => {
    expect(queryFilePath('shop', 'orders', 'Late')).toBe('shop/orders/late.json');
    const taken = new Set(['shop/orders/late.json', 'shop/orders/late-2.json']);
    expect(queryFilePath('shop', 'orders', 'Late', (r) => taken.has(r))).toBe('shop/orders/late-3.json');
  });
});

describe('mergeSavedQueries', () => {
  const user = (name: string, at = 0): SavedQuery => ({ id: `u-${name}`, name, ...find('{}'), at });
  const project = (name: string, connection?: string): SavedQuery =>
    projectSavedQuery({ name, database: 'd', collection: 'c', query: find('{}'), ...(connection && { connection }) }, `project:${name}${connection ?? ''}`, `${name}.json`, 0);

  it("puts the user's and the project's together by name, marking where each lives", () => {
    const merged = mergeSavedQueries([user('beta', 2), user('Alpha', 1)], [project('gamma'), project('alpha')]);
    expect(merged.map((q) => [q.name, q.source])).toEqual([
      ['alpha', 'project'],
      ['Alpha', 'user'],
      ['beta', 'user'],
      ['gamma', 'project'],
    ]);
  });

  it("with the same name, the project's for this connection first", () => {
    const merged = mergeSavedQueries([user('q')], [project('q'), project('q', 'Local')]);
    expect(merged.map((q) => [q.source, q.connection])).toEqual([
      ['project', 'Local'],
      ['project', undefined],
      ['user', undefined],
    ]);
  });

  it('sorts numbers in names by value', () => {
    expect(mergeSavedQueries([user('q10'), user('q9')], []).map((q) => q.name)).toEqual(['q9', 'q10']);
  });

  it('keeps the file, description and connection of project queries', () => {
    const [q] = mergeSavedQueries([], [projectSavedQuery({ name: 'n', description: 'd', connection: 'C', database: 'd', collection: 'c', query: find('{ a: 1 }') }, 'project:x', 'x.json', 5)]);
    expect(q).toEqual({ id: 'project:x', name: 'n', filter: '{ a: 1 }', sort: '', projection: '', at: 5, source: 'project', file: 'x.json', description: 'd', connection: 'C' });
  });
});

describe('globRegExp (the desktop app\'s file watcher)', () => {
  it('matches ** across folders, including the folder itself, and * within one', () => {
    const re = globRegExp('.mongoster/queries/**');
    expect(re.test('.mongoster/queries')).toBe(true);
    expect(re.test('.mongoster/queries/shop/orders/a.json')).toBe(true);
    expect(re.test('.mongoster/other/a.json')).toBe(false);
    const json = globRegExp('q/**/*.json');
    expect(json.test('q/a.json')).toBe(true);
    expect(json.test('q/x/y/a.json')).toBe(true);
    expect(json.test('q/x/a.js')).toBe(false);
    expect(globRegExp('*.{js,json}').test('a.json')).toBe(true);
    expect(globRegExp('*.{js,json}').test('x/a.json')).toBe(false);
  });
});
