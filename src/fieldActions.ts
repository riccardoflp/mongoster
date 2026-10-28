// The writes behind the column actions (Rename field, Remove field, Convert type): which documents they
// touch and how, for the documents matching the user's filter. Pure: the panel counts, confirms and runs them.
import type { Document } from 'mongodb';

/** The documents to write and the update; `reached` also counts those left out because of arrays. */
export interface FieldOperation {
  filter: Document;
  update: Document | Document[];
  /** The documents matching the user's filter that have the field, arrays or not. */
  reached: Document;
}

export const CONVERT_TYPES: { type: string; description: string }[] = [
  { type: 'string', description: 'Numbers, dates (ISO), ObjectIds and booleans as text' },
  { type: 'int', description: '32-bit integer: decimals are truncated, integer text is parsed' },
  { type: 'long', description: '64-bit integer: decimals are truncated, integer text is parsed, dates become milliseconds' },
  { type: 'double', description: 'Floating point number; numeric text is parsed' },
  { type: 'decimal', description: 'Decimal128, exact decimals; numeric text is parsed' },
  { type: 'bool', description: 'Numbers: 0 is false; any text, even "false", is true' },
  { type: 'date', description: 'ISO text ("2024-03-15", "2024-03-15T10:00:00Z"), milliseconds (long, double), ObjectId' },
  { type: 'objectId', description: '24 hexadecimal characters' },
];

/** Why `path` (dotted) can't be a field these actions change. */
export function fieldPathError(path: string): string | undefined {
  if (!path) return 'Enter a field name';
  const segments = path.split('.');
  if (segments.some((s) => !s)) return `"${path}" has an empty part: write names separated by single dots`;
  if (segments.some((s) => s.startsWith('$'))) return "Field names can't start with $";
  if (segments[0] === '_id') return "_id can't be changed";
  return undefined;
}

/** Why `from` can't be renamed to `to`. */
export function renameError(from: string, to: string): string | undefined {
  const invalid = fieldPathError(to);
  if (invalid) return invalid;
  if (to === from) return 'Enter a different name';
  if (to.startsWith(`${from}.`) || from.startsWith(`${to}.`)) return `${from} and ${to} are on the same path: a field can't be moved inside itself or its parent`;
  return undefined;
}

/**
 * Conditions keeping out the documents where a parent of `path` is an array: an update by dotted path
 * can't go through it ($rename fails, $unset does nothing, $set would write into every element).
 */
export function noArrayParents(path: string): Document[] {
  const segments = path.split('.');
  return segments.slice(0, -1).map((_, i) => ({ [segments.slice(0, i + 1).join('.')]: { $not: { $type: 'array' } } }));
}

/** All the conditions, without the empty ones. */
export function and(...parts: Document[]): Document {
  const list = parts.filter((p) => Object.keys(p).length);
  return list.length === 0 ? {} : list.length === 1 ? list[0] : { $and: list };
}

/** $rename of `from` to `to` in the documents that have it. */
export function renameField(filter: Document, from: string, to: string): FieldOperation & { overwrites: Document } {
  const reached = and(filter, { [from]: { $exists: true } });
  const target = and(reached, ...noArrayParents(from), ...noArrayParents(to));
  return { filter: target, update: { $rename: { [from]: to } }, reached, overwrites: and(target, { [to]: { $exists: true } }) };
}

/**
 * $unset of `field`; `array`: the array whose elements have it (`items` for `items.sku`), removed from
 * every element with `items.$[].sku`.
 */
export function removeField(filter: Document, field: string, array?: string): FieldOperation {
  const reached = and(filter, { [field]: { $exists: true } });
  if (!array) return { filter: and(reached, ...noArrayParents(field)), update: { $unset: { [field]: '' } }, reached };
  const inside = field.slice(array.length + 1);
  return {
    // $[] fails on a document where the array isn't one.
    filter: and(reached, ...noArrayParents(array), { [array]: { $type: 'array' } }),
    update: { $unset: { [`${array}.$[].${inside}`]: '' } },
    reached,
  };
}

/** The documents where `field` isn't yet of `type`; null and arrays are left as they are. */
function notYet(field: string, type: string): Document {
  return { [field]: { $exists: true, $not: { $type: [type, 'null', 'array'] } } };
}

/**
 * Pipeline update converting `field` to `type` with $convert; values that can't be converted keep their
 * value and type. `filter` (counted again afterwards) finds the values still to convert.
 */
export function convertField(filter: Document, field: string, type: string): FieldOperation {
  const ref = `$${field}`;
  return {
    filter: and(filter, ...noArrayParents(field), notYet(field, type)),
    update: [{ $set: { [field]: { $convert: { input: ref, to: type, onError: ref, onNull: ref } } } }],
    reached: and(filter, notYet(field, type)),
  };
}

/** Pipeline counting the BSON types of `field` in the documents of `filter` that have it, most frequent first. */
export function typeCounts(filter: Document, field: string): Document[] {
  return [
    { $match: and(filter, ...noArrayParents(field), { [field]: { $exists: true } }) },
    { $group: { _id: { $type: `$${field}` }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ];
}
