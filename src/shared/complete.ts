// Completion of mongosh-syntax query text: filters, sorts, projections, updates, index keys and
// aggregation stages. Pure functions shared by the webview inputs and the playground editor.
import type { BsonType, FieldSchema, SchemaSummary, ValueCount } from './schema';
import { formatKey, toShell } from './query';

/** A field seen in the documents, with its most frequent values. */
export interface FieldHint {
  path: string;
  types: BsonType[];
  /** Share of the documents (or parent objects) that have the field, 0–1. */
  ratio: number;
  values: ValueCount[];
  /** Arrays of numbers only: their lengths (a field a vector search index can take). */
  vector?: { min: number; max: number };
}

/** A search index of the collection, suggested in the `index` of $search and $vectorSearch. */
export interface SearchIndexHint {
  name: string;
  type: string;
  status?: string;
}

/** What the text is: decides which keys and values make sense where. */
export type CompletionKind =
  | 'filter'
  | 'sort'
  | 'project'
  | 'update'
  | 'index'
  | 'pipeline'
  /** One stage object: { $match: … }. */
  | 'stageObject'
  /** A field name as a string, e.g. distinct("…"). */
  | 'field'
  /** Documents to insert: one, or an array of them. */
  | 'document'
  /** The definition of an Atlas Search or a Vector Search index. */
  | 'searchDefinition'
  | 'vectorDefinition'
  | { stage: string };

export interface CompletionItem {
  label: string;
  detail?: string;
  kind: 'field' | 'operator' | 'stage' | 'value';
  /** Text replacing `from`–`to`. */
  insert: string;
  /** Caret position inside `insert` after inserting (end when absent). */
  cursor?: number;
}

export interface CompletionResult {
  from: number;
  to: number;
  /** What was typed so far (without the opening quote). */
  prefix: string;
  position: 'key' | 'value';
  items: CompletionItem[];
}

const MAX_VALUES = 10;
const NUMERIC: BsonType[] = ['int', 'long', 'double', 'decimal'];

/** Flattens a schema summary into one hint per dotted path (array elements merged into their array's path). */
export function fieldHints(summary: SchemaSummary): FieldHint[] {
  const hints = new Map<string, FieldHint>();
  const visit = (f: FieldSchema, ratio?: number) => {
    let hint = hints.get(f.path);
    if (!hint) hints.set(f.path, (hint = { path: f.path, types: [], ratio: 0, values: [] }));
    hint.ratio = Math.max(hint.ratio, ratio ?? (f.of ? f.count / f.of : 0));
    for (const t of f.types) {
      if (!hint.types.includes(t.type)) hint.types.push(t.type);
      const numbers = t.elements?.types.length && t.elements.types.every((e) => NUMERIC.includes(e.type));
      if (t.type === 'array' && numbers && t.lengths && t.lengths.max > 0) {
        hint.vector = { min: Math.min(hint.vector?.min ?? Infinity, t.lengths.min), max: Math.max(hint.vector?.max ?? 0, t.lengths.max) };
      }
      for (const v of t.top ?? []) {
        const same = hint.values.find((x) => JSON.stringify(x.value) === JSON.stringify(v.value));
        if (same) same.count += v.count;
        else hint.values.push({ ...v });
      }
      if (t.elements) visit(t.elements, hint.ratio);
    }
    for (const child of f.fields ?? []) visit(child);
  };
  for (const f of summary.fields) visit(f);
  for (const hint of hints.values()) {
    hint.values.sort((a, b) => b.count - a.count);
    hint.values.length = Math.min(hint.values.length, MAX_VALUES);
  }
  return [...hints.values()];
}

// ---------------------------------------------------------------------------
// Vocabulary: [name, description, value template ('|' marks the caret)]

type Op = [string, string, string?];

const QUERY_TOP: Op[] = [
  ['$and', 'all conditions match', '[{ | }]'],
  ['$or', 'at least one condition matches', '[{ | }]'],
  ['$nor', 'no condition matches', '[{ | }]'],
  ['$expr', 'aggregation expression', '{ | }'],
  ['$text', 'text index search', '{ $search: "|" }'],
  ['$jsonSchema', 'matches a JSON schema', '{ | }'],
  ['$where', 'JavaScript condition', '"|"'],
  ['$comment', 'comment shown in logs', '"|"'],
];

const QUERY_OPS: Op[] = [
  ['$eq', 'equal'],
  ['$ne', 'not equal'],
  ['$gt', 'greater than'],
  ['$gte', 'greater or equal'],
  ['$lt', 'less than'],
  ['$lte', 'less or equal'],
  ['$in', 'any of the values', '[|]'],
  ['$nin', 'none of the values', '[|]'],
  ['$exists', 'field present', 'true|'],
  ['$type', 'BSON type', '"|"'],
  ['$regex', 'regular expression', '/|/'],
  ['$options', 'regex options', '"i|"'],
  ['$elemMatch', 'an array element matches', '{ | }'],
  ['$size', 'array length'],
  ['$all', 'array contains all', '[|]'],
  ['$not', 'negates the conditions', '{ | }'],
  ['$mod', 'divisor and remainder', '[|, 0]'],
];

