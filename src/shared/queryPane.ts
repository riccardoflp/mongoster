// Where a collection's tab puts its query (Filter, Builder, Sort, Project, or the stages of the
// pipeline): above the results, or in a pane beside them, and that pane's width. One choice for every
// collection, kept in globalState. No vscode dependency.

export interface QueryPane {
  /** The query in a pane at the left of the results; false: above them. */
  side: boolean;
  /** Width of the side pane in CSS pixels. */
  width: number;
}

export const QUERY_PANE_WIDTH = { min: 260, max: 900, default: 380 } as const;

/** The stored value, or the default for anything missing or of another form. */
export function readQueryPane(raw: unknown): QueryPane {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { side: o.side === true, width: clampPaneWidth(o.width) };
}

/** A width within the limits; the default for a value that isn't a number. */
export function clampPaneWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return QUERY_PANE_WIDTH.default;
  return Math.round(Math.min(QUERY_PANE_WIDTH.max, Math.max(QUERY_PANE_WIDTH.min, width)));
}
