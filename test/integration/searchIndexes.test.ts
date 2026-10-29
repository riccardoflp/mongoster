// Search and Vector Search indexes against a server that has search: MongoDB Community 8.3+ with
// mongot, an Atlas local deployment or Atlas. The tests run only when MONGOSTER_SEARCH_URI gives its
// URI (a replica set member, e.g. mongodb://user:pass@localhost:27190/?directConnection=true), as no
// such server can be started here. They create, change and drop indexes in the database
// mongoster_search, which they drop at the end.
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StageError, buildPipeline } from '../../src/queries';
import { dropSearchIndex, loadSearchIndexes, saveSearchIndex } from '../../src/searchIndexes';
import type { SearchIndexInfo } from '../../src/shared/messages';
import { searchStatusPending, summarizeSearchDefinition } from '../../src/shared/searchIndexes';

// The drop asks for a confirmation.
vi.mock('vscode', async (original) => ({ ...(await original<object>()), window: { showWarningMessage: async () => 'Drop' } }));

const URI = process.env.MONGOSTER_SEARCH_URI;
const DB = 'mongoster_search';
/** Building an index takes mongot some seconds even on a few documents. */
const BUILD = 120_000;

let client: MongoClient;
const movies = () => client.db(DB).collection('movies');

const stages = (...list: [string, string][]) => list.map(([op, body]) => ({ op, body, enabled: true }));
const aggregate = async (...list: [string, string][]) => movies().aggregate(buildPipeline(stages(...list), list.length - 1).pipeline).toArray();