const UPDATE_OPS: Op[] = [
  ['$set', 'set fields', '{ | }'],
  ['$unset', 'remove fields', '{ |: "" }'],
  ['$inc', 'increment', '{ |: 1 }'],
  ['$mul', 'multiply', '{ | }'],
  ['$rename', 'rename fields', '{ | }'],
  ['$min', 'set if lower', '{ | }'],
  ['$max', 'set if greater', '{ | }'],
  ['$currentDate', 'set to the current date', '{ |: true }'],
  ['$setOnInsert', 'set on upsert insert', '{ | }'],
  ['$push', 'append to an array', '{ | }'],
  ['$addToSet', 'add to an array if missing', '{ | }'],
  ['$pull', 'remove matching elements', '{ | }'],
  ['$pullAll', 'remove listed elements', '{ | }'],
  ['$pop', 'remove first (-1) or last (1)', '{ |: 1 }'],
];

const STAGES: Op[] = [
  ['$match', 'filter documents', '{ | }'],
  ['$project', 'include, exclude or compute fields', '{ | }'],
  ['$addFields', 'add computed fields', '{ | }'],
  ['$set', 'add computed fields', '{ | }'],
  ['$unset', 'remove fields', '"|"'],
  ['$group', 'group by a key', '{ _id: "$|" }'],
  ['$sort', 'sort', '{ |: -1 }'],
  ['$limit', 'first n documents', '|10'],
  ['$skip', 'skip n documents', '|10'],
  ['$unwind', 'one document per array element', '"$|"'],
  ['$lookup', 'join another collection', '{ from: "|", localField: "", foreignField: "", as: "" }'],
  ['$count', 'count the documents', '"|count"'],
  ['$sortByCount', 'group, count and sort', '"$|"'],
  ['$replaceRoot', 'replace the document', '{ newRoot: "$|" }'],
  ['$replaceWith', 'replace the document', '"$|"'],
  ['$sample', 'random documents', '{ size: |10 }'],
  ['$facet', 'several pipelines at once', '{ |: [] }'],
  ['$bucket', 'group into ranges', '{ groupBy: "$|", boundaries: [], default: "other" }'],
  ['$bucketAuto', 'group into n ranges', '{ groupBy: "$|", buckets: 5 }'],
  ['$unionWith', 'append another collection', '{ coll: "|" }'],
  ['$graphLookup', 'recursive lookup', '{ | }'],
  ['$setWindowFields', 'window functions', '{ | }'],
  ['$redact', 'restrict content', '{ | }'],
  ['$search', 'Atlas Search (first stage)', '{ index: "|", text: { query: "", path: "" } }'],
  ['$searchMeta', 'Atlas Search counts and facets (first stage)', '{ index: "|", exists: { path: "" }, count: { type: "total" } }'],
  ['$vectorSearch', 'Vector Search (first stage)', '{ index: "|", path: "", queryVector: [], numCandidates: 100, limit: 10 }'],
  ['$out', 'write to a collection', '"|"'],
  ['$merge', 'merge into a collection', '{ into: "|" }'],
];

const ACCUMULATORS: Op[] = [
  ['$sum', 'sum (1 counts)', '|1'],
  ['$avg', 'average', '"$|"'],
  ['$min', 'minimum', '"$|"'],
  ['$max', 'maximum', '"$|"'],
  ['$first', 'first value', '"$|"'],
  ['$last', 'last value', '"$|"'],
  ['$push', 'array of the values', '"$|"'],
  ['$addToSet', 'array of the distinct values', '"$|"'],
  ['$count', 'number of documents', '{}|'],
  ['$mergeObjects', 'merged objects', '"$|"'],
  ['$stdDevPop', 'population standard deviation', '"$|"'],
  ['$stdDevSamp', 'sample standard deviation', '"$|"'],
];

const ONE = '"$|"';
const OBJ = '{ | }';
const EXPR_OPS: Op[] = [
  ['$add', 'sum'],
  ['$subtract', 'difference'],
  ['$multiply', 'product'],
  ['$divide', 'quotient'],
  ['$mod', 'remainder'],
  ['$abs', 'absolute value', ONE],
  ['$round', 'round', '["$|", 0]'],
  ['$floor', 'round down', ONE],
  ['$ceil', 'round up', ONE],
  ['$eq', 'equal'],
  ['$ne', 'not equal'],
  ['$gt', 'greater than'],
  ['$gte', 'greater or equal'],
  ['$lt', 'less than'],
  ['$lte', 'less or equal'],
  ['$cmp', 'compare (-1, 0, 1)'],
  ['$and', 'all true'],
  ['$or', 'any true'],
  ['$not', 'negation'],
  ['$cond', 'if / then / else', '{ if: |, then: , else:  }'],
  ['$ifNull', 'first non-null value'],
  ['$switch', 'first matching branch', '{ branches: [{ case: |, then:  }], default:  }'],
  ['$concat', 'join strings'],
  ['$toLower', 'lowercase', ONE],
  ['$toUpper', 'uppercase', ONE],
  ['$trim', 'trim whitespace', '{ input: "$|" }'],
  ['$split', 'split a string', '["$|", ","]'],
  ['$substrCP', 'substring', '["$|", 0, 1]'],
  ['$strLenCP', 'string length', ONE],
  ['$regexMatch', 'regex test', '{ input: "$|", regex: // }'],
  ['$replaceAll', 'replace substrings', '{ input: "$|", find: "", replacement: "" }'],
  ['$size', 'array length', ONE],
  ['$arrayElemAt', 'element at an index', '["$|", 0]'],
  ['$first', 'first element', ONE],
  ['$last', 'last element', ONE],
  ['$filter', 'array elements matching', '{ input: "$|", as: "item", cond: {} }'],
  ['$map', 'transform array elements', '{ input: "$|", as: "item", in: "$$item" }'],
  ['$reduce', 'fold an array', '{ input: "$|", initialValue: 0, in: {} }'],
  ['$in', 'value in array'],
  ['$slice', 'part of an array', '["$|", 5]'],
  ['$concatArrays', 'join arrays'],
  ['$isArray', 'is an array', ONE],
  ['$sortArray', 'sorted array', '{ input: "$|", sortBy: 1 }'],
  ['$year', 'year of a date', ONE],
  ['$month', 'month of a date', ONE],
  ['$dayOfMonth', 'day of a date', ONE],
  ['$hour', 'hour of a date', ONE],
  ['$dateToString', 'format a date', '{ format: "%Y-%m-%d", date: "$|" }'],
  ['$dateFromString', 'parse a date', '{ dateString: "$|" }'],
  ['$dateTrunc', 'truncate a date', '{ date: "$|", unit: "day" }'],
  ['$dateAdd', 'add to a date', '{ startDate: "$|", unit: "day", amount: 1 }'],
  ['$dateDiff', 'difference of dates', '{ startDate: "$|", endDate: "$$NOW", unit: "day" }'],
  ['$toString', 'convert to string', ONE],
  ['$toInt', 'convert to int', ONE],
  ['$toDouble', 'convert to double', ONE],
  ['$toDate', 'convert to date', ONE],
  ['$toObjectId', 'convert to ObjectId', ONE],
  ['$type', 'BSON type name', ONE],
  ['$mergeObjects', 'merge objects'],
  ['$objectToArray', 'object to k/v array', ONE],
  ['$arrayToObject', 'k/v array to object', ONE],
  ['$getField', 'field by name', '{ field: "|", input: "$$ROOT" }'],
  ['$literal', 'value as is', OBJ],
  ['$meta', 'search score, text score…', '"searchScore|"'],
  ['$sum', 'sum'],
  ['$avg', 'average'],
  ['$min', 'minimum'],
  ['$max', 'maximum'],
];

