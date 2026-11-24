// What a field rule of conditional formatting gives a value: green and red for booleans, a place on a color scale
// for numbers and dates, one color per distinct value for the rest, with the values the user pinned to a color and the
// palette the others take theirs from. Also the legend of a rule over a page of documents. The values are relaxed
// Extended JSON plain objects, as the table has them.
// No vscode dependency.
import { MISSING, getAt } from './columns';
import { PRESET_COLORS } from './colors';
import type { FieldRule, FormatColor, FormatPaint } from './formatting';
import { isPlainObject, toShell } from './query';

/** How a field rule colors, once `auto` is decided from the values. */
export type FieldMode = 'boolean' | 'scale' | 'values';

/** The colors distinct values take with the palette `all`: the presets less gray, which reads as no color. */
export const VALUE_COLORS: readonly FormatColor[] = PRESET_COLORS.filter((c) => c !== 'gray');

/** The strengths of the shades of one color, from the faintest. */
export const SHADES: readonly number[] = [0.1, 0.325, 0.55, 0.775, 1];

/** The strength of a scale between two colors, and of the colors of booleans. */
const FLAT = 0.6;

const NUMBER_KEYS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'];

/** A number, plain or wrapped, as a JavaScript number (Int64 and decimals are rounded beyond 15 digits). */
function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (!isPlainObject(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1 || !NUMBER_KEYS.includes(keys[0])) return undefined;
  const n = Number(v[keys[0]]);
  return Number.isFinite(n) ? n : undefined;
}

/** The milliseconds of a date; undefined for anything else. */
function dateOf(v: unknown): number | undefined {
  if (!isPlainObject(v) || v.$date === undefined || Object.keys(v).length !== 1) return undefined;
  const d = v.$date;
  const ms = typeof d === 'string' ? new Date(d).getTime() : isPlainObject(d) ? Number(d.$numberLong) : Number(d);
  return Number.isFinite(ms) ? ms : undefined;
}

/** What a scale places: a number, or a date as its milliseconds. */
export function scalarOf(v: unknown): number | undefined {
  return numberOf(v) ?? dateOf(v);
}

const isAbsent = (v: unknown) => v === MISSING || v === undefined || v === null;

/** The value of `field` in a document; undefined when it is missing, null, or behind an array. */
export function valueAt(doc: unknown, field: string): unknown {
  const v = getAt(doc, field.split('.'));
  return isAbsent(v) ? undefined : v;
}

/**
 * The values of `field` in a document, one per element when the path goes through arrays of sub-documents (as the
 * table shows them once the array is expanded); missing and null are left out.
 */
export function valuesOf(doc: unknown, field: string): unknown[] {
  const out: unknown[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (!path.length) {
      if (!isAbsent(value)) out.push(value);
    } else if (Array.isArray(value)) {
      for (const element of value) walk(element, path);
    } else if (isPlainObject(value) && path[0] in value) {
      walk(value[path[0]], path.slice(1));
    }
  };
  walk(doc, field.split('.'));
  return out;
}

/** The text a value is known by in a rule and shown with in the legend: its mongosh form on one line. */
export function valueText(value: unknown): string {
  return toShell(value);
}

/**
 * Feature: query.format-field
 * The mode `auto` takes for these values: `boolean` when all are booleans, `scale` when all are numbers or all are
 * dates, `values` otherwise and when there is none.
 */
export function fieldMode(values: unknown[]): FieldMode {
  if (!values.length) return 'values';
  if (values.every((v) => typeof v === 'boolean')) return 'boolean';
  if (values.every((v) => numberOf(v) !== undefined) || values.every((v) => dateOf(v) !== undefined)) return 'scale';
  return 'values';
}

/** A field rule with `auto` decided and the ends of its scale known, for a page of documents. */
export interface ResolvedField {
  mode: FieldMode;
  /** Scale: the two ends, the rule's own or, for the ones it lacks, the page's. */
  min?: number;
  max?: number;
  /** Scale: the values are dates, and the ends their milliseconds. */
  dates?: boolean;
}

export function resolveField(rule: FieldRule, docs: unknown[]): ResolvedField {
  const values = docs.flatMap((d) => valuesOf(d, rule.field));
  const mode = rule.mode === 'auto' ? fieldMode(values) : rule.mode;
  if (mode !== 'scale') return { mode };
  const scalars = values.map(scalarOf).filter((n): n is number => n !== undefined);
  const dates = values.some((v) => dateOf(v) !== undefined) && !values.some((v) => numberOf(v) !== undefined);
  const min = rule.min ?? (scalars.length ? Math.min(...scalars) : undefined);
  const max = rule.max ?? (scalars.length ? Math.max(...scalars) : undefined);
  return { mode, min, max, ...(dates && { dates }) };
}