/** Reads the list as the tab does until no index is being built; the statuses seen on the way, by index. */
async function settle(): Promise<{ indexes: SearchIndexInfo[]; seen: Map<string, Set<string>> }> {
  const seen = new Map<string, Set<string>>();
  for (const deadline = Date.now() + BUILD - 5000; ; ) {
    const res = await loadSearchIndexes(movies());
    expect(res.error ?? res.unsupported).toBeUndefined();
    for (const ix of res.indexes) seen.set(ix.name, (seen.get(ix.name) ?? new Set()).add(ix.status ?? '?'));
    if (!res.indexes.some((ix) => searchStatusPending(ix.status)) || Date.now() > deadline) return { indexes: res.indexes, seen };
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!URI)('search indexes on a server with search', () => {
  beforeAll(async () => {
    client = await MongoClient.connect(URI!);
    await client.db(DB).dropDatabase();
    await movies().insertMany([
      { title: 'The Godfather', year: 1972, embedding: [0.1, 0.2, 0.3] },
      { title: 'Godzilla', year: 1954, embedding: [0.9, 0.1, 0.0] },
      { title: 'Casablanca', year: 1942, embedding: [0.2, 0.25, 0.35] },
    ]);
  });
  afterAll(async () => {
    await client?.db(DB).dropDatabase();
    await client?.close();
  });

  it('lists none at first', async () => {
    expect(await loadSearchIndexes(movies())).toEqual({ indexes: [] });
  });

  it(
    'creates search and vector search indexes and follows them until they are ready',
    async () => {
      expect(await saveSearchIndex(movies(), undefined, '', 'search', '{ mappings: { dynamic: true } }')).toMatch(/^Created search index default/);
      await saveSearchIndex(movies(), undefined, 'titles', 'search', '{ mappings: { dynamic: false, fields: { title: [{ type: "string" }, { type: "autocomplete" }], year: { type: "number" } } } }');
      await saveSearchIndex(movies(), undefined, '', 'vectorSearch', '{ fields: [{ type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" }, { type: "filter", path: "year" }] }');

      const { indexes, seen } = await settle();
      expect(indexes.map((ix) => [ix.name, ix.type, ix.status, ix.queryable])).toEqual([
        ['default', 'search', 'READY', true],
        ['titles', 'search', 'READY', true],
        ['vector_index', 'vectorSearch', 'READY', true],
      ]);
      for (const statuses of seen.values()) for (const s of statuses) expect(['PENDING', 'BUILDING', 'READY']).toContain(s);
      const vector = indexes.find((ix) => ix.name === 'vector_index')!;
      expect(summarizeSearchDefinition(vector.type, vector.definition)).toEqual(['embedding · 3 dims · cosine', 'filter: year']);
    },
    BUILD,
  );

  it('refuses a taken name, a definition of the other type and an invalid one, saying why', async () => {
    await expect(saveSearchIndex(movies(), undefined, 'titles', 'search', '{ mappings: { dynamic: true } }')).rejects.toThrow(/named titles already exists/);
    await expect(saveSearchIndex(movies(), undefined, 'v2', 'search', '{ fields: [{ type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" }] }')).rejects.toThrow(
      /defined by its mappings/,
    );
    await expect(saveSearchIndex(movies(), undefined, 'bad', 'search', '{ mappings: { dynamic: false, fields: { title: { type: "strin" } } } }')).rejects.toThrow(
      /^"?mappings\.fields\.title\.type"? must be one of/,
    );
    await expect(saveSearchIndex(movies(), undefined, 'bad', 'vectorSearch', '{ fields: [{ type: "vector", path: "embedding", numDimensions: 0, similarity: "cosine" }] }')).rejects.toThrow(
      /numDimensions/,
    );
    expect((await loadSearchIndexes(movies())).indexes.map((ix) => ix.name)).toEqual(['default', 'titles', 'vector_index']);
  });

  it('runs $search, $searchMeta and $vectorSearch built from the stages', async () => {
    const found = await aggregate(['$search', '{ index: "default", text: { query: "godfather", path: "title" } }'], ['$project', '{ _id: 0, title: 1, score: { $meta: "searchScore" } }']);
    expect(found).toEqual([{ title: 'The Godfather', score: expect.any(Number) }]);
    expect(await aggregate(['$search', '{ index: "titles", autocomplete: { query: "Godz", path: "title" } }'], ['$project', '{ _id: 0, title: 1 }'])).toEqual([{ title: 'Godzilla' }]);
    expect(await aggregate(['$searchMeta', '{ index: "titles", range: { path: "year", gte: 1950 }, count: { type: "total" } }'])).toEqual([{ count: { total: 2 } }]);
    const near = await aggregate(
      ['$vectorSearch', '{ index: "vector_index", path: "embedding", queryVector: [0.1, 0.2, 0.3], numCandidates: 10, limit: 2, filter: { year: { $gte: 1950 } } }'],
      ['$project', '{ _id: 0, title: 1, score: { $meta: "vectorSearchScore" } }'],
    );
    expect(near.map((d) => d.title)).toEqual(['The Godfather', 'Godzilla']);
    expect(() => buildPipeline(stages(['$match', '{}'], ['$search', '{ text: { query: "x", path: "title" } }']), 1)).toThrow(StageError);
    // The server says the same of a misplaced stage.
    await expect(movies().aggregate([{ $match: {} }, { $search: { text: { query: 'x', path: 'title' } } }]).toArray()).rejects.toThrow(/first stage/);
  });

  it(
    'changes a definition: the previous one answers until the new one is ready',
    async () => {
      expect(await saveSearchIndex(movies(), 'titles', 'titles', 'search', '{ mappings: { dynamic: false, fields: { title: { type: "string" } } } }')).toMatch(/new definition is being built/);
      const changed = (await loadSearchIndexes(movies())).indexes.find((ix) => ix.name === 'titles')!;
      expect(changed.definition).toEqual({ mappings: { dynamic: false, fields: { title: { type: 'string' } } } });
      if (changed.status === 'BUILDING') expect(changed.queryable).toBe(true);
      const { indexes } = await settle();
      expect(indexes.find((ix) => ix.name === 'titles')).toMatchObject({ status: 'READY', queryable: true });
      await expect(saveSearchIndex(movies(), 'missing', 'missing', 'search', '{ mappings: { dynamic: true } }')).rejects.toThrow(/missing/);
    },
    BUILD,
  );

  it('drops indexes', async () => {
    expect(await dropSearchIndex(movies(), 'titles')).toBe(true);
    expect(await dropSearchIndex(movies(), 'vector_index')).toBe(true);
    const names = (await loadSearchIndexes(movies())).indexes.filter((ix) => ix.status !== 'DELETING').map((ix) => ix.name);
    expect(names).toEqual(['default']);
    await expect(dropSearchIndex(movies(), 'missing')).rejects.toThrow(/missing/);
  });
});