const VARIABLES = ['$$ROOT', '$$NOW', '$$CURRENT', '$$REMOVE'];

const BSON_TYPES = ['string', 'int', 'double', 'long', 'decimal', 'bool', 'date', 'objectId', 'object', 'array', 'null', 'number'];

// Atlas Search: the operators of $search and $searchMeta (also inside compound and embeddedDocument),
// the options of the stages and of $vectorSearch, and the definitions of the indexes.

const SEARCH_OPS: Op[] = [
  ['text', 'full-text search', '{ query: "|", path: "" }'],
  ['compound', 'combine operators', '{ must: [{ text: { query: "|", path: "" } }], should: [], filter: [] }'],
  ['autocomplete', 'search as you type', '{ query: "|", path: "" }'],
  ['phrase', 'words in this order', '{ query: "|", path: "" }'],
  ['equals', 'equal value', '{ path: "|", value:  }'],
  ['range', 'numbers or dates in a range', '{ path: "|", gte: , lte:  }'],
  ['in', 'any of the values', '{ path: "|", value: [] }'],
  ['exists', 'field present', '{ path: "|" }'],
  ['wildcard', 'pattern with * and ?', '{ query: "|", path: "", allowAnalyzedField: true }'],
  ['regex', 'regular expression', '{ query: "|", path: "", allowAnalyzedField: true }'],
  ['queryString', 'Lucene query syntax', '{ defaultPath: "|", query: "" }'],
  ['near', 'close to a number, date or point', '{ path: "|", origin: , pivot:  }'],
  ['moreLikeThis', 'documents like these', '{ like: { | } }'],
  ['embeddedDocument', 'inside arrays of documents', '{ path: "|", operator: {} }'],
];

const SEARCH_STAGE_OPTS: Op[] = [
  ['index', 'search index ("default" when left out)', '"|"'],
  ['highlight', 'matching passages ($meta: "searchHighlights")', '{ path: "|" }'],
  ['count', 'number of matches ($$SEARCH_META)', '{ type: "total|" }'],
  ['sort', 'sort by indexed fields', '{ |: -1 }'],
  ['returnStoredSource', 'only the stored fields', 'true|'],
  ['scoreDetails', 'how the score is computed', 'true|'],
  ['concurrent', 'parallel search on search nodes', 'true|'],
];

const SEARCH_META_OPTS: Op[] = [
  SEARCH_STAGE_OPTS[0],
  ['facet', 'counts by value or range', '{ operator: { | }, facets: { byField: { type: "string", path: "" } } }'],
  ['count', 'number of matches', '{ type: "total|" }'],
];

const VECTOR_SEARCH_OPTS: Op[] = [
  ['index', 'vector search index', '"|"'],
  ['path', 'field with the vectors', '"|"'],
  ['queryVector', 'the vector to compare', '[|]'],
  ['numCandidates', 'nearest neighbors examined (10–20 × limit)', '|100'],
  ['limit', 'documents returned', '|10'],
  ['filter', 'pre-filter on the filter fields of the index', '{ | }'],
  ['exact', 'exact search (ENN) instead of approximate', 'true|'],
];

const META_VALUES = ['"searchScore"', '"vectorSearchScore"', '"searchHighlights"', '"searchScoreDetails"', '"textScore"', '"indexKey"'];
const META_ITEMS: [string, string][] = [
  ['{ $meta: "searchScore" }', 'score of $search'],
  ['{ $meta: "vectorSearchScore" }', 'score of $vectorSearch'],
];

const quoted = (values: string[]) => values.map((v) => JSON.stringify(v));
const ANALYZERS = quoted(['lucene.standard', 'lucene.simple', 'lucene.whitespace', 'lucene.keyword', 'lucene.english', 'lucene.italian', 'lucene.french', 'lucene.german', 'lucene.spanish']);
const SEARCH_FIELD_TYPES = quoted(['string', 'autocomplete', 'token', 'number', 'date', 'boolean', 'objectId', 'uuid', 'document', 'embeddedDocuments', 'geo']);

