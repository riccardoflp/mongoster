// CSV export (documents flattened like the grid) and import (CSV rows -> relaxed EJSON documents).
import { ColumnNode, MISSING, getAt, isSubdocument, leaves } from './columns';
import { isEjsonWrapper } from './query';

/**
 * Header + rows for `docs` (relaxed EJSON) with the grid's columns: one column per leaf, and one
 * row per element of expanded arrays, with the document's other values repeated on each row.
 */
export function csvTable(docs: Record<string, unknown>[], columns: ColumnNode[]): string[][] {
  const leafList = leaves(columns);
  const firstLeaf = new Map<ColumnNode, number>();
  let n = 0;
  const index = (nodes: ColumnNode[]) => {
    for (const node of nodes) {
      firstLeaf.set(node, n);
      if (node.children) index(node.children);
      else n++;
    }
  };
  index(columns);

  const table: string[][] = [leafList.map((l) => l.node.key)];
  for (const doc of docs) {
    const rows: string[][] = [Array(leafList.length).fill('')];
    const row = (i: number) => (rows[i] ??= Array(leafList.length).fill(''));
    // `at` = the sub-row of an array element, or null for document-level values (repeated on every row).
    const values: { at: number | null; col: number; value: unknown }[] = [];
    const walk = (nodes: ColumnNode[], source: unknown, base: number, at: number | null) => {
      for (const node of nodes) {
        const value = getAt(source, node.path.slice(base));
        if (node.children && isSubdocument(value)) walk(node.children, source, base, at);
        else if (node.children && node.array && at === null && Array.isArray(value) && value.length) {
          value.forEach((element, i) => {
            if (isSubdocument(element)) walk(node.children!, element, node.path.length, i);
            else values.push({ at: i, col: firstLeaf.get(node)!, value: element });
            row(i);
          });
        } else values.push({ at, col: firstLeaf.get(node)!, value });
      }
    };
    walk(columns, doc, 0, null);
    for (const { at, col, value } of values) {
      const text = csvValue(value);
      if (at === null) rows.forEach((r) => (r[col] = text));
      else row(at)[col] = text;
    }
    table.push(...rows);
  }
  return table;
}

/** Spreadsheet-friendly text for a relaxed EJSON value. */
export function csvValue(v: unknown): string {
  if (v === MISSING || v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isEjsonWrapper(v)) {
    const [key, inner] = Object.entries(v)[0];
    if (key === '$oid' || key === '$numberDecimal' || key === '$numberLong' || key === '$numberInt' || key === '$numberDouble') {
      return String(inner);
    }
    if (key === '$date') {
      if (typeof inner === 'string') return inner;
      const ms = Number((inner as { $numberLong?: string }).$numberLong);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : JSON.stringify(v);
    }
  }
  return JSON.stringify(v);
}

export function toCsv(table: string[][]): string {
  const cell = (s: string) => (/[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return table.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** RFC 4180 parsing (quoted fields, "" escapes, CRLF/LF, optional BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * CSV rows (header first) -> relaxed EJSON documents. Dotted headers build sub-documents; empty
 * cells are left out. Numbers, booleans, null, ISO dates (…Z) and JSON objects/arrays are
 * recognized; a 24-hex `_id` becomes an ObjectId; everything else stays a string.
 */
export function csvToDocs(rows: string[][]): Record<string, unknown>[] {
  const [header, ...data] = rows;
  if (!header?.length) return [];
  const paths = header.map((h) => h.trim().split('.'));
  return data.map((r, line) => {
    if (r.length > header.length) throw new Error(`Row ${line + 2} has ${r.length} fields, the header has ${header.length}`);
    const doc: Record<string, unknown> = {};
    r.forEach((raw, i) => {
      if (raw === '') return;
      setPath(doc, paths[i], inferValue(raw, paths[i].join('.')));
    });
    return doc;
  });
}

function inferValue(raw: string, key: string): unknown {
  if (/^-?(0|[1-9]\d*)$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : { $numberLong: raw };
  }
  if (/^-?(0|[1-9]\d*)?\.\d+([eE][-+]?\d+)?$|^-?(0|[1-9]\d*)[eE][-+]?\d+$/.test(raw)) return Number(raw);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (raw === 'null') return null;
  if (ISO_DATE.test(raw)) return { $date: raw };
  if (key === '_id' && /^[0-9a-f]{24}$/i.test(raw)) return { $oid: raw };
  if (/^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      // not JSON: keep the text
    }
  }
  return raw;
}

function setPath(doc: Record<string, unknown>, path: string[], value: unknown): void {
  let current = doc;
  path.slice(0, -1).forEach((segment) => {
    if (!isSubdocument(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  });
  current[path[path.length - 1]] = value;
}
