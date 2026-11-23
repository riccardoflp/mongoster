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

/** Below this width left for the results, the query goes above them whatever the choice. */
export const MIN_RESULTS_WIDTH = 360;

/** What the tab shows for a choice in a tab `viewport` pixels wide: the place, and the toggle's tooltip. */
export function paneLayout(pane: QueryPane, viewport: number): { side: boolean; width: number; title: string } {
  const width = clampPaneWidth(pane.width);
  const fits = viewport - width >= MIN_RESULTS_WIDTH;
  const title = !pane.side
    ? 'Query beside the results'
    : fits
      ? 'Query above the results'
      : 'Query beside the results: the tab is too narrow, so it is above them for now';
  return { side: pane.side && fits, width, title };
}

/** The width while the splitter is dragged `dx` pixels from `start`: within the limits, leaving room for the results. */
export function draggedWidth(start: number, dx: number, viewport: number): number {
  const max = Math.max(QUERY_PANE_WIDTH.min, viewport - MIN_RESULTS_WIDTH);
  return Math.min(max, clampPaneWidth(start + dx));
}

/** The width after an arrow key on the splitter (20 px, 60 px with Shift); null for another key. */
export function keyedWidth(width: number, key: string, shift: boolean): number | null {
  const step = shift ? 60 : 20;
  if (key === 'ArrowLeft') return clampPaneWidth(width - step);
  if (key === 'ArrowRight') return clampPaneWidth(width + step);
  return null;
}