const SEARCH_DEFINITION_OPTS: Op[] = [
  ['mappings', 'which fields are indexed', '{ dynamic: true| }'],
  ['analyzer', 'analyzer of the indexed strings', '"lucene.standard|"'],
  ['searchAnalyzer', 'analyzer of the query text', '"lucene.standard|"'],
  ['analyzers', 'custom analyzers', '[|]'],
  ['storedSource', 'fields kept in the index for returnStoredSource', 'true|'],
  ['synonyms', 'synonym mappings', '[{ name: "|", analyzer: "lucene.standard", source: { collection: "" } }]'],
];

const MAPPING_OPTS: Op[] = [
  ['dynamic', 'index every field (of supported types)', 'true|'],
  ['fields', 'fields indexed one by one', '{ | }'],
];

const FIELD_MAPPING_OPTS: Op[] = [
  ['type', 'how the field is indexed', '"|"'],
  ['analyzer', 'analyzer of the field', '"lucene.standard|"'],
  ['searchAnalyzer', 'analyzer of the query text', '"lucene.standard|"'],
  ['dynamic', 'index every field of the document', 'true|'],
  ['fields', 'fields of the document', '{ | }'],
  ['multi', 'the same field with other analyzers', '{ |: { type: "string", analyzer: "" } }'],
  ['tokenization', 'autocomplete: how words are split', '"edgeGram|"'],
  ['minGrams', 'autocomplete: shortest token', '|2'],
  ['maxGrams', 'autocomplete: longest token', '|15'],
  ['foldDiacritics', 'autocomplete: ignore accents', 'true|'],
  ['store', 'stored for highlighting', 'false|'],
];

const VECTOR_DEFINITION_OPTS: Op[] = [['fields', 'vector and filter fields', '[{ type: "vector", path: "|", numDimensions: 1536, similarity: "cosine" }]']];

const VECTOR_FIELD_OPTS: Op[] = [
  ['type', '"vector" or "filter"', '"|"'],
  ['path', 'field', '"|"'],
  ['numDimensions', 'length of the vectors', '|1536'],
  ['similarity', 'cosine, euclidean or dotProduct', '"cosine|"'],
  ['quantization', 'none, scalar or binary', '"scalar|"'],
  ['hnswOptions', 'graph options', '{ maxEdges: 16, numEdgeCandidates: 100 }|'],
];

// ---------------------------------------------------------------------------
// Contexts: what a value (or the keys of an object) at some place in the text can be

type Ctx =
  | { k: 'query'; prefix: string; elem?: string }
  | { k: 'field'; field: string }
  | { k: 'value'; field: string }
  | { k: 'list'; of: Ctx }
  | { k: 'enum'; values: string[] }
  | { k: 'sort'; index?: boolean }
  | { k: 'project'; agg: boolean }
  | { k: 'expr'; include?: boolean }
  | { k: 'update' }
  | { k: 'updateFields'; op: string }
  | { k: 'pipeline' }
  | { k: 'stageObj' }
  | { k: 'group' }
  | { k: 'accumulators' }
  | { k: 'outputs'; of: Ctx }
  /** `info`: descriptions and templates of the keys; `each`: an array of such objects is fine too. */
  | { k: 'opts'; keys: string[]; children: Record<string, Ctx>; value?: Ctx; info?: Op[]; each?: boolean }
  /** `vector`: the arrays of numbers first. */
  | { k: 'fieldName'; vector?: boolean }
  /** Keys of a document (or sub-document at `prefix`); `field`: the field the value belongs to. */
  | { k: 'doc'; prefix: string; field?: string }
  /** Operators of $search (with the stage's options when `stage` is set). */
  | { k: 'searchOps'; stage?: string }
  /** Names of the collection's search indexes of a type. */
  | { k: 'searchIndex'; type: string }
  /** Fields directly below `prefix` in the mappings of a search index. */
  | { k: 'searchFields'; prefix: string }
  | { k: 'none' };

const NONE: Ctx = { k: 'none' };
const EXPR: Ctx = { k: 'expr' };
const BOOL: Ctx = { k: 'enum', values: ['true', 'false'] };
const PATH: Ctx = { k: 'fieldName' };
/** An options object; `value`: what the stage can be instead of the object (e.g. $unwind: "$path"). */
const opts = (children: Record<string, Ctx>, value?: Ctx): Ctx => ({ k: 'opts', keys: Object.keys(children), children, value });
/** An options object whose keys are those of `info`, with their descriptions and templates. */
const described = (info: Op[], children: Record<string, Ctx>, each = false): Ctx => ({ k: 'opts', keys: info.map(([k]) => k), children, info, each });
const oneOf = (values: string[]): Ctx => ({ k: 'enum', values: quoted(values) });

