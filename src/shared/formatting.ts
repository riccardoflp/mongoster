// Conditional formatting of the collection tab's table: the formatting rules of a collection (a condition in mongosh
// syntax, a color, the row or one field's cell), how they are read back from globalState, and which color each row
// and cell gets. Shared by the host (reading and storing the rules) and the webview (coloring the table).
// No vscode dependency.
import { MatchError, Predicate, compileFilter } from './match';
import { isPlainObject, parseQuery } from './query';

/** The six colors of connections, from the theme's chart colors. */
export const FORMAT_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type FormatColor = (typeof FORMAT_COLORS)[number];

/** Rules kept per collection at most: a guard against a runaway list, far above what a table can show. */
export const MAX_FORMAT_RULES = 100;

/** A formatting rule, as stored in `mongoster.formatting.<connection>/<database>/<collection>`. */
export interface FormatRule {
  /** Random and stable: what editing, reordering and removing refer to. */
  id: string;
  /** The filter in mongosh syntax, as the user typed it. */
  condition: string;
  /** The dotted path of the field whose cell is colored; absent: the whole row. */
  field?: string;
  color: FormatColor;
  /** Absent means on. */
  enabled?: false;
}

/** A new rule id: unique enough among the rules of one collection. */
export function newRuleId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * The rules stored under a collection's key, as any version may have written them: each entry with a string id, a
 * string condition and a known color is kept (with its field when it is a non-empty string, and `enabled: false`);
 * the other entries and unknown properties are dropped; anything that is not an array is no rules.
 */
export function readFormatRules(value: unknown): FormatRule[] {
  if (!Array.isArray(value)) return [];
  const out: FormatRule[] = [];
  const ids = new Set<string>();
  for (const v of value) {
    if (!isPlainObject(v)) continue;
    const { id, condition, field, color, enabled } = v;
    if (typeof id !== 'string' || !id || ids.has(id)) continue;
    if (typeof condition !== 'string') continue;
    if (typeof color !== 'string' || !(FORMAT_COLORS as readonly string[]).includes(color)) continue;
    const rule: FormatRule = { id, condition, color: color as FormatColor };
    if (typeof field === 'string' && field.trim()) rule.field = field.trim();
    if (enabled === false) rule.enabled = false;
    ids.add(id);
    out.push(rule);
    if (out.length >= MAX_FORMAT_RULES) break;
  }
  return out;
}

/** Why a condition can't be used, or undefined when it can: a syntax error, not a document, an unsupported operator. */
export function conditionError(text: string): string | undefined {
  try {
    compileCondition(text);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

function compileCondition(text: string): Predicate {
  if (!text.trim()) throw new MatchError('Type a condition, such as { status: "failed" }.');
  let filter: unknown;
  try {
    filter = parseQuery(text);
  } catch (err) {
    throw new MatchError(`Invalid syntax: ${(err as Error).message}`);
  }
  return compileFilter(filter);
}

/** A rule's field cell inside an expanded array: the array's path and the element's index. */
export interface ElementCell {
  array: string;
  index: number;
}

interface CompiledRule {
  rule: FormatRule;
  test: Predicate;
}

/**
 * Feature: query.format-table
 * The rules of a collection compiled for a page of documents: the first enabled row rule that matches a document
 * colors its row; the first enabled cell rule of a field that matches colors that field's cell, over the row's color.
 */
export class TableFormat {
  /** Why each invalid rule colors nothing, by rule id. */
  readonly errors = new Map<string, string>();
  private readonly rowRules: CompiledRule[] = [];
  private readonly cellRules = new Map<string, CompiledRule[]>();

  constructor(rules: FormatRule[]) {
    for (const rule of rules) {
      let test: Predicate;
      try {
        test = compileCondition(rule.condition);
      } catch (err) {
        this.errors.set(rule.id, (err as Error).message);
        continue;
      }
      if (rule.enabled === false) continue;
      if (rule.field) {
        const list = this.cellRules.get(rule.field) ?? [];
        list.push({ rule, test });
        this.cellRules.set(rule.field, list);
      } else {
        this.rowRules.push({ rule, test });
      }
    }
  }

  get empty(): boolean {
    return !this.rowRules.length && !this.cellRules.size;
  }

  /** The color of the document's row, if a row rule matches. */
  rowColor(doc: unknown): FormatColor | undefined {
    return first(this.rowRules, doc);
  }

  /**
   * The color of the cell of `field`, if a cell rule of that field matches. In an expanded array, the condition is
   * matched against the document with the array replaced by that one element, so that `{ "items.qty": { $gt: 5 } }`
   * colors only the elements over 5.
   */
  cellColor(doc: unknown, field: string, element?: ElementCell): FormatColor | undefined {
    const rules = this.cellRules.get(field);
    if (!rules) return undefined;
    return first(rules, element ? withElement(doc, element) : doc);
  }
}

function first(rules: CompiledRule[], doc: unknown): FormatColor | undefined {
  for (const { rule, test } of rules) {
    try {
      if (test(doc)) return rule.color;
    } catch {
      // A value the matcher can't read colors nothing rather than breaking the table.
    }
  }
  return undefined;
}

/** A copy of `doc` whose array at `element.array` is replaced by that one element. */
export function withElement(doc: unknown, element: ElementCell): unknown {
  const path = element.array.split('.');
  const replace = (value: unknown, i: number): unknown => {
    if (!isPlainObject(value) || !(path[i] in value)) return value;
    const inner = value[path[i]];
    if (i === path.length - 1) return { ...value, [path[i]]: Array.isArray(inner) ? inner[element.index] : inner };
    return { ...value, [path[i]]: replace(inner, i + 1) };
  };
  return replace(doc, 0);
}
