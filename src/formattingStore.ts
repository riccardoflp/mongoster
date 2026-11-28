// Where the formatting rules are kept in globalState, by scope: a collection's, a database's, a connection's and the
// global ones, with the scopes a collection has turned off. Reading what reaches a collection, writing a scope, which
// collections a scope reaches, forgetting a removed connection's rules and giving them to a copy of a connection.
// No vscode dependency beyond the Memento's type.
import type { Memento } from 'vscode';
import { FORMAT_SCOPES, FormatRule, FormatScope, ScopedRules, readFormatRules, readScopesOff } from './shared/formatting';

/** A collection, as the keys name it. */
export interface FormatPlace {
  connectionId: string;
  database: string;
  collection: string;
}

/** The key of a scope's rules for a collection. The collection's own is the one 0.9.0 wrote. */
export function formattingKey(scope: FormatScope, place: FormatPlace): string {
  if (scope === 'collection') return `mongoster.formatting.${place.connectionId}/${place.database}/${place.collection}`;
  if (scope === 'database') return `mongoster.formattingDatabase.${place.connectionId}/${place.database}`;
  if (scope === 'connection') return `mongoster.formattingConnection.${place.connectionId}`;
  return 'mongoster.formattingGlobal';
}

/** The key of the scopes a collection has turned off. */
export const formattingOffKey = (place: FormatPlace) => `mongoster.formattingOff.${place.connectionId}/${place.database}/${place.collection}`;

/** The rules of the four scopes that reach a collection. */
export function readFormatting(state: Pick<Memento, 'get'>, place: FormatPlace): ScopedRules {
  const rules = {} as ScopedRules;
  for (const scope of FORMAT_SCOPES) rules[scope] = readFormatRules(state.get(formattingKey(scope, place)));
  return rules;
}

/** Stores a scope's rules, in their order; the key is removed when there is none. */
export async function writeFormatting(state: Pick<Memento, 'update'>, place: FormatPlace, scope: FormatScope, rules: FormatRule[]): Promise<void> {
  await state.update(formattingKey(scope, place), rules.length ? rules : undefined);
}

export function readFormattingOff(state: Pick<Memento, 'get'>, place: FormatPlace): FormatScope[] {
  return readScopesOff(state.get(formattingOffKey(place)));
}

export async function writeFormattingOff(state: Pick<Memento, 'update'>, place: FormatPlace, off: FormatScope[]): Promise<void> {
  await state.update(formattingOffKey(place), off.length ? off : undefined);
}

/** Whether the rules of `scope` changed for `from` are also the ones `other` sees. */
export function scopeReaches(scope: FormatScope, from: FormatPlace, other: FormatPlace): boolean {
  if (scope === 'global') return true;
  if (other.connectionId !== from.connectionId) return false;
  if (scope === 'connection') return true;
  if (other.database !== from.database) return false;
  return scope === 'database' || other.collection === from.collection;
}

/**
 * Forgets the rules of a removed connection and of its databases. Its collections' own rules stay, like their
 * layouts and saved queries.
 */
export async function removeConnectionFormatting(state: Pick<Memento, 'keys' | 'update'>, connectionId: string): Promise<void> {
  const database = `mongoster.formattingDatabase.${connectionId}/`;
  for (const key of state.keys()) {
    if (key === `mongoster.formattingConnection.${connectionId}` || key.startsWith(database)) await state.update(key, undefined);
  }
}

/**
 * Gives the copy of a connection the rules of the connection and of its databases. Its collections' own rules
 * aren't copied, like their layouts and saved queries.
 */
export async function copyConnectionFormatting(state: Pick<Memento, 'keys' | 'get' | 'update'>, from: string, to: string): Promise<void> {
  const connection = `mongoster.formattingConnection.${from}`;
  const database = `mongoster.formattingDatabase.${from}/`;
  for (const key of state.keys()) {
    if (key === connection) await state.update(`mongoster.formattingConnection.${to}`, state.get(key));
    else if (key.startsWith(database)) await state.update(`mongoster.formattingDatabase.${to}/${key.slice(database.length)}`, state.get(key));
  }
}