/** What the value of a $search operator (or, with `stage`, of an option of the stage) can be. */
function searchChild(key: string, stage?: string): Ctx {
  if (stage) {
    if (key === 'index') return { k: 'searchIndex', type: 'search' };
    if (key === 'highlight') return opts({ path: PATH, maxCharsToExamine: NONE, maxNumPassages: NONE });
    if (key === 'count') return opts({ type: oneOf(['total', 'lowerBound']), threshold: NONE });
    if (key === 'sort') return { k: 'sort' };
    if (key === 'returnStoredSource' || key === 'scoreDetails' || key === 'concurrent') return BOOL;
    if (key === 'facet') {
      const facet = opts({ type: oneOf(['string', 'number', 'date']), path: PATH, numBuckets: NONE, boundaries: NONE, default: NONE });
      return opts({ operator: { k: 'searchOps' }, facets: { k: 'outputs', of: facet } });
    }
  }
  const score = opts({ boost: opts({ value: NONE, path: PATH }), constant: opts({ value: NONE }) });
  const fuzzy = opts({ maxEdits: NONE, prefixLength: NONE, maxExpansions: NONE });
  const common = { path: PATH, score };
  const operators: Ctx = { k: 'list', of: { k: 'searchOps' } };
  switch (key) {
    case 'text':
      return opts({ query: NONE, ...common, fuzzy, matchCriteria: oneOf(['any', 'all']), synonyms: NONE });
    case 'phrase':
      return opts({ query: NONE, ...common, slop: NONE, synonyms: NONE });
    case 'autocomplete':
      return opts({ query: NONE, ...common, tokenOrder: oneOf(['any', 'sequential']), fuzzy });
    case 'compound':
      return opts({ must: operators, should: operators, filter: operators, mustNot: operators, minimumShouldMatch: NONE, score });
    case 'equals':
    case 'in':
      return opts({ ...common, value: NONE });
    case 'range':
      return opts({ ...common, gt: NONE, gte: NONE, lt: NONE, lte: NONE });
    case 'exists':
      return opts(common);
    case 'wildcard':
    case 'regex':
      return opts({ query: NONE, ...common, allowAnalyzedField: BOOL });
    case 'queryString':
      return opts({ defaultPath: PATH, query: NONE, score });
    case 'near':
      return opts({ ...common, origin: NONE, pivot: NONE });
    case 'moreLikeThis':
      return opts({ like: NONE, score });
    case 'embeddedDocument':
      return opts({ path: PATH, operator: { k: 'searchOps' }, score });
    default:
      return NONE;
  }
}

/** The mapping of a field of a search index; the fields of a document mapping are below `prefix`. */
function fieldMapping(prefix: string): Ctx {
  const analyzer: Ctx = { k: 'enum', values: ANALYZERS };
  return described(
    FIELD_MAPPING_OPTS,
    {
      type: { k: 'enum', values: SEARCH_FIELD_TYPES },
      analyzer,
      searchAnalyzer: analyzer,
      dynamic: BOOL,
      fields: { k: 'searchFields', prefix },
      tokenization: oneOf(['edgeGram', 'rightEdgeGram', 'nGram']),
      foldDiacritics: BOOL,
      store: BOOL,
    },
    true,
  );
}

function searchDefinitionContext(): Ctx {
  const analyzer: Ctx = { k: 'enum', values: ANALYZERS };
  return described(SEARCH_DEFINITION_OPTS, {
    mappings: described(MAPPING_OPTS, { dynamic: BOOL, fields: { k: 'searchFields', prefix: '' } }),
    analyzer,
    searchAnalyzer: analyzer,
    storedSource: BOOL,
  });
}

function vectorDefinitionContext(): Ctx {
  const field = described(VECTOR_FIELD_OPTS, {
    type: oneOf(['vector', 'filter']),
    path: PATH,
    similarity: oneOf(['cosine', 'euclidean', 'dotProduct']),
    quantization: oneOf(['none', 'scalar', 'binary']),
  });
  return described(VECTOR_DEFINITION_OPTS, { fields: { k: 'list', of: field } });
}

function rootContext(kind: CompletionKind): Ctx {
  if (typeof kind === 'object') return stageContext(kind.stage.trim());
  switch (kind) {
    case 'filter':
      return { k: 'query', prefix: '' };
    case 'sort':
      return { k: 'sort' };
    case 'index':
      return { k: 'sort', index: true };
    case 'project':
      return { k: 'project', agg: false };
    case 'update':
      return { k: 'update' };
    case 'pipeline':
      return { k: 'pipeline' };
    case 'stageObject':
      return { k: 'stageObj' };
    case 'field':
      return { k: 'fieldName' };
    case 'document':
      return { k: 'doc', prefix: '' };
    case 'searchDefinition':
      return searchDefinitionContext();
    case 'vectorDefinition':
      return vectorDefinitionContext();
  }
}

function stageContext(op: string): Ctx {
  switch (op) {
    case '$match':
      return { k: 'query', prefix: '' };
    case '$sort':
      return { k: 'sort' };
    case '$project':
    case '$addFields':
    case '$set':
      return { k: 'project', agg: true };
    case '$group':
      return { k: 'group' };
    case '$unwind':
      return opts({ path: EXPR, includeArrayIndex: NONE, preserveNullAndEmptyArrays: BOOL }, EXPR);
    case '$lookup':
      return opts({
        from: NONE,
        localField: { k: 'fieldName' },
        foreignField: NONE,
        as: NONE,
        let: { k: 'outputs', of: EXPR },
        pipeline: { k: 'pipeline' },
      });
    case '$unset':
      return { k: 'fieldName' };
    case '$replaceRoot':
      return opts({ newRoot: EXPR });
    case '$sample':
      return opts({ size: NONE });
    case '$facet':
      return { k: 'outputs', of: { k: 'pipeline' } };
    case '$bucket':
      return opts({ groupBy: EXPR, boundaries: NONE, default: NONE, output: { k: 'outputs', of: { k: 'accumulators' } } });
    case '$bucketAuto':
      return opts({ groupBy: EXPR, buckets: NONE, output: { k: 'outputs', of: { k: 'accumulators' } }, granularity: NONE });
    case '$unionWith':
      return opts({ coll: NONE, pipeline: { k: 'pipeline' } });
    case '$merge':
      return opts({
        into: NONE,
        on: NONE,
        whenMatched: { k: 'enum', values: ['"replace"', '"keepExisting"', '"merge"', '"fail"'] },
        whenNotMatched: { k: 'enum', values: ['"insert"', '"discard"', '"fail"'] },
      });
    case '$search':
    case '$searchMeta':
      return { k: 'searchOps', stage: op };
    case '$vectorSearch':
      return described(VECTOR_SEARCH_OPTS, {
        index: { k: 'searchIndex', type: 'vectorSearch' },
        path: { k: 'fieldName', vector: true },
        filter: { k: 'query', prefix: '' },
        exact: BOOL,
      });
    case '$limit':
    case '$skip':
    case '$count':
    case '$out':
      return NONE;
    default:
      return EXPR;
  }
}

