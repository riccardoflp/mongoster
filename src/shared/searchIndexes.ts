// Atlas Search and Vector Search indexes as the Indexes tab shows and edits them: summaries of their
// definitions, templates built from the sampled fields, the mongosh commands, and telling a server
// without search (no mongot) from a real error. Definitions are relaxed-EJSON plain values.
import type { FieldHint } from './complete';
import { isPlainObject, prettyShell } from './query';

export type SearchIndexType = 'search' | 'vectorSearch';
type Definition = Record<string, unknown>;

/** What each status of $listSearchIndexes means, for the badges' tooltips. */
export const SEARCH_STATUS_TITLES: Record<string, string> = {
  READY: 'Built: queries use it',
  PENDING: 'Waiting to be built',
  BUILDING: 'Being built: until it is ready, queries use the previous definition, if any',
  FAILED: 'The build failed: see the message in the details',
  STALE: 'Queryable, but no longer kept up to date (e.g. the oplog moved past it): it returns stale results',
  DELETING: 'Being dropped',
  DOES_NOT_EXIST: 'The index can no longer be found',
};

/** good, busy (comes back to READY by itself), bad, or unknown: the color of a status badge. */
export function searchStatusTone(status: string | undefined): 'good' | 'busy' | 'bad' | 'muted' {
  switch (status) {
    case 'READY':
      return 'good';
    case 'PENDING':
    case 'BUILDING':
    case 'DELETING':
      return 'busy';
    case 'FAILED':
    case 'STALE':
    case 'DOES_NOT_EXIST':
      return 'bad';
    default:
      return 'muted';
  }
}

/** A status that changes by itself: the tab reads the list again until it settles. */
export function searchStatusPending(status: string | undefined): boolean {
  return searchStatusTone(status) === 'busy';
}

// ---- servers without search

/** SearchNotEnabled (no mongot), CommandNotFound, CommandNotSupported, unknown $listSearchIndexes stage (servers before 6.0.7). */
const UNSUPPORTED_CODES = new Set([31082, 59, 115, 40324, 6047401]);
const UNSUPPORTED_TEXT = /requires additional configuration|only supported (with|on) (MongoDB )?Atlas|Unrecognized pipeline stage name: '\$listSearchIndexes'|no such command: '(create|update|drop)SearchIndex|search index commands are not supported|mongot/i;

/** The error says that the server has no search, rather than that something went wrong. */
export function isSearchUnsupported(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | undefined;
  if (isSearchUnreachable(err)) return false;
  return (typeof e?.code === 'number' && UNSUPPORTED_CODES.has(e.code)) || (typeof e?.message === 'string' && UNSUPPORTED_TEXT.test(e.message));
}

export const SEARCH_UNSUPPORTED_HELP =
  'Search indexes need MongoDB Atlas, an Atlas local deployment (atlas deployments setup --type local) or MongoDB Community 8.3 or later with mongot: this server has no search.';

/** SearchIndexManagementHostUnreachable: the server has search configured, but its mongot does not answer. */
const UNREACHABLE_CODES = new Set([508]);
const UNREACHABLE_TEXT = /Error connecting to Search Index Management service|SearchIndexManagementHostUnreachable|connectivity of gRPC channel/i;

/** The error says that the server has search, but cannot reach its search process (mongot) now. */
export function isSearchUnreachable(err: unknown): boolean {
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown } | undefined;
  return (
    (typeof e?.code === 'number' && UNREACHABLE_CODES.has(e.code)) ||
    e?.codeName === 'SearchIndexManagementHostUnreachable' ||
    (typeof e?.message === 'string' && UNREACHABLE_TEXT.test(e.message))
  );
}

export const SEARCH_UNREACHABLE_HELP =
  'The server is set up for search but cannot reach mongot, the process that builds and queries the search indexes: check that it is running and that mongotHost and searchIndexManagementHostAndPort point to it.';

/**
 * A validation error of mongot without the path of the command it was in: `"userCommand.indexes[0].mappings" is required`
 * becomes `"mappings" is required`, as the same error is said when the index is changed.
 */
