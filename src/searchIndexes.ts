// Atlas Search and Vector Search indexes of a collection for the Indexes tab: listing them with their
// status, creating, changing and dropping them. Servers without search (no mongot) are told apart
// from errors, so that the tab explains what is needed instead of failing.
import * as vscode from 'vscode';
import type { Collection, Document } from 'mongodb';
import { relaxed } from './documentFs';
import { fromRelaxed } from './queries';
import { errorMessage } from './tree';
import { isPlainObject, parseQuery } from './shared/query';
import {
  DEFAULT_NAMES,
  SEARCH_UNREACHABLE_HELP,
  SEARCH_UNSUPPORTED_HELP,
  SearchIndexType,
  definitionTypeMismatch,
  isSearchUnreachable,
  isSearchUnsupported,
  searchErrorText,
  searchIndexType,
} from './shared/searchIndexes';
import type { SearchIndexInfo } from './shared/messages';

const TYPES: SearchIndexType[] = ['search', 'vectorSearch'];

export async function loadSearchIndexes(coll: Collection): Promise<{ indexes: SearchIndexInfo[]; unsupported?: string; error?: string }> {
  try {
    const list = await coll.listSearchIndexes().toArray();
    return { indexes: list.map(toInfo) };
  } catch (err) {
    if (isSearchUnsupported(err)) return { indexes: [], unsupported: errorMessage(err) };
    return { indexes: [], error: explain(err).message };
  }
}

/** An index of $listSearchIndexes as the tab shows it; exported for the tests. */
export function toInfo(doc: Document): SearchIndexInfo {
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
    type: searchIndexType(raw),
    status: text(raw.status),
    queryable: typeof raw.queryable === 'boolean' ? raw.queryable : undefined,
    definition: isPlainObject(raw.latestDefinition) ? raw.latestDefinition : {},
    message: text(raw.message),
    hosts: hosts?.length ? hosts : undefined,
  };
}

/** The error of a command, said in terms of what the server lacks when it has no search or cannot reach mongot. */
function explain(err: unknown): Error {
  const message = searchErrorText(errorMessage(err));
  if (isSearchUnsupported(err)) return new Error(`${SEARCH_UNSUPPORTED_HELP}\n${message}`);
  if (isSearchUnreachable(err)) return new Error(`${SEARCH_UNREACHABLE_HELP}\n${message}`);
  return new Error(message);
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
  const mismatch = definitionTypeMismatch(type as SearchIndexType, value);
  if (mismatch) throw new Error(mismatch);
  const definition = fromRelaxed(value) as Document;
  try {
    if (original !== undefined) {
      await coll.updateSearchIndex(original, definition);
      return `Search index ${original}: the new definition is being built. Queries keep using the previous one until it is ready.`;
    }
    const indexName = name.trim() || DEFAULT_NAMES[type as SearchIndexType];
    // mongot takes a second index of the same name and definition without a word, and Atlas says the
    // name is taken in its own terms: the name is checked first (when the list can't be read, the
    // command says what is wrong).
    const taken = await coll.listSearchIndexes(indexName).toArray().then((l) => l.length > 0, () => false);
    if (taken) throw new Error(`A search index named ${indexName} already exists: open it in the list to change its definition, or choose another name.`);
    const created = await coll.createSearchIndex({ name: indexName, type, definition });
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