/** Context of the value under `key` (null: an array element) of a value in context `ctx`. */
function child(ctx: Ctx, key: string | null): Ctx {
  switch (ctx.k) {
    case 'query':
      if (key === null) return NONE;
      if (key === '$and' || key === '$or' || key === '$nor') return { k: 'list', of: { k: 'query', prefix: ctx.prefix } };
      if (key === '$expr') return EXPR;
      if (key === '$text') return opts({ $search: NONE, $language: NONE, $caseSensitive: BOOL, $diacriticSensitive: BOOL });
      if (key.startsWith('$')) return ctx.elem ? child({ k: 'field', field: ctx.elem }, key) : NONE;
      return { k: 'field', field: ctx.prefix + key };
    case 'field':
      if (key === null) return NONE;
      if (!key.startsWith('$')) return NONE;
      if (key === '$in' || key === '$nin' || key === '$all') return { k: 'list', of: { k: 'value', field: ctx.field } };
      if (key === '$elemMatch') return { k: 'query', prefix: `${ctx.field}.`, elem: ctx.field };
      if (key === '$not') return ctx;
      if (key === '$exists') return BOOL;
      if (key === '$type') return { k: 'enum', values: BSON_TYPES.map((t) => JSON.stringify(t)) };
      if (['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(key)) return { k: 'value', field: ctx.field };
      return NONE;
    case 'list':
      return key === null ? ctx.of : NONE;
    case 'sort':
      return key === null
        ? NONE
        : { k: 'enum', values: ctx.index ? ['1', '-1', '"text"', '"2dsphere"', '"hashed"'] : ['1', '-1'] };
    case 'project':
      if (key === null) return NONE;
      return ctx.agg ? { k: 'expr', include: true } : { k: 'enum', values: ['1', '0'] };
    case 'expr':
      return key === '$meta' ? { k: 'enum', values: META_VALUES } : EXPR;
    case 'update':
      return key === null ? { k: 'stageObj' } : { k: 'updateFields', op: key };
    case 'updateFields':
      if (key === null) return NONE;
      if (['$set', '$setOnInsert', '$min', '$max', '$push', '$addToSet', '$pull'].includes(ctx.op)) return { k: 'value', field: key };
      if (ctx.op === '$currentDate') return { k: 'enum', values: ['true', '{ $type: "date" }', '{ $type: "timestamp" }'] };
      if (ctx.op === '$pop') return { k: 'enum', values: ['1', '-1'] };
      if (ctx.op === '$unset') return { k: 'enum', values: ['""'] };
      if (ctx.op === '$pullAll') return { k: 'list', of: { k: 'value', field: key } };
      return NONE;
    case 'pipeline':
      return key === null ? { k: 'stageObj' } : NONE;
    case 'stageObj':
      return key === null ? NONE : stageContext(key);
    case 'group':
      if (key === null) return NONE;
      return key === '_id' ? EXPR : { k: 'accumulators' };
    case 'accumulators':
      return key === null ? NONE : EXPR;
    case 'outputs':
      return key === null ? NONE : ctx.of;
    case 'opts':
      return key === null ? (ctx.each ? ctx : NONE) : ctx.children[key] ?? NONE;
    case 'fieldName':
      return key === null ? ctx : NONE;
    case 'doc':
      // An array element: a document of the array (insertMany), or an element of an array field.
      if (key === null) return ctx;
      return { k: 'doc', prefix: `${ctx.prefix}${key}.`, field: ctx.prefix + key };
    case 'searchOps':
      return key === null ? NONE : searchChild(key, ctx.stage);
    case 'searchFields':
      return key === null ? NONE : fieldMapping(`${ctx.prefix}${key}.`);
    default:
      return NONE;
  }
}

// ---------------------------------------------------------------------------
// Scanning the text up to the caret

interface Frame {
  type: '{' | '[' | '(';
  /** Key under which this container sits (null: an array element, or the root). */
  key: string | null;
  /** Objects: expecting a key, a colon, a value, or a comma after the value. */
  state: 'key' | 'colon' | 'value' | 'after';
  currentKey?: string;
}

interface Scan {
  frames: Frame[];
  /** Root value already complete (e.g. after `}` of the root object). */
  done: boolean;
  /** Where the token at the caret starts, and its quote when inside a string. */
  tokenStart: number;
  quote?: string;
}

const WORD = /[\w$.]/;

function scan(text: string, offset: number): Scan {
  const frames: Frame[] = [];
  let done = false;
  let rootState = 'value' as 'value' | 'after';
  const top = () => frames[frames.length - 1];
  /** A complete value (or key) token was read. */
  const token = (value: string | undefined) => {
    const f = top();
    if (!f) {
      rootState = 'after';
      return;
    }
    if (f.type !== '{') return;
    if (f.state === 'key') {
      f.currentKey = value;
      f.state = 'colon';
    } else if (f.state === 'value') f.state = 'after';
  };
  let i = 0;
  while (i < offset) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0 || end >= offset) return { frames, done, tokenStart: offset, quote: '//' };
      i = end + 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0 || end + 2 > offset) return { frames, done, tokenStart: offset, quote: '/*' };
      i = end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') {
          value += text[j + 1] ?? '';
          j += 2;
        } else value += text[j++];
      }
      if (j >= offset) return { frames, done, tokenStart: i + 1, quote: c };
      token(value);
      i = j + 1;
    } else if (c === '/' && top()?.state !== 'key') {
      // Regex literal.
      let j = i + 1;
      while (j < text.length && text[j] !== '/' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= offset) return { frames, done, tokenStart: offset, quote: '/' };
      j++;
      while (j < text.length && /[a-z]/.test(text[j])) j++;
      token(undefined);
      i = j;
    } else if (WORD.test(c)) {
      let j = i;
      while (j < text.length && WORD.test(text[j])) j++;
      if (j >= offset) return { frames, done, tokenStart: i };
      const word = text.slice(i, j);
      // A call such as ObjectId(...) or new Date(...): the value ends with its closing parenthesis.
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] !== '(' && word !== 'new') token(word);
      i = j;
    } else if (c === '{' || c === '[' || c === '(') {
      const parent = top();
      const key = parent?.type === '{' ? parent.currentKey ?? null : parent?.type === '(' ? parent.key : null;
      frames.push({ type: c, key, state: 'key' });
      i++;
    } else if (c === '}' || c === ']' || c === ')') {
      frames.pop();
      token(undefined);
      if (!frames.length && c !== ')') done = true;
      i++;
    } else if (c === ':') {
      const f = top();
      if (f?.type === '{') f.state = 'value';
      i++;
    } else if (c === ',') {
      const f = top();
      if (f?.type === '{') {
        f.state = 'key';
        f.currentKey = undefined;
      }
      i++;
    } else {
      i++;
    }
  }
  if (!frames.length && rootState === 'after') done = true;
  return { frames, done, tokenStart: offset };
}

