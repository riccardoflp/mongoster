// The place of the query in a collection's tab: above the results, or in a resizable pane at their right.
// The toggle button and the splitter change it; the choice is the user's for every collection (the setting
// `mongoster.queryBar.position`, and the width), so it is saved by the host and arrives from other tabs too.
// What the choice gives is decided in src/shared/queryPane.ts; this module only wires it to the DOM.
import { QUERY_PANE_WIDTH, QueryPane, draggedWidth, keyedWidth, paneLayout } from '../shared/queryPane';

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
      const width = keyedWidth(this.pane.width, e.key, e.shiftKey);
      if (width === null) return;
      e.preventDefault();
      this.change({ ...this.pane, width });
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
    const layout = paneLayout(this.pane, window.innerWidth);
    document.body.classList.toggle('query-side', layout.side);
    document.body.style.setProperty('--query-pane-width', `${layout.width}px`);
    this.toggle.setAttribute('aria-pressed', String(this.pane.side));
    this.toggle.classList.toggle('active', this.pane.side);
    this.toggle.title = layout.title;
    this.toggle.setAttribute('aria-label', layout.title);
    this.splitter.setAttribute('aria-valuenow', String(layout.width));
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
        this.pane = { ...this.pane, width: draggedWidth(startWidth, ev.clientX - startX, window.innerWidth) };
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