export function searchErrorText(message: string): string {
  return message.replace(/"userCommand\.indexes\[\d+\]\./g, '"');
}

// ---- types

/**
 * The type of a definition by its shape: `mappings` for search, a `fields` list for vectorSearch;
 * undefined when it has neither.
 */
export function definitionType(definition: unknown): SearchIndexType | undefined {
  if (!isPlainObject(definition)) return undefined;
  if (isPlainObject(definition.mappings)) return 'search';
  if (Array.isArray(definition.fields)) return 'vectorSearch';
  return undefined;
}

/**
 * The type of an index of $listSearchIndexes. Atlas says it (`type`); MongoDB Community's mongot
 * does not, so it is told from the definition.
 */
export function searchIndexType(index: { type?: unknown; latestDefinition?: unknown }): SearchIndexType | string {
  if (typeof index.type === 'string' && index.type) return index.type;
  return definitionType(index.latestDefinition) ?? 'search';
}

const TYPE_NAMES: Record<SearchIndexType, string> = { search: 'search', vectorSearch: 'vector search' };

/** Why a definition of the other type is refused, in the terms of the dialog; undefined when it fits. */
export function definitionTypeMismatch(type: SearchIndexType, definition: unknown): string | undefined {
  const actual = definitionType(definition);
  if (!actual || actual === type) return undefined;
  return type === 'search'
    ? `A ${TYPE_NAMES.search} index is defined by its mappings, e.g. { mappings: { dynamic: true } }; this definition has a fields list, as a ${TYPE_NAMES.vectorSearch} index has.`
    : `A ${TYPE_NAMES.vectorSearch} index is defined by a fields list, e.g. { fields: [{ type: "vector", path: "embedding", numDimensions: 1536, similarity: "cosine" }] }; this definition has mappings, as a ${TYPE_NAMES.search} index has.`;
}

// ---- summaries

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** The mapped fields of a search definition as dotted paths, nested documents included. */
export function mappedPaths(definition: Definition): string[] {
  const mappings = isPlainObject(definition.mappings) ? definition.mappings : {};
  const out: string[] = [];
  const visit = (fields: unknown, prefix: string) => {
    if (!isPlainObject(fields)) return;
    for (const [name, value] of Object.entries(fields)) {
      const path = prefix + name;
      const docs = asArray(value).filter((m): m is Definition => isPlainObject(m) && isDocumentType(m.type) && isPlainObject(m.fields) && Object.keys(m.fields).length > 0);
      // A document with fields of its own is mapped through them, unless it also maps the rest dynamically.
      if (!docs.length || asArray(value).some((m) => isPlainObject(m) && (!isDocumentType(m.type) || m.dynamic === true))) out.push(path);
      for (const d of docs) visit(d.fields, `${path}.`);
    }
  };
  visit(mappings.fields, '');
  return [...new Set(out)];
}

const isDocumentType = (t: unknown) => t === 'document' || t === 'embeddedDocuments';

/** The types each mapped field is indexed as, for the summary: `title (string, autocomplete)`. */
function mappedTypes(definition: Definition): Map<string, string[]> {
  const mappings = isPlainObject(definition.mappings) ? definition.mappings : {};
  const out = new Map<string, string[]>();
  const visit = (fields: unknown, prefix: string) => {
    if (!isPlainObject(fields)) return;
    for (const [name, value] of Object.entries(fields)) {
      for (const m of asArray(value)) {
        if (!isPlainObject(m)) continue;
        const type = typeof m.type === 'string' ? m.type : 'document';
        if (isDocumentType(type) && isPlainObject(m.fields) && Object.keys(m.fields).length) visit(m.fields, `${prefix}${name}.`);
        else out.set(prefix + name, [...(out.get(prefix + name) ?? []), type]);
      }
    }
  };
  visit(mappings.fields, '');
  return out;
}

/** The vector fields and filter fields of a vectorSearch definition. */
export function vectorFields(definition: Definition): { vectors: Definition[]; filters: string[] } {
  const fields = asArray(definition.fields).filter(isPlainObject);
  return {
    vectors: fields.filter((f) => f.type === 'vector' || f.type === 'autoEmbed' || f.type === 'text'),
    filters: fields.filter((f) => f.type === 'filter' && typeof f.path === 'string').map((f) => f.path as string),
  };
}

/** One line per part of the definition, for the list: the mappings or the vector fields. */
export function summarizeSearchDefinition(type: string, definition: Definition): string[] {
  const lines: string[] = [];
  const list = (items: string[], max = 4) => (items.length > max ? `${items.slice(0, max).join(', ')} +${items.length - max}` : items.join(', '));
  if (type === 'vectorSearch') {
    const { vectors, filters } = vectorFields(definition);
    for (const v of vectors) {
      const parts = [String(v.path ?? '?')];
      if (v.numDimensions !== undefined) parts.push(`${String(v.numDimensions)} dims`);
      if (typeof v.similarity === 'string') parts.push(v.similarity);
      if (typeof v.quantization === 'string' && v.quantization !== 'none') parts.push(`${v.quantization} quantization`);
      if (v.type !== 'vector') parts.push(String(v.type));
      if (typeof v.model === 'string') parts.push(v.model);
      lines.push(parts.join(' · '));
    }
    if (!vectors.length) lines.push('no vector field');
    if (filters.length) lines.push(`filter: ${list(filters)}`);
    return lines;
  }
  const mappings = isPlainObject(definition.mappings) ? definition.mappings : {};
  const types = mappedTypes(definition);
  const fields = [...types].map(([path, t]) => `${path} (${[...new Set(t)].join(', ')})`);
  if (mappings.dynamic === true || isPlainObject(mappings.dynamic)) lines.push(fields.length ? `dynamic mapping, plus ${list(fields, 3)}` : 'dynamic mapping: every field');
  else lines.push(fields.length ? `${types.size} ${types.size === 1 ? 'field' : 'fields'}: ${list(fields)}` : 'no field mapped');
  const extras: string[] = [];
  if (typeof definition.analyzer === 'string') extras.push(`analyzer ${definition.analyzer}`);
  if (typeof definition.searchAnalyzer === 'string' && definition.searchAnalyzer !== definition.analyzer) extras.push(`search analyzer ${definition.searchAnalyzer}`);
  if (Array.isArray(definition.analyzers) && definition.analyzers.length) extras.push(`${definition.analyzers.length} custom ${definition.analyzers.length === 1 ? 'analyzer' : 'analyzers'}`);
  if (Array.isArray(definition.synonyms) && definition.synonyms.length) extras.push('synonyms');
  if (definition.storedSource !== undefined && definition.storedSource !== false) extras.push('stored source');
  if (extras.length) lines.push(extras.join(' · '));
  return lines;
}

// ---- commands

/** The mongosh command creating (or, with `update`, changing) the index. */
export function searchIndexCommand(collection: string, name: string, type: SearchIndexType, definition: Definition, update = false): string {
  const coll = `db.getCollection(${JSON.stringify(collection)})`;
  const def = prettyShell(definition, 0, 60);
  if (update) return `${coll}.updateSearchIndex(${JSON.stringify(name)}, ${def})`;
  return type === 'vectorSearch'
    ? `${coll}.createSearchIndex(${JSON.stringify(name)}, "vectorSearch", ${def})`
    : `${coll}.createSearchIndex(${JSON.stringify(name)}, ${def})`;
}

// ---- templates: search

export const DEFAULT_NAMES: Record<SearchIndexType, string> = { search: 'default', vectorSearch: 'vector_index' };

export function dynamicDefinition(): Definition {
  return { mappings: { dynamic: true } };
}

/** The Atlas Search field types the sampled BSON types map to; empty when none can be indexed. */
export function searchFieldTypes(hint: FieldHint | undefined): string[] {
  const types = new Set<string>();
  for (const t of hint?.types ?? []) {
    if (t === 'string') types.add('string');
    else if (t === 'int' || t === 'long' || t === 'double' || t === 'decimal') types.add('number');
    else if (t === 'date') types.add('date');
    else if (t === 'bool') types.add('boolean');
    else if (t === 'objectId') types.add('objectId');
    else if (t === 'object') types.add('document');
  }
  return [...types];
}

function mappingFor(hint: FieldHint | undefined): unknown {
  const types = searchFieldTypes(hint).map((type) => (type === 'document' ? { type, dynamic: true } : { type }));
  return types.length === 1 ? types[0] : types.length ? types : { type: 'string' };
}

/** A copy of a definition, to change it without touching the one shown. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The mapping of `name` in `fields` that is a document, created (or added to the field's mappings) when missing. */
function documentMapping(fields: Definition, name: string): Definition {
  const current = fields[name];
  const isDoc = (m: unknown): m is Definition => isPlainObject(m) && isDocumentType(m.type);
  let doc = asArray(current).find(isDoc);
  if (!doc) {
    doc = { type: 'document', fields: {} };
    fields[name] = current === undefined ? doc : [...asArray(current), doc];
  }
  if (!isPlainObject(doc.fields)) doc.fields = {};
  return doc;
}

/**
 * Maps the field `path` (with the types of its sampled values) or stops mapping it, in a copy of
 * the definition: a static mapping (`dynamic: false`), nested fields under `document` mappings.
 */
export function setMapped(definition: Definition, path: string, on: boolean, hints: FieldHint[]): Definition {
  const def = clone(definition);
  const mappings = isPlainObject(def.mappings) ? def.mappings : (def.mappings = {});
  if (on && mappings.dynamic === undefined) mappings.dynamic = false;
  if (!isPlainObject(mappings.fields)) mappings.fields = {};
  const parts = path.split('.');
  if (on) {
    let fields = mappings.fields as Definition;
    parts.slice(0, -1).forEach((_, i) => {
      fields = documentMapping(fields, parts[i]).fields as Definition;
    });
    const leaf = parts[parts.length - 1];
    const mapping = mappingFor(hints.find((h) => h.path === path));
    // A document already mapped through its fields maps the rest dynamically too.
    const existing = asArray(fields[leaf]).find((m) => isPlainObject(m) && isDocumentType(m.type)) as Definition | undefined;
    if (existing && isPlainObject(mapping) && mapping.type === 'document') existing.dynamic = true;
    else fields[leaf] = mapping;
  } else {
    // Walks down, then drops what is left empty on the way back up.
    const remove = (fields: Definition, i: number): void => {
      const name = parts[i];
      if (i === parts.length - 1) {
        const docs = asArray(fields[name]).filter((m): m is Definition => isPlainObject(m) && isDocumentType(m.type) && isPlainObject(m.fields) && Object.keys(m.fields).length > 0);
        // A document with mapped fields of its own keeps them, without the dynamic rest.
        if (docs.length) for (const d of docs) delete d.dynamic;
        else delete fields[name];
        return;
      }
      for (const m of asArray(fields[name])) {
        if (!isPlainObject(m) || !isDocumentType(m.type) || !isPlainObject(m.fields)) continue;
        remove(m.fields, i + 1);
        if (!Object.keys(m.fields).length && m.dynamic !== true) {
          const rest = asArray(fields[name]).filter((x) => x !== m);
          if (rest.length) fields[name] = rest.length === 1 ? rest[0] : rest;
          else delete fields[name];
        }
      }
    };
    remove(mappings.fields as Definition, 0);
  }
  return def;
}

/** Static mappings of the given fields (or of the sampled ones that can be indexed, without `_id`). */
export function staticDefinition(hints: FieldHint[], paths?: string[]): Definition {
  const chosen =
    paths ??
    hints
      .filter((h) => {
        const types = searchFieldTypes(h);
        // Objects are mapped through their fields; vectors belong in a vector search index.
        return h.path !== '_id' && !h.vector && types.length > 0 && !(types.length === 1 && types[0] === 'document');
      })
      .map((h) => h.path)
      .slice(0, 30);
  let def: Definition = { mappings: { dynamic: false, fields: {} } };
  for (const path of chosen) def = setMapped(def, path, true, hints);
  return def;
}

// ---- templates: vector search

export const SIMILARITIES = ['cosine', 'euclidean', 'dotProduct'];
export const QUANTIZATIONS = ['none', 'scalar', 'binary'];

export interface VectorForm {
  path: string;
  numDimensions?: number;
  similarity: string;
  quantization: string;
  filters: string[];
}

/** Sampled fields whose values are arrays of numbers only: candidates for the vector path. */
export function vectorCandidates(hints: FieldHint[]): FieldHint[] {
  return hints.filter((h) => h.vector);
}

export function vectorDefinition(form: VectorForm): Definition {
  return writeVectorForm({ fields: [] }, form);
}

/** The first vector field and the filter fields of a definition, as the dialog's form shows them. */
export function readVectorForm(definition: Definition): VectorForm {
  const { vectors, filters } = vectorFields(definition);
  const v = vectors.find((f) => f.type === 'vector') ?? {};
  return {
    path: typeof v.path === 'string' ? v.path : '',
    numDimensions: typeof v.numDimensions === 'number' ? v.numDimensions : undefined,
    similarity: typeof v.similarity === 'string' ? v.similarity : 'cosine',
    quantization: typeof v.quantization === 'string' ? v.quantization : 'none',
    filters,
  };
}

/**
 * The form put into a copy of the definition: its first vector field (other options of it, such as
 * hnswOptions, and other vector fields are kept) and its filter fields, in their order.
 */
export function writeVectorForm(definition: Definition, form: VectorForm): Definition {
  const def = clone(definition);
  const fields = asArray(def.fields).filter(isPlainObject);
  const at = fields.findIndex((f) => f.type === 'vector');
  const { quantization: _q, ...previous } = at >= 0 ? fields[at] : {};
  const vector: Definition = {
    ...previous,
    type: 'vector',
    path: form.path,
    numDimensions: form.numDimensions ?? 0,
    similarity: form.similarity,
    ...(form.quantization && form.quantization !== 'none' && { quantization: form.quantization }),
  };
  if (at >= 0) fields[at] = vector;
  else fields.unshift(vector);
  const kept = fields.filter((f) => f.type !== 'filter' || form.filters.includes(f.path as string));
  const present = new Set(kept.filter((f) => f.type === 'filter').map((f) => f.path));
  for (const path of form.filters) if (!present.has(path)) kept.push({ type: 'filter', path });
  def.fields = kept;
  return def;
}