// ---------------------------------------------------------------------------

/** Suggestions at `offset` in `text`, or null where nothing applies (inside a comment, after a value, …). */
export function complete(
  text: string,
  offset: number,
  kind: CompletionKind,
  fields: FieldHint[],
  searchIndexes: SearchIndexHint[] = [],
): CompletionResult | null {
  const s = scan(text, offset);
  if (s.quote && !/^["'`]$/.test(s.quote)) return null;
  const quote = s.quote;
  const prefix = text.slice(s.tokenStart, offset);
  if (!quote && prefix && !WORD.test(prefix[0])) return null;
  let to = offset;
  while (to < text.length && WORD.test(text[to])) to++;
  if (quote && text[to] === quote) to++;

  // Context of the innermost container.
  let ctx = rootContext(kind);
  const frames = s.frames;
  if (!frames.length) {
    if (s.done) return null;
    return finish(s.tokenStart, to, prefix, 'value', valueItems(ctx, fields, quote, searchIndexes), text);
  }
  for (let i = 1; i < frames.length; i++) {
    const parent = frames[i - 1];
    if (parent.type === '(') continue;
    ctx = child(ctx, parent.type === '[' ? null : frames[i].key);
  }
  const f = frames[frames.length - 1];
  if (f.type === '(') return null;
  if (f.type === '[') return finish(s.tokenStart, to, prefix, 'value', valueItems(child(ctx, null), fields, quote, searchIndexes), text);
  if (f.state === 'key') return finish(s.tokenStart, to, prefix, 'key', keyItems(ctx, fields, quote), text);
  if (f.state === 'value') {
    return finish(s.tokenStart, to, prefix, 'value', valueItems(child(ctx, f.currentKey ?? null), fields, quote, searchIndexes), text);
  }
  return null;
}

function finish(
  from: number,
  to: number,
  prefix: string,
  position: 'key' | 'value',
  items: CompletionItem[],
  text: string,
): CompletionResult {
  const needle = prefix.toLowerCase();
  const scored = items
    .map((item, order) => ({ item, order, score: matchScore(item.label, prefix, needle) }))
    .filter((x) => x.score > 0 && x.item.label !== prefix)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.item);
  if (position === 'key') {
    // Keys get ": value" unless the colon is already there.
    const colon = /^\s*:/.test(text.slice(to));
    for (const item of scored) {
      if (colon) {
        delete item.cursor;
        continue;
      }
      const template = (item as KeyItem).template ?? '';
      const caret = template.indexOf('|');
      const value = template.replace('|', '');
      item.cursor = item.insert.length + 2 + (caret < 0 ? value.length : caret);
      item.insert = `${item.insert}: ${value}`;
    }
  }
  for (const item of scored) delete (item as KeyItem).template;
  return { from, to, prefix, position, items: scored };
}

/** 0: no match. Prefix matches beat matches of a later path segment, which beat substring matches. */
function matchScore(label: string, prefix: string, needle: string): number {
  if (!prefix) return 1;
  const bare = label.replace(/^"/, '');
  // "$" asks for operators or field references.
  if (needle.startsWith('$') && !bare.startsWith('$')) return 0;
  const lower = bare.toLowerCase().replace(/^\$+/, '');
  const word = needle.replace(/^\$+/, '');
  if (label.startsWith(prefix) || bare.startsWith(prefix)) return 6;
  if (lower.startsWith(word)) return 5;
  if (lower.split('.').some((seg) => seg.startsWith(word))) return 3;
  if (word.length >= 2 && lower.includes(word)) return 2;
  return 0;
}

type KeyItem = CompletionItem & { template?: string };

function keyItem(name: string, kind: CompletionItem['kind'], quote: string | undefined, detail?: string, template?: string): KeyItem {
  return { label: name, detail, kind, insert: quote ? escapeIn(name, quote) + quote : formatKey(name), template };
}

function fieldDetail(h: FieldHint): string {
  const pct = Math.round(h.ratio * 100);
  return `${h.types.join(' | ') || 'field'}${pct < 100 ? ` · ${pct}%` : ''}`;
}

function fieldKeys(fields: FieldHint[], prefix: string, quote: string | undefined): KeyItem[] {
  return fields
    .filter((h) => h.path.startsWith(prefix) && h.path.length > prefix.length)
    .map((h) => keyItem(h.path.slice(prefix.length), 'field', quote, fieldDetail(h)));
}

function opKeys(ops: Op[], quote: string | undefined, kind: CompletionItem['kind'] = 'operator'): KeyItem[] {
  return ops.map(([name, detail, template]) => keyItem(name, kind, quote, detail, template));
}

function keyItems(ctx: Ctx, fields: FieldHint[], quote: string | undefined): CompletionItem[] {
  switch (ctx.k) {
    case 'query':
      return [...fieldKeys(fields, ctx.prefix, quote), ...opKeys(ctx.elem ? [...QUERY_OPS, ...QUERY_TOP] : QUERY_TOP, quote)];
    case 'field':
      return opKeys(QUERY_OPS, quote);
    case 'sort':
    case 'project':
    case 'updateFields':
      return fieldKeys(fields, '', quote);
    case 'expr':
      return opKeys(EXPR_OPS, quote);
    case 'update':
      return opKeys(UPDATE_OPS, quote);
    case 'stageObj':
      return opKeys(STAGES, quote, 'stage');
    case 'group':
      return [keyItem('_id', 'field', quote, 'group key', '"$|"')];
    case 'accumulators':
      return opKeys(ACCUMULATORS, quote);
    case 'opts':
      return ctx.info ? opKeys(ctx.info, quote) : ctx.keys.map((k) => keyItem(k, 'operator', quote, 'option'));
    case 'doc':
      return fieldKeys(fields, ctx.prefix, quote).filter((item) => !item.label.includes('.'));
    case 'searchOps':
      return [...opKeys(SEARCH_OPS, quote), ...(ctx.stage ? opKeys(ctx.stage === '$searchMeta' ? SEARCH_META_OPTS : SEARCH_STAGE_OPTS, quote) : [])];
    case 'searchFields':
      return fields
        .filter((h) => h.path.startsWith(ctx.prefix) && h.path.length > ctx.prefix.length && !h.path.slice(ctx.prefix.length).includes('.'))
        .map((h) => keyItem(h.path.slice(ctx.prefix.length), 'field', quote, fieldDetail(h), '{ type: "|" }'));
    default:
      return [];
  }
}

function valueItems(ctx: Ctx, fields: FieldHint[], quote: string | undefined, searchIndexes: SearchIndexHint[] = []): CompletionItem[] {
  switch (ctx.k) {
    case 'field':
    case 'value':
    case 'doc': {
      const hint = fields.find((h) => h.path === ctx.field);
      return (hint?.values ?? [])
        .filter((v) => !quote || typeof v.value === 'string')
        .map((v) => {
          const shell = toShell(v.value);
          return {
            label: shell,
            detail: `×${v.count}`,
            kind: 'value' as const,
            insert: quote ? escapeIn(String(v.value), quote) + quote : shell,
          };
        });
    }
    case 'enum':
      return ctx.values
        .filter((v) => !quote || v.startsWith('"'))
        .map((v) => ({ label: v, kind: 'value' as const, insert: quote ? JSON.parse(v) + quote : v }));
    case 'expr': {
      const refs = [...fields.map((h) => ({ ref: `$${h.path}`, detail: fieldDetail(h) })), ...VARIABLES.map((v) => ({ ref: v, detail: 'variable' }))];
      const items: CompletionItem[] = refs.map(({ ref, detail }) => ({
        label: ref,
        detail,
        kind: 'field',
        insert: quote ? escapeIn(ref, quote) + quote : JSON.stringify(ref),
      }));
      if (ctx.include && !quote) {
        items.push(...['1', '0'].map((v) => ({ label: v, kind: 'value' as const, insert: v })));
        items.push(...META_ITEMS.map(([v, detail]) => ({ label: v, detail, kind: 'value' as const, insert: v })));
      }
      return items;
    }
    case 'opts':
      return ctx.value ? valueItems(ctx.value, fields, quote, searchIndexes) : [];
    case 'searchIndex':
      return searchIndexes
        .filter((ix) => (ix.type || 'search') === ctx.type)
        .map((ix) => ({
          label: JSON.stringify(ix.name),
          detail: ix.status ? `${ix.type} · ${ix.status}` : ix.type,
          kind: 'value' as const,
          insert: quote ? escapeIn(ix.name, quote) + quote : JSON.stringify(ix.name),
        }));
    case 'fieldName':
      return (ctx.vector ? [...fields.filter((h) => h.vector), ...fields.filter((h) => !h.vector)] : fields).map((h) => ({
        label: h.path,
        detail: fieldDetail(h),
        kind: 'field' as const,
        insert: quote ? escapeIn(h.path, quote) + quote : JSON.stringify(h.path),
      }));
    default:
      return [];
  }
}

/** Escapes text for inside a string delimited by `quote`. */
function escapeIn(s: string, quote: string): string {
  return s.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`).replace(/\n/g, '\\n');
}
