// Where a collection's tab puts its query bar (Filter, Builder, Sort, Project, or the stages of the
// pipeline): above the results, or in a pane at their right, and that pane's width. The place is the setting
// `mongoster.queryBar.position`; the width is kept in globalState. Both hold for every collection.
// No vscode dependency.

/** The values of the setting `mongoster.queryBar.position`. */
export type QueryBarPosition = 'top' | 'right';

export const POSITION_SETTING = 'queryBar.position';

export interface QueryPane {
  /** The query in a pane at the right of the results; false: above them. */
  side: boolean;
  /** Width of the side pane in CSS pixels. */
  width: number;
}

export const QUERY_PANE_WIDTH = { min: 260, max: 900, default: 380 } as const;

/**
 * The setting's value and the width stored in globalState (`{ width }`); anything missing or of another form
 * gives the default: above the results, 380 px. A `side` stored by an earlier build is ignored: the setting
 * decides.
 */
export function readQueryPane(position: unknown, stored: unknown): QueryPane {
  const o = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  return { side: position === 'right', width: clampPaneWidth(o.width) };
}

/** The setting's value for a place. */
export function positionOf(pane: QueryPane): QueryBarPosition {
  return pane.side ? 'right' : 'top';
}

/**
 * What the host saves when a tab sends the user's choice (`sent`, from the webview, so read like anything
 * stored): the setting's new value when the place changed, the width when it changed. Only a changed width is
 * sent to the other tabs by the host; a changed setting reaches them through the configuration's change event.
 * `position` is the setting's current value, `stored` what globalState holds.
 */
export function queryPaneSave(position: unknown, stored: unknown, sent: unknown): { position?: QueryBarPosition; width?: number } {
  const s = sent && typeof sent === 'object' ? (sent as Record<string, unknown>) : {};
  const pane = readQueryPane(s.side === true ? 'right' : 'top', sent);
  const save: { position?: QueryBarPosition; width?: number } = {};
  if (position !== positionOf(pane)) save.position = positionOf(pane);
  if (readQueryPane(undefined, stored).width !== pane.width) save.width = pane.width;
  return save;
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
    ? 'Query at the right of the results'
    : fits
      ? 'Query above the results'
      : 'Query at the right of the results: the tab is too narrow, so it is above them for now';
  return { side: pane.side && fits, width, title };
}

/**
 * The width while the splitter, at the pane's left edge, is dragged `dx` pixels to the right from where the
 * pane was `start` wide: the pane grows when the splitter goes left. Within the limits, leaving room for the
 * results.
 */
export function draggedWidth(start: number, dx: number, viewport: number): number {
  const max = Math.max(QUERY_PANE_WIDTH.min, viewport - MIN_RESULTS_WIDTH);
  return Math.min(max, clampPaneWidth(start - dx));
}

/** The width after an arrow key on the splitter (20 px, 60 px with Shift): `←` moves it left, widening the pane. */
export function keyedWidth(width: number, key: string, shift: boolean): number | null {
  const step = shift ? 60 : 20;
  if (key === 'ArrowLeft') return clampPaneWidth(width + step);
  if (key === 'ArrowRight') return clampPaneWidth(width - step);
  return null;
}
