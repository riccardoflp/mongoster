// Atlas Search and Vector Search indexes of a collection for the Indexes tab: listing them with their
// status, creating, changing and dropping them. Servers without search (no mongot) are told apart
// from errors, so that the tab explains what is needed instead of failing.
import * as vscode from 'vscode';
import type { Collection, Document } from 'mongodb';
import { relaxed } from './documentFs';
import { fromRelaxed } from './queries';
import { errorMessage } from './tree';
import { isPlainObject, parseQuery } from './shared/query';
import { DEFAULT_NAMES, SEARCH_UNSUPPORTED_HELP, SearchIndexType, isSearchUnsupported } from './shared/searchIndexes';
import type { SearchIndexInfo } from './shared/messages';

const TYPES: SearchIndexType[] = ['search', 'vectorSearch'];

export async function loadSearchIndexes(coll: Collection): Promise<{ indexes: SearchIndexInfo[]; unsupported?: string; error?: string }> {
  try {
    const list = await coll.listSearchIndexes().toArray();
    return { indexes: list.map(toInfo) };
  } catch (err) {
    if (isSearchUnsupported(err)) return { indexes: [], unsupported: errorMessage(err) };
    return { indexes: [], error: errorMessage(err) };
  }
}

function toInfo(doc: Document): SearchIndexInfo {
  const raw = relaxed(doc) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const hosts = Array.isArray(raw.statusDetail)
    ? raw.statusDetail.filter(isPlainObject).map((d) => {
        const main = isPlainObject(d.mainIndex) ? d.mainIndex : {};
        const staged = isPlainObject(d.stagedIndex) ? d.stagedIndex : undefined;
        return {
          host: String(d.hostname ?? d.host ?? '?'),
          status: text(d.status) ?? text(main.status),
          queryable: typeof d.queryable === 'boolean' ? d.queryable : typeof main.queryable === 'boolean' ? main.queryable : undefined,
          message: text(d.message) ?? text(main.message) ?? text(staged?.message),
          staged: staged ? text(staged.status) : undefined,
        };
      })
    : undefined;
  return {
    name: String(raw.name),
    type: text(raw.type) ?? 'search',
    status: text(raw.status),
    queryable: typeof raw.queryable === 'boolean' ? raw.queryable : undefined,
    definition: isPlainObject(raw.latestDefinition) ? raw.latestDefinition : {},
    message: text(raw.message),
    hosts: hosts?.length ? hosts : undefined,
  };
}

/** The error of a command, said in terms of what the server lacks when it has no search. */
function explain(err: unknown): Error {
  return new Error(isSearchUnsupported(err) ? `${SEARCH_UNSUPPORTED_HELP}\n${errorMessage(err)}` : errorMessage(err));
}

/**
 * Creates a search index from the dialog's definition (mongosh syntax) or, with `original`, gives
 * that index the new definition. Both return at once: the server builds the index in the background.
 */
export async function saveSearchIndex(coll: Collection, original: string | undefined, name: string, type: string, definitionText: string): Promise<string> {
  if (!TYPES.includes(type as SearchIndexType)) throw new Error(`Unknown search index type ${type}: it is search or vectorSearch.`);
  let value: unknown;
  try {
    value = parseQuery(definitionText);
  } catch (err) {
    throw new Error(`Definition: ${errorMessage(err)}`);
  }
  if (!isPlainObject(value)) throw new Error('The definition must be an object, e.g. { mappings: { dynamic: true } }');
  const definition = fromRelaxed(value) as Document;
  try {
    if (original !== undefined) {
      await coll.updateSearchIndex(original, definition);
      return `Search index ${original}: the new definition is being built. Queries keep using the previous one until it is ready.`;
    }
    const created = await coll.createSearchIndex({ name: name.trim() || DEFAULT_NAMES[type as SearchIndexType], type, definition });
    return `Created search index ${created}: it is being built, and can be queried once its status is READY.`;
  } catch (err) {
    throw explain(err);
  }
}

/** Drops the search index after a confirmation; false when cancelled. */
export async function dropSearchIndex(coll: Collection, name: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `Drop search index ${name} on ${coll.collectionName}?`,
    { modal: true, detail: 'The $search, $searchMeta and $vectorSearch stages that use it will return no results. The server removes it in the background.' },
    'Drop',
  );
  if (answer !== 'Drop') return false;
  try {
    await coll.dropSearchIndex(name);
  } catch (err) {
    throw explain(err);
  }
  return true;
}
