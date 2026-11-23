// What a header or a cell dragged from a collection's table offers on Sort and Project: the zones, with
// their labels, tooltips and the value each one puts. A header and a cell give the same field (the cell
// of an array element gives its dotted path, `items.qty`). No vscode dependency.

/** A header (a field) or a cell (a field and its value; `within`: the array whose element it is in). */
export type DragPayload = { kind: 'cell'; key: string; value: unknown; within?: string } | { kind: 'column'; key: string };

export interface OptionZone<V> {
  label: string;
  title: string;
  /** What the field gets; null removes it. */
  value: V;
}

/** The zones of Sort for a dragged header or cell; none in Aggregate, which has no Sort box. */
export function sortZones(p: DragPayload, mode: string, sort: Record<string, unknown>): OptionZone<1 | -1 | null>[] {
  if (mode !== 'find') return [];
  const zones: OptionZone<1 | -1 | null>[] = [
    { label: '▲ ascending', title: `${p.key}: 1 (after the fields already in the sort)`, value: 1 },
    { label: '▼ descending', title: `${p.key}: -1 (after the fields already in the sort)`, value: -1 },
  ];
  if (p.key in sort) zones.push({ label: '✕ remove', title: `Remove ${p.key} from the sort`, value: null });
  return zones;
}

/** The zones of Project for a dragged header or cell; none in Aggregate, which has no Project box. */
export function projectionZones(p: DragPayload, mode: string, projection: Record<string, unknown>): OptionZone<1 | 0 | null>[] {
  if (mode !== 'find') return [];
  const zones: OptionZone<1 | 0 | null>[] = [
    { label: 'include', title: `${p.key}: 1 (only the included fields are shown, and _id)`, value: 1 },
    { label: 'exclude', title: `${p.key}: 0 (every field but the excluded ones is shown)`, value: 0 },
  ];
  if (p.key in projection) zones.push({ label: '✕ remove', title: `Remove ${p.key} from the projection`, value: null });
  return zones;
}
