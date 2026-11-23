// The place of the query in a collection's tab: above the results, or in a resizable pane beside them.
// The toggle button and the splitter change it; the choice is the user's for every collection, so it
// is saved by the host and arrives from other tabs too.
import { QUERY_PANE_WIDTH, QueryPane, clampPaneWidth } from '../shared/queryPane';

/** Below this width left for the results, the query goes back above them whatever the choice. */
const MIN_RESULTS_WIDTH = 360;

export class QueryPaneUi {
  private pane: QueryPane = { side: false, width: QUERY_PANE_WIDTH.default };

  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly splitter: HTMLElement,
    private readonly save: (pane: QueryPane) => void,
  ) {
    toggle.addEventListener('click', () => this.change({ ...this.pane, side: !this.pane.side }));
    window.addEventListener('resize', () => this.paint());
    this.dragging();
    splitter.addEventListener('dblclick', () => this.change({ ...this.pane, width: QUERY_PANE_WIDTH.default }));
    splitter.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 60 : 20;
      if (e.key === 'ArrowLeft') this.change({ ...this.pane, width: clampPaneWidth(this.pane.width - step) });
      else if (e.key === 'ArrowRight') this.change({ ...this.pane, width: clampPaneWidth(this.pane.width + step) });
      else return;
      e.preventDefault();
    });
  }

  /** The stored choice (at init, or changed in another tab). */
  apply(pane: QueryPane): void {
    this.pane = pane;
    this.paint();
  }

  private change(pane: QueryPane): void {
    this.apply(pane);
    this.save(pane);
  }

  private paint(): void {
    const width = clampPaneWidth(this.pane.width);
    const fits = window.innerWidth - width >= MIN_RESULTS_WIDTH;
    const side = this.pane.side && fits;
    document.body.classList.toggle('query-side', side);
    document.body.style.setProperty('--query-pane-width', `${width}px`);
    this.toggle.setAttribute('aria-pressed', String(this.pane.side));
    this.toggle.classList.toggle('active', this.pane.side);
    const title =
      this.pane.side && !fits
        ? 'Query beside the results: the tab is too narrow, so it is above them for now'
        : this.pane.side
          ? 'Query above the results'
          : 'Query beside the results';
    this.toggle.title = title;
    this.toggle.setAttribute('aria-label', title);
    this.splitter.setAttribute('aria-valuenow', String(width));
    this.splitter.setAttribute('aria-valuemin', String(QUERY_PANE_WIDTH.min));
    this.splitter.setAttribute('aria-valuemax', String(QUERY_PANE_WIDTH.max));
  }

  /** Dragging the splitter resizes the pane live and saves the width when released. */
  private dragging(): void {
    this.splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = this.pane.width;
      this.splitter.setPointerCapture(e.pointerId);
      document.body.classList.add('pane-resizing');
      const move = (ev: PointerEvent) => {
        const max = Math.max(QUERY_PANE_WIDTH.min, window.innerWidth - MIN_RESULTS_WIDTH);
        this.pane = { ...this.pane, width: Math.min(max, clampPaneWidth(startWidth + ev.clientX - startX)) };
        this.paint();
      };
      const up = () => {
        this.splitter.removeEventListener('pointermove', move);
        this.splitter.removeEventListener('pointerup', up);
        this.splitter.removeEventListener('pointercancel', up);
        document.body.classList.remove('pane-resizing');
        if (this.pane.width !== startWidth) this.save(this.pane);
      };
      this.splitter.addEventListener('pointermove', move);
      this.splitter.addEventListener('pointerup', up);
      this.splitter.addEventListener('pointercancel', up);
    });
  }
}