/** FNV-1a, 32 bits: the same color for the same text everywhere. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The colors the values that are not pinned take: the shades of the palette's color, or the ten colors less the ones
 * pinned values use (all ten when every one is used).
 */
export function paletteOf(rule: FieldRule): FormatPaint[] {
  if (rule.palette && rule.palette !== 'all') return SHADES.map((strength) => ({ color: rule.palette as FormatColor, strength }));
  const taken = new Set((rule.pinned ?? []).map((p) => p.color));
  const free = VALUE_COLORS.filter((c) => !taken.has(c));
  return (free.length ? free : VALUE_COLORS).map((color) => ({ color }));
}

function textPaint(rule: FieldRule, text: string, palette = paletteOf(rule)): FormatPaint {
  const pin = rule.pinned?.find((p) => p.value === text);
  // Among the shades of its own color, a pinned value is told apart by an outline.
  if (pin) return { color: pin.color, strength: 1, ...(pin.color === rule.palette && { outlined: true }) };
  return palette[hash(text) % palette.length];
}

/**
 * Feature: query.format-field
 * The color a field rule gives a value, or undefined when it gives none: a missing or null value, a value of another
 * type than the mode's, a scale without ends.
 */
export function fieldPaint(rule: FieldRule, resolved: ResolvedField, value: unknown): FormatPaint | undefined {
  if (isAbsent(value)) return undefined;
  if (resolved.mode === 'boolean') {
    if (typeof value !== 'boolean') return undefined;
    return { color: value ? (rule.scale?.to ?? 'green') : (rule.scale?.from ?? 'red'), strength: FLAT };
  }
  if (resolved.mode === 'scale') {
    const n = scalarOf(value);
    const { min, max } = resolved;
    if (n === undefined || min === undefined || max === undefined) return undefined;
    const t = max > min ? Math.min(1, Math.max(0, (n - min) / (max - min))) : 1;
    const to = rule.scale?.to ?? 'blue';
    const from = rule.scale?.from;
    if (!from) return { color: to, strength: t };
    return t < 0.5
      ? { color: from, toward: { color: 'yellow', share: t * 2 }, strength: FLAT }
      : { color: 'yellow', toward: { color: to, share: (t - 0.5) * 2 }, strength: FLAT };
  }
  return textPaint(rule, valueText(value));
}

export interface LegendEntry {
  /** The value in mongosh syntax. */
  text: string;
  /** How many values of the page are this one. */
  count: number;
  paint: FormatPaint;
  pinned: boolean;
}

/** What a field rule shows of itself for a page: its values with their colors, or the ends of its scale. */
export interface Legend extends ResolvedField {
  /** The pinned values first, then the page's by how many there are. Empty for a scale. */
  entries: LegendEntry[];
  /** How many colors the values that are not pinned share; more values than this and the colors repeat. */
  colors: number;
}

/** At most this many values are listed; the others are still colored. */
export const MAX_LEGEND = 60;

export function fieldLegend(rule: FieldRule, docs: unknown[]): Legend {
  const resolved = resolveField(rule, docs);
  if (resolved.mode === 'scale') return { ...resolved, entries: [], colors: 0 };
  const counts = new Map<string, { count: number; value: unknown }>();
  for (const doc of docs) {
    for (const value of valuesOf(doc, rule.field)) {
      if (resolved.mode === 'boolean' && typeof value !== 'boolean') continue;
      const text = valueText(value);
      const seen = counts.get(text);
      if (seen) seen.count++;
      else counts.set(text, { count: 1, value });
    }
  }
  if (resolved.mode === 'boolean') {
    const entries = [true, false].map((value) => ({
      text: String(value),
      count: counts.get(String(value))?.count ?? 0,
      paint: fieldPaint(rule, resolved, value)!,
      pinned: false,
    }));
    return { ...resolved, entries, colors: 2 };
  }
  const palette = paletteOf(rule);
  const pins = rule.pinned ?? [];
  const pinned = pins.map((p) => ({ text: p.value, count: counts.get(p.value)?.count ?? 0, paint: textPaint(rule, p.value, palette), pinned: true }));
  const others = [...counts]
    .filter(([text]) => !pins.some((p) => p.value === text))
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .map(([text, { count }]) => ({ text, count, paint: textPaint(rule, text, palette), pinned: false }));
  return { ...resolved, entries: [...pinned, ...others], colors: palette.length };
}
