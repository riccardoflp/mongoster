// The file formatting rules are exported to and imported from, to share them: JSON with one group of rules per scope.
// Nothing of a connection is written (no id, no name, no host); the names of the database and the collection are, to
// say where the rules came from. Reading it trusts nothing: every rule goes through readFormatRules, and a condition
// stays text, parsed as a filter when a table is painted. Also adding imported rules to the ones already there.
// No vscode dependency.
import { FORMAT_SCOPES, FormatRule, FormatScope, MAX_FORMAT_RULES, ScopedRules, isFormatScope, readFormatRules } from './formatting';
import { isPlainObject } from './query';

/** The version of the file's form, in its `mongosterFormatting` property. */
export const FORMATTING_FILE_VERSION = 1;
/** A larger file is not read. */
export const MAX_FORMATTING_FILE = 1_000_000;
export const FORMATTING_FILE_SUFFIX = '.mongoster-formatting.json';

export interface FormattingGroup {
  scope: FormatScope;
  /** Where a database's or a collection's rules came from. */
  database?: string;
  collection?: string;
  rules: FormatRule[];
}

/** The widest scope first: the file reads from what applies everywhere to what applies to one collection. */
const FILE_ORDER: FormatScope[] = [...FORMAT_SCOPES].reverse();

/**
 * Feature: query.format-transfer
 * The file's text for the chosen scopes of the rules that reach a collection; a scope without rules is left out.
 */
export function formattingFile(rules: ScopedRules, scopes: readonly FormatScope[], place: { database: string; collection: string }): string {
  const groups: FormattingGroup[] = [];
  for (const scope of FILE_ORDER) {
    if (!scopes.includes(scope) || !rules[scope].length) continue;
    groups.push({
      scope,
      ...((scope === 'database' || scope === 'collection') && { database: place.database }),
      ...(scope === 'collection' && { collection: place.collection }),
      rules: rules[scope],
    });
  }
  return `${JSON.stringify({ mongosterFormatting: FORMATTING_FILE_VERSION, groups }, null, 2)}\n`;
}

export interface FormattingFile {
  groups: FormattingGroup[];
  /** Rules of the file that could not be used. */
  dropped: number;
}

/**
 * Feature: query.format-transfer
 * The groups of a file's text, each with the rules that can be used, or why the file can't be read. A group of an
 * unknown scope, or without rules, is left out and its entries counted as dropped.
 */
export function readFormattingFile(text: string): FormattingFile | { error: string } {
  if (text.length > MAX_FORMATTING_FILE) return { error: 'The file is larger than 1 MB: it is not a file of formatting rules.' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { error: `The file is not JSON: ${(err as Error).message}` };
  }
  if (!isPlainObject(value) || typeof value.mongosterFormatting !== 'number' || !Array.isArray(value.groups)) {
    return { error: 'The file is not a file of formatting rules exported from Mongoster.' };
  }
  if (value.mongosterFormatting > FORMATTING_FILE_VERSION) return { error: 'The file was exported by a newer Mongoster: update Mongoster to import it.' };
  const groups: FormattingGroup[] = [];
  let dropped = 0;
  for (const g of value.groups) {
    const entries = isPlainObject(g) && Array.isArray(g.rules) ? g.rules.length : 0;
    if (!isPlainObject(g) || !isFormatScope(g.scope)) {
      dropped += entries;
      continue;
    }
    const rules = readFormatRules(g.rules);
    dropped += entries - rules.length;
    if (!rules.length) continue;
    groups.push({
      scope: g.scope,
      ...(typeof g.database === 'string' && g.database && { database: g.database.slice(0, 200) }),
      ...(typeof g.collection === 'string' && g.collection && { collection: g.collection.slice(0, 200) }),
      rules,
    });
  }
  return { groups, dropped };
}

/** What a group is called when the user chooses what to import. */
export function groupLabel(group: FormattingGroup): string {
  if (group.scope === 'global') return 'Everywhere';
  if (group.scope === 'connection') return 'A connection';
  if (group.scope === 'database') return group.database ? `Database ${group.database}` : 'A database';
  return group.collection ? `Collection ${group.database ? `${group.database}.` : ''}${group.collection}` : 'A collection';
}

const sameRule = ({ id: _, ...a }: FormatRule, { id: __, ...b }: FormatRule) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Feature: query.format-transfer
 * Adds imported rules after the ones a scope already has, each with a new id. A rule equal to one already there (all
 * but its id) is skipped; nothing is replaced; what would pass the limit of a scope is left out.
 */
export function mergeImport(existing: FormatRule[], incoming: FormatRule[], newId: () => string): { rules: FormatRule[]; added: number; already: number; over: number } {
  const rules = [...existing];
  let added = 0;
  let already = 0;
  let over = 0;
  for (const rule of incoming) {
    if (rules.some((r) => sameRule(r, rule))) already++;
    else if (rules.length >= MAX_FORMAT_RULES) over++;
    else {
      rules.push({ ...rule, id: newId() });
      added++;
    }
  }
  return { rules, added, already, over };
}

/** What the user reads after an import. */
export function importSummary(added: number, already: number, dropped: number, over: number): string {
  const n = (count: number, what: string) => `${count} ${what}${count === 1 ? '' : 's'}`;
  const parts = [`Imported ${n(added, 'formatting rule')}`];
  if (already) parts[0] += `, ${already} ${already === 1 ? 'was' : 'were'} already there`;
  if (dropped) parts.push(`${n(dropped, 'rule')} could not be read`);
  if (over) parts.push(`${n(over, 'rule')} did not fit: a scope keeps at most ${MAX_FORMAT_RULES}`);
  return `${parts.join('. ')}.`;
}
