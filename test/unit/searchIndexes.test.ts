import { BSON } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { CompletionKind, CompletionResult, FieldHint, SearchIndexHint, complete, fieldHints } from '../../src/shared/complete';
import { FIRST_STAGES, PipelineStage, STAGE_TEMPLATES, misplacedFirstStages, parseStageBody } from '../../src/shared/pipeline';
import { parseQuery } from '../../src/shared/query';
import { analyzeSchema } from '../../src/shared/schema';
import {
  dynamicDefinition,
  isSearchUnsupported,
  mappedPaths,
  readVectorForm,
  searchFieldTypes,
  searchIndexCommand,
  searchStatusPending,
  searchStatusTone,
  setMapped,
  staticDefinition,
  summarizeSearchDefinition,
  vectorCandidates,
  vectorDefinition,
  vectorFields,
  writeVectorForm,
} from '../../src/shared/searchIndexes';

const hints: FieldHint[] = [
  { path: '_id', types: ['objectId'], ratio: 1, values: [] },
  { path: 'title', types: ['string'], ratio: 1, values: [] },
  { path: 'year', types: ['int'], ratio: 0.9, values: [] },
  { path: 'address', types: ['object'], ratio: 0.5, values: [] },
  { path: 'address.city', types: ['string'], ratio: 1, values: [] },
  { path: 'address.geo', types: ['object'], ratio: 1, values: [] },
  { path: 'address.geo.lat', types: ['double'], ratio: 1, values: [] },
  { path: 'code', types: ['string', 'long'], ratio: 1, values: [] },
  { path: 'tags', types: ['array'], ratio: 1, values: [] },
  { path: 'embedding', types: ['array'], ratio: 1, values: [], vector: { min: 3, max: 3 } },
];

describe('search index status', () => {
  it('colors the statuses and keeps reading while they change by themselves', () => {
    expect(searchStatusTone('READY')).toBe('good');
    for (const s of ['PENDING', 'BUILDING', 'DELETING']) {
      expect(searchStatusTone(s)).toBe('busy');
      expect(searchStatusPending(s)).toBe(true);
    }
    for (const s of ['FAILED', 'STALE', 'DOES_NOT_EXIST']) expect(searchStatusTone(s)).toBe('bad');
    expect(searchStatusTone(undefined)).toBe('muted');
    expect(searchStatusPending('READY')).toBe(false);
    expect(searchStatusPending(undefined)).toBe(false);
  });
});

describe('isSearchUnsupported', () => {
  it('recognizes servers without search by code or message', () => {
    expect(isSearchUnsupported({ code: 31082, message: 'SearchNotEnabled' })).toBe(true);
    expect(isSearchUnsupported({ code: 59, message: "no such command: 'createSearchIndexes'" })).toBe(true);
    expect(isSearchUnsupported({ code: 40324, message: "Unrecognized pipeline stage name: '$listSearchIndexes'" })).toBe(true);
    expect(
      isSearchUnsupported(new Error('Using Atlas Search Database Commands and the $listSearchIndexes aggregation stage requires additional configuration.')),
    ).toBe(true);
    expect(isSearchUnsupported({ message: "Unrecognized pipeline stage name: '$listSearchIndexes'" })).toBe(true);
    expect(isSearchUnsupported({ message: 'Error connecting to Search Index Management service: mongot unreachable' })).toBe(true);
  });

  it('leaves real errors as errors', () => {
    expect(isSearchUnsupported({ code: 11000, message: 'E11000 duplicate key error' })).toBe(false);
    expect(isSearchUnsupported({ code: 13, message: 'not authorized on db to execute command' })).toBe(false);
    expect(isSearchUnsupported(new Error('Index already exists with a different definition'))).toBe(false);
    expect(isSearchUnsupported(undefined)).toBe(false);
    expect(isSearchUnsupported('mongot')).toBe(false);
  });
});

