// Conditional formatting of the collection tab's table: the formatting rules of a collection (a condition rule: a
// condition in mongosh syntax, a color, the row or one field's cell; a field rule: a field whose values choose the
// color), how they are read back from globalState, which color each row and cell gets, and the state of the
// Formatting pane. Shared by the host (reading and storing the rules) and the webview (coloring the table).
// No vscode dependency.
import { PRESET_COLORS, PresetColor, isPreset } from './colors';
import { FieldMode, fieldPaint, resolveField, valueAt } from './formatField';
import { MatchError, Predicate, compileFilter } from './match';
import { isPlainObject, parseQuery } from './query';

/** The colors of formatting: the eleven presets of connections and collections (D17), theme colors all of them. */
export const FORMAT_COLORS = PRESET_COLORS;
export type FormatColor = PresetColor;

/** Rules kept per collection at most: a guard against a runaway list, far above what a table can show. */
export const MAX_FORMAT_RULES = 100;
/** Values pinned to a color in one field rule at most. */
export const MAX_PINNED = 100;
const MAX_NAME = 200;

interface RuleBase {
  /** Random and stable: what editing, reordering and removing refer to. */
  id: string;
  /** What the Formatting pane shows for the rule; absent: its condition or its field. */
  name?: string;
  /** Absent means on. */
  enabled?: false;
}

/** Colors the row or one field's cell of the documents matching a condition. Without `kind`: what 0.9.0 wrote. */
export interface ConditionRule extends RuleBase {
  kind?: 'condition';
  /** The filter in mongosh syntax, as the user typed it. */
  condition: string;
  /** The dotted path of the field whose cell is colored; absent: the whole row. */
  field?: string;
  color: FormatColor;
}

/** Colors by the values of one field, with no condition: see src/shared/formatField.ts. */
export interface FieldRule extends RuleBase {
  kind: 'field';
  /** The dotted path whose values choose the color. */
  field: string;
  /** What is colored: the whole row, or that field's cell. */
  target: 'row' | 'cell';
  /** `auto`: decided from the values of the page. */
  mode: 'auto' | FieldMode;
  /** Scale: the two ends, as numbers (a date is its milliseconds); the page's when absent. */
  min?: number;
  max?: number;
  /**
   * Scale: with `to` alone, that color growing stronger; with `from` too, from one to the other through yellow.
   * Boolean: `to` is the color of true, `from` of false.
   */
  scale?: { from?: FormatColor; to: FormatColor };
  /** Values: the colors the user fixed, by the value's mongosh text. */
  pinned?: { value: string; color: FormatColor }[];
  /** Values: where the other values take their color. Absent: `all`. A color: the shades of that color. */
  palette?: 'all' | FormatColor;
}

/** A formatting rule, as stored in `mongoster.formatting.<connection>/<database>/<collection>`. */
export type FormatRule = ConditionRule | FieldRule;

export function isFieldRule(rule: FormatRule): rule is FieldRule {
  return rule.kind === 'field';
}

/** What a rule gives a row or a cell. */
export interface FormatPaint {
  color: FormatColor;
  /** How strong the color is over the background, from 0 to 1; absent: the usual strength of a row or a cell. */
  strength?: number;
  /** The color is on its way to another one: `share` of it, from 0 to 1. */
  toward?: { color: FormatColor; share: number };
  /** Drawn with an outline: a pinned value among the shades of its own color. */
  outlined?: boolean;
}

/** How much of a color is mixed over the background, in percent: rows are fainter than cells, so a cell reads on a row. */
const LEVELS = { row: { plain: 12, low: 4, high: 22 }, cell: { plain: 28, low: 6, high: 45 } } as const;

/** The percent of a paint's color over the background of a row or a cell. */
export function paintLevel(paint: FormatPaint, target: 'row' | 'cell'): number {
  const { plain, low, high } = LEVELS[target];
  return paint.strength === undefined ? plain : Math.round(low + (high - low) * Math.min(1, Math.max(0, paint.strength)));
}

/** What the pane shows for a rule without a name: its condition, or its field, on one line. */
export function ruleSummary(rule: FormatRule): string {
  return isFieldRule(rule) ? `by ${rule.field}` : rule.condition.replace(/\s+/g, ' ');
}

/** A new rule id: unique enough among the rules of one collection. */
export function newRuleId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const isFormatColor = (v: unknown): v is FormatColor => isPreset(v);
const FIELD_MODES: readonly string[] = ['auto', 'boolean', 'scale', 'values'];

/**
 * The rules stored under a collection's key, as any version may have written them. A condition rule is kept with a
 * string id, a string condition and a known color (with its field when it is a non-empty string); a field rule
 * (`kind: 'field'`) with a string id and a non-empty field, its target and mode falling back to `cell` and `auto`,
 * and what it can use of its scale, pinned values and palette. A name and `enabled: false` are kept for both. The
 * other entries, the kinds it does not know and unknown properties are dropped; anything that is not an array is no
 * rules.
 */
export function readFormatRules(value: unknown): FormatRule[] {
  if (!Array.isArray(value)) return [];
  const out: FormatRule[] = [];
  const ids = new Set<string>();
  for (const v of value) {
    if (!isPlainObject(v)) continue;
    const { id, kind, name, enabled } = v;
    if (typeof id !== 'string' || !id || ids.has(id)) continue;
    const rule = kind === 'field' ? readFieldRule(id, v) : kind === undefined || kind === 'condition' ? readConditionRule(id, v) : undefined;
    if (!rule) continue;
    if (typeof name === 'string' && name.trim()) rule.name = name.trim().slice(0, MAX_NAME);
    if (enabled === false) rule.enabled = false;
    ids.add(id);
    out.push(rule);
    if (out.length >= MAX_FORMAT_RULES) break;
  }
  return out;
}

function readConditionRule(id: string, v: Record<string, unknown>): ConditionRule | undefined {
  const { condition, field, color } = v;
  if (typeof condition !== 'string' || !isFormatColor(color)) return undefined;
  const rule: ConditionRule = { id, condition, color };
  if (typeof field === 'string' && field.trim()) rule.field = field.trim();
  return rule;
}

function readFieldRule(id: string, v: Record<string, unknown>): FieldRule | undefined {
  const { field, target, mode, min, max, scale, pinned, palette } = v;
  if (typeof field !== 'string' || !field.trim()) return undefined;
  const rule: FieldRule = {
    id,
    kind: 'field',
    field: field.trim(),
    target: target === 'row' ? 'row' : 'cell',
    mode: typeof mode === 'string' && FIELD_MODES.includes(mode) ? (mode as FieldRule['mode']) : 'auto',
  };
  if (typeof min === 'number' && Number.isFinite(min)) rule.min = min;
  if (typeof max === 'number' && Number.isFinite(max)) rule.max = max;
  if (isPlainObject(scale) && isFormatColor(scale.to)) rule.scale = { ...(isFormatColor(scale.from) && { from: scale.from }), to: scale.to };
  if (Array.isArray(pinned)) {
    const pins: NonNullable<FieldRule['pinned']> = [];
    for (const p of pinned) {
      if (!isPlainObject(p) || typeof p.value !== 'string' || !isFormatColor(p.color)) continue;
      if (pins.some((q) => q.value === p.value)) continue;
      pins.push({ value: p.value, color: p.color });
      if (pins.length >= MAX_PINNED) break;
    }
    if (pins.length) rule.pinned = pins;
  }
  if (isFormatColor(palette)) rule.palette = palette;
  return rule;
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

/** What a rule gives a document, or the document with an array replaced by one element. */
type Painter = (doc: unknown) => FormatPaint | undefined;

/**
 * Feature: query.format-table
 * The rules of a collection compiled for a page of documents: the first enabled row rule that gives a document a
 * color colors its row; the first enabled cell rule of a field that gives one colors that field's cell, over the
 * row's color. A condition rule gives its color to the documents it matches; a field rule gives the color of the
 * field's value, and none when the field is missing. The page decides what `auto` is and the ends of a scale that
 * has none of its own.
 */
export class TableFormat {
  /** Why each invalid rule colors nothing, by rule id. */
  readonly errors = new Map<string, string>();
  private readonly rowRules: Painter[] = [];
  private readonly cellRules = new Map<string, Painter[]>();

  constructor(rules: FormatRule[], docs: unknown[] = []) {
    for (const rule of rules) {
      let paint: Painter;
      if (isFieldRule(rule)) {
        const resolved = resolveField(rule, docs);
        paint = (doc) => fieldPaint(rule, resolved, valueAt(doc, rule.field));
      } else {
        let test: Predicate;
        try {
          test = compileCondition(rule.condition);
        } catch (err) {
          this.errors.set(rule.id, (err as Error).message);
          continue;
        }
        paint = (doc) => (test(doc) ? { color: rule.color } : undefined);
      }
      if (rule.enabled === false) continue;
      const field = isFieldRule(rule) ? (rule.target === 'cell' ? rule.field : undefined) : rule.field;
      if (field) {
        const list = this.cellRules.get(field) ?? [];
        list.push(paint);
        this.cellRules.set(field, list);
      } else {
        this.rowRules.push(paint);
      }
    }
  }

  get empty(): boolean {
    return !this.rowRules.length && !this.cellRules.size;
  }

  /** The color of the document's row, if a row rule gives one. */
  rowPaint(doc: unknown): FormatPaint | undefined {
    return first(this.rowRules, doc);
  }

  /**
   * The color of the cell of `field`, if a cell rule of that field gives one. In an expanded array, the rule sees
   * the document with the array replaced by that one element, so that `{ "items.qty": { $gt: 5 } }` colors only the
   * elements over 5 and a field rule colors each element by its own value.
   */
  cellPaint(doc: unknown, field: string, element?: ElementCell): FormatPaint | undefined {
    const rules = this.cellRules.get(field);
    if (!rules) return undefined;
    return first(rules, element ? withElement(doc, element) : doc);
  }
}

function first(rules: Painter[], doc: unknown): FormatPaint | undefined {
  for (const paint of rules) {
    try {
      const p = paint(doc);
      if (p) return p;
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

/** The Formatting pane, for every collection's tab: kept in `mongoster.formattingPane`. */
export interface FormattingPane {
  open: boolean;
  /** Width in CSS pixels. */
  width: number;
  /** `Hide Formatting`: no color in any table, the rules untouched. */
  hidden: boolean;
}

export const FORMATTING_PANE_WIDTH = { min: 240, max: 700, default: 320 } as const;

/** The stored state of the pane; anything missing or of another form gives closed, 320 px, colors shown. */
export function readFormattingPane(value: unknown): FormattingPane {
  const o = isPlainObject(value) ? value : {};
  const width = typeof o.width === 'number' && Number.isFinite(o.width) ? o.width : FORMATTING_PANE_WIDTH.default;
  return {
    open: o.open === true,
    width: Math.round(Math.min(FORMATTING_PANE_WIDTH.max, Math.max(FORMATTING_PANE_WIDTH.min, width))),
    hidden: o.hidden === true,
  };
}