describe('summaries of search definitions', () => {
  it('summarizes dynamic mappings', () => {
    expect(summarizeSearchDefinition('search', dynamicDefinition())).toEqual(['dynamic mapping: every field']);
    expect(summarizeSearchDefinition('search', { mappings: { dynamic: { typeSet: 'x' }, fields: { a: { type: 'string' } } } })).toEqual([
      'dynamic mapping, plus a (string)',
    ]);
    expect(summarizeSearchDefinition('search', { mappings: {} })).toEqual(['no field mapped']);
  });

  it('lists the static fields with their types, nested documents by their fields, and the options', () => {
    const def = {
      mappings: {
        dynamic: false,
        fields: {
          title: [{ type: 'string' }, { type: 'autocomplete' }],
          address: { type: 'document', fields: { city: { type: 'string' } } },
          year: { type: 'number' },
        },
      },
      analyzer: 'lucene.english',
      searchAnalyzer: 'lucene.standard',
      analyzers: [{ name: 'a' }, { name: 'b' }],
      synonyms: [{ name: 's' }],
      storedSource: { include: ['title'] },
    };
    expect(summarizeSearchDefinition('search', def)).toEqual([
      '3 fields: title (string, autocomplete), address.city (string), year (number)',
      'analyzer lucene.english · search analyzer lucene.standard · 2 custom analyzers · synonyms · stored source',
    ]);
    const many = { mappings: { fields: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, { type: 'token' }])) } };
    expect(summarizeSearchDefinition('search', many)).toEqual(['6 fields: a (token), b (token), c (token), d (token) +2']);
    expect(summarizeSearchDefinition('search', { mappings: { fields: { only: { type: 'date' } } }, storedSource: false })).toEqual(['1 field: only (date)']);
  });

  it('summarizes vector fields and filters', () => {
    const def = {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine', quantization: 'scalar' },
        { type: 'vector', path: 'small', numDimensions: 8, similarity: 'dotProduct', quantization: 'none' },
        { type: 'autoEmbed', path: 'plot', model: 'voyage-3' },
        { type: 'filter', path: 'genre' },
        { type: 'filter', path: 'year' },
      ],
    };
    expect(summarizeSearchDefinition('vectorSearch', def)).toEqual([
      'embedding · 1536 dims · cosine · scalar quantization',
      'small · 8 dims · dotProduct',
      'plot · autoEmbed · voyage-3',
      'filter: genre, year',
    ]);
    expect(summarizeSearchDefinition('vectorSearch', { fields: [{ type: 'filter', path: 'x' }] })).toEqual(['no vector field', 'filter: x']);
    expect(vectorFields({ fields: { type: 'vector', path: 'v' } }).vectors).toEqual([{ type: 'vector', path: 'v' }]);
  });

  it('gives the mapped paths, a dynamic document as well as its fields', () => {
    const def = {
      mappings: {
        fields: {
          a: { type: 'string' },
          doc: { type: 'document', fields: { x: { type: 'string' } } },
          dyn: { type: 'document', dynamic: true, fields: { y: { type: 'number' } } },
          emb: { type: 'embeddedDocuments', fields: {} },
          both: [{ type: 'string' }, { type: 'document', fields: { z: { type: 'token' } } }],
        },
      },
    };
    expect(mappedPaths(def)).toEqual(['a', 'doc.x', 'dyn', 'dyn.y', 'emb', 'both', 'both.z']);
    expect(mappedPaths({})).toEqual([]);
  });
});

describe('searchIndexCommand', () => {
  it('writes the mongosh commands creating or changing an index', () => {
    expect(searchIndexCommand('movies', 'default', 'search', dynamicDefinition())).toBe(
      'db.getCollection("movies").createSearchIndex("default", { mappings: { dynamic: true } })',
    );
    const vector = searchIndexCommand('movies', 'vec', 'vectorSearch', { fields: [{ type: 'vector', path: 'e', numDimensions: 3, similarity: 'cosine' }] });
    expect(vector).toMatch(/^db\.getCollection\("movies"\)\.createSearchIndex\("vec", "vectorSearch", \{/);
    expect(searchIndexCommand('my "coll"', 'x', 'search', dynamicDefinition(), true)).toBe(
      'db.getCollection("my \\"coll\\"").updateSearchIndex("x", { mappings: { dynamic: true } })',
    );
    // The definition in the command is mongosh text that parses back to the same definition.
    const def = staticDefinition(hints);
    const text = searchIndexCommand('m', 'default', 'search', def);
    expect(parseQuery(text.slice(text.indexOf('{'), -1))).toEqual(def);
  });
});

describe('static mappings', () => {
  it('maps the BSON types of the sampled values to search types', () => {
    expect(searchFieldTypes({ path: 'x', types: ['string', 'int', 'long', 'double', 'decimal', 'date', 'bool', 'objectId', 'object', 'array', 'null'], ratio: 1, values: [] })).toEqual([
      'string',
      'number',
      'date',
      'boolean',
      'objectId',
      'document',
    ]);
    expect(searchFieldTypes(undefined)).toEqual([]);
  });

  it('maps the indexable sampled fields, nested ones under document mappings', () => {
    expect(staticDefinition(hints)).toEqual({
      mappings: {
        dynamic: false,
        fields: {
          title: { type: 'string' },
          year: { type: 'number' },
          address: { type: 'document', fields: { city: { type: 'string' }, geo: { type: 'document', fields: { lat: { type: 'number' } } } } },
          code: [{ type: 'string' }, { type: 'number' }],
        },
      },
    });
    expect(staticDefinition(hints, ['title'])).toEqual({ mappings: { dynamic: false, fields: { title: { type: 'string' } } } });
    // A field without a sampled type is mapped as a string.
    expect(staticDefinition([], ['unknown'])).toEqual({ mappings: { dynamic: false, fields: { unknown: { type: 'string' } } } });
  });

  it('maps and unmaps fields in a copy of the definition', () => {
    const def = staticDefinition(hints, ['address.city', 'address.geo.lat']);
    const without = setMapped(def, 'address.geo.lat', false, hints);
    expect(without.mappings).toEqual({ dynamic: false, fields: { address: { type: 'document', fields: { city: { type: 'string' } } } } });
    // Removing the last field of a document removes the document too.
    expect(setMapped(without, 'address.city', false, hints).mappings).toEqual({ dynamic: false, fields: {} });
    // The original is unchanged.
    expect(mappedPaths(def)).toEqual(['address.city', 'address.geo.lat']);
  });

  it('maps a document dynamically on top of its mapped fields, and back', () => {
    const def = staticDefinition(hints, ['address.city']);
    const dyn = setMapped(def, 'address', true, hints);
    expect(dyn.mappings).toEqual({ dynamic: false, fields: { address: { type: 'document', dynamic: true, fields: { city: { type: 'string' } } } } });
    expect(mappedPaths(dyn)).toEqual(['address', 'address.city']);
    expect(setMapped(dyn, 'address', false, hints).mappings).toEqual(def.mappings);
  });

  it('keeps a dynamic mapping dynamic when a field is added', () => {
    expect(setMapped(dynamicDefinition(), 'title', true, hints)).toEqual({ mappings: { dynamic: true, fields: { title: { type: 'string' } } } });
  });
});

describe('vector search form', () => {
  it('builds a definition from the form and reads it back', () => {
    const form = { path: 'embedding', numDimensions: 3, similarity: 'cosine', quantization: 'none', filters: ['genre'] };
    const def = vectorDefinition(form);
    expect(def).toEqual({
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' },
        { type: 'filter', path: 'genre' },
      ],
    });
    expect(readVectorForm(def)).toEqual(form);
    expect(readVectorForm({})).toEqual({ path: '', numDimensions: undefined, similarity: 'cosine', quantization: 'none', filters: [] });
  });

  it('changes the first vector field and the filters, keeping the rest', () => {
    const def = {
      fields: [
        { type: 'filter', path: 'old' },
        { type: 'vector', path: 'a', numDimensions: 4, similarity: 'euclidean', quantization: 'binary', hnswOptions: { maxEdges: 32 } },
        { type: 'vector', path: 'b', numDimensions: 2, similarity: 'cosine' },
        { type: 'filter', path: 'kept' },
      ],
    };
    const out = writeVectorForm(def, { path: 'a2', numDimensions: 8, similarity: 'dotProduct', quantization: 'scalar', filters: ['kept', 'new'] });
    expect(out).toEqual({
      fields: [
        { type: 'vector', path: 'a2', numDimensions: 8, similarity: 'dotProduct', quantization: 'scalar', hnswOptions: { maxEdges: 32 } },
        { type: 'vector', path: 'b', numDimensions: 2, similarity: 'cosine' },
        { type: 'filter', path: 'kept' },
        { type: 'filter', path: 'new' },
      ],
    });
    // Quantization "none" is the default: left out.
    expect(writeVectorForm(out, { ...readVectorForm(out), quantization: 'none' }).fields).toContainEqual({
      type: 'vector',
      path: 'a2',
      numDimensions: 8,
      similarity: 'dotProduct',
      hnswOptions: { maxEdges: 32 },
    });
    expect(def.fields).toHaveLength(4);
  });

  it('proposes the arrays of numbers as vector paths', () => {
    expect(vectorCandidates(hints).map((h) => h.path)).toEqual(['embedding']);
    const docs = Array.from({ length: 5 }, (_, i) => BSON.EJSON.serialize({ v: [0.1 * i, 0.2, 0.3], tags: ['a'], mixed: [1, 'x'] }, { relaxed: false }));
    const sampled = fieldHints(analyzeSchema(docs));
    expect(sampled.find((h) => h.path === 'v')?.vector).toEqual({ min: 3, max: 3 });
    expect(sampled.find((h) => h.path === 'tags')?.vector).toBeUndefined();
    expect(sampled.find((h) => h.path === 'mixed')?.vector).toBeUndefined();
  });
});

describe('pipeline: search stages', () => {
  const stage = (op: string, enabled = true, body = '{}'): PipelineStage => ({ op, body, enabled });

  it('has templates for the search stages that parse', () => {
    for (const op of FIRST_STAGES) expect(STAGE_TEMPLATES[op], op).toBeDefined();
    expect(parseStageBody(stage('$search', true, STAGE_TEMPLATES.$search))).toEqual({ index: 'default', text: { query: 'word', path: 'field' } });
    expect(parseStageBody(stage('$searchMeta', true, STAGE_TEMPLATES.$searchMeta))).toMatchObject({ count: { type: 'total' } });
    expect(parseStageBody(stage('$vectorSearch', true, STAGE_TEMPLATES.$vectorSearch))).toEqual({
      index: 'vector_index',
      path: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      numCandidates: 100,
      limit: 10,
    });
  });

  it('finds the search stages that are not the first enabled stage', () => {
    expect(misplacedFirstStages([stage('$search'), stage('$limit')])).toEqual([]);
    expect(misplacedFirstStages([stage('$match'), stage(' $search '), stage('$vectorSearch')])).toEqual([1, 2]);
    // A disabled stage before it doesn't count.
    expect(misplacedFirstStages([stage('$match', false), stage('$searchMeta')])).toEqual([]);
    expect(misplacedFirstStages([stage('$search'), stage('$search')])).toEqual([1]);
    // A disabled misplaced stage isn't run, so isn't marked.
    expect(misplacedFirstStages([stage('$match'), stage('$search', false)])).toEqual([]);
    expect(misplacedFirstStages([])).toEqual([]);
  });
});

describe('complete: search', () => {
  const indexes: SearchIndexHint[] = [
    { name: 'default', type: 'search', status: 'READY' },
    { name: 'titles', type: 'search', status: 'BUILDING' },
    { name: 'vec', type: 'vectorSearch', status: 'READY' },
    { name: 'legacy', type: '' },
  ];
  const at = (textWithCaret: string, kind: CompletionKind, fields = hints, ix = indexes): CompletionResult | null => {
    const offset = textWithCaret.indexOf('‸');
    return complete(textWithCaret.replace('‸', ''), offset, kind, fields, ix);
  };
  const labels = (r: CompletionResult | null) => r?.items.map((i) => i.label) ?? [];

  it('suggests the search index names of the right type for the index option', () => {
    const search = at('{ index: ‸ }', { stage: '$search' });
    expect(labels(search)).toEqual(['"default"', '"titles"', '"legacy"']);
    expect(search?.items[0]).toMatchObject({ detail: 'search · READY', insert: '"default"' });
    expect(labels(at('{ index: ‸ }', { stage: '$searchMeta' }))).toContain('"titles"');
    expect(labels(at('{ index: ‸ }', { stage: '$vectorSearch' }))).toEqual(['"vec"']);
    // Inside quotes, the name and the closing quote.
    const quoted = at('{ index: "ti‸ }', { stage: '$search' });
    expect(quoted?.items.find((i) => i.label === '"titles"')?.insert).toBe('titles"');
    expect(labels(at('{ index: ‸ }', { stage: '$search' }, hints, []))).toEqual([]);
  });

  it('suggests the operators and options of $search, $searchMeta and $vectorSearch', () => {
    const search = labels(at('{ ‸ }', { stage: '$search' }));
    expect(search).toEqual(expect.arrayContaining(['text', 'compound', 'autocomplete', 'index', 'highlight', 'count']));
    expect(search).not.toContain('facet');
    expect(labels(at('{ ‸ }', { stage: '$searchMeta' }))).toEqual(expect.arrayContaining(['facet', 'index', 'exists']));
    expect(labels(at('{ ‸ }', { stage: '$vectorSearch' }))).toEqual(['index', 'path', 'queryVector', 'numCandidates', 'limit', 'filter', 'exact']);
    // Inside compound: the operators again.
    expect(labels(at('{ compound: { must: [{ ‸ }] } }', { stage: '$search' }))).toEqual(expect.arrayContaining(['text', 'range', 'equals']));
    expect(labels(at('{ text: { ‸ } }', { stage: '$search' }))).toEqual(expect.arrayContaining(['query', 'path', 'fuzzy', 'score']));
  });

  it('suggests fields for paths, the arrays of numbers first for $vectorSearch', () => {
    const path = at('{ text: { path: ‸ } }', { stage: '$search' });
    expect(labels(path)).toEqual(hints.map((h) => h.path));
    expect(path?.items.find((i) => i.label === 'title')?.insert).toBe('"title"');
    expect(labels(at('{ path: ‸ }', { stage: '$vectorSearch' }))[0]).toBe('embedding');
  });

  it('suggests $meta scores in projections', () => {
    expect(labels(at('{ score: { $meta: ‸ } }', { stage: '$project' }))).toEqual(expect.arrayContaining(['"searchScore"', '"vectorSearchScore"']));
    expect(labels(at('{ score: ‸ }', { stage: '$project' }))).toContain('{ $meta: "searchScore" }');
  });

  it('suggests the keys of search and vector index definitions', () => {
    expect(labels(at('{ ‸ }', 'searchDefinition'))).toEqual(['mappings', 'analyzer', 'searchAnalyzer', 'analyzers', 'storedSource', 'synonyms']);
    expect(labels(at('{ mappings: { ‸ } }', 'searchDefinition'))).toEqual(['dynamic', 'fields']);
    expect(labels(at('{ mappings: { fields: { ‸ } } }', 'searchDefinition'))).toEqual(['_id', 'title', 'year', 'address', 'code', 'tags', 'embedding']);
    expect(labels(at('{ mappings: { fields: { address: { fields: { ‸ } } } } }', 'searchDefinition'))).toEqual(['city', 'geo']);
    expect(labels(at('{ mappings: { fields: { title: [{ type: "string" }, { ‸ }] } } }', 'searchDefinition'))).toContain('analyzer');
    expect(labels(at('{ mappings: { fields: { title: { type: ‸ } } } }', 'searchDefinition'))).toEqual(expect.arrayContaining(['"string"', '"autocomplete"']));
    expect(labels(at('{ fields: [{ ‸ }] }', 'vectorDefinition'))).toEqual(['type', 'path', 'numDimensions', 'similarity', 'quantization', 'hnswOptions']);
    expect(labels(at('{ fields: [{ similarity: ‸ }] }', 'vectorDefinition'))).toEqual(['"cosine"', '"euclidean"', '"dotProduct"']);
  });
});
