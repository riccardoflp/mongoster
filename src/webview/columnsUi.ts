// Column customization UI: the "Columns" panel (show/hide, pin, reorder) and the header context menu.
import { ColumnLayout, ColumnNode, applyLayout, moveColumn } from '../shared/columns';

export interface ColumnsUiOptions {
  /** All columns of the page, expanded as in the grid. */
  columns(): ColumnNode[];
  layout(): ColumnLayout;
  /** Saves the layout and renders the grid again. */
  change(layout: ColumnLayout): void;
}

const without = (list: string[] | undefined, key: string) => (list ?? []).filter((k) => k !== key);

/** Layout operations shared by the panel and the menu. */
export class LayoutActions {
  constructor(private readonly opts: ColumnsUiOptions) {}

  setHidden(key: string, hidden: boolean): void {
    const layout = this.opts.layout();
    const list = without(layout.hidden, key);
    this.opts.change({ ...layout, hidden: hidden ? [...list, key] : list });
  }

  setPinned(key: string, pinned: boolean): void {
    const layout = this.opts.layout();
    this.opts.change({ ...layout, pinned: pinned ? [...without(layout.pinned, key), key] : without(layout.pinned, key) });
  }

  resetWidth(key: string): void {
    const layout = this.opts.layout();
    const widths = { ...layout.widths };
    delete widths[key];
    this.opts.change({ ...layout, widths });
  }

  /** Moves `source` next to `target`; hidden columns keep their place in the order. */
  move(source: string, target: string, after: boolean): boolean {
    const layout = this.opts.layout();
    const next = moveColumn(applyLayout(this.opts.columns(), { ...layout, hidden: [] }), layout, source, target, after);
    if (next) this.opts.change(next);
    return !!next;
  }

  showAll(): void {
    this.opts.change({ ...this.opts.layout(), hidden: [] });
  }

  reset(): void {
    this.opts.change({});
  }
}

export class ColumnsPanel {
  private readonly panel = document.getElementById('columnsPanel')!;
  private readonly list = document.getElementById('columnsList')!;
  private readonly search = document.getElementById('columnsSearch') as HTMLInputElement;
  private readonly button = document.getElementById('columnsBtn')!;
  private dragKey: string | null = null;

  constructor(
    private readonly opts: ColumnsUiOptions,
    private readonly actions: LayoutActions,
  ) {
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen) this.close();
      else this.open();
    });
    this.search.addEventListener('input', () => this.render());
    document.getElementById('columnsShowAll')!.addEventListener('click', () => this.actions.showAll());
    document.getElementById('columnsReset')!.addEventListener('click', () => this.actions.reset());
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen && !this.panel.contains(e.target as Node) && e.target !== this.button) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  open(): void {
    const r = this.button.getBoundingClientRect();
    this.panel.style.top = `${r.bottom + 4}px`;
    this.panel.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
    this.panel.classList.remove('hidden');
    this.button.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this.render();
    this.search.focus();
  }

  close(): void {
    this.panel.classList.add('hidden');
    this.button.setAttribute('aria-expanded', 'false');
  }

  /** Updates the button label; re-renders the list when open. */
  update(): void {
    const hidden = this.opts.layout().hidden?.length ?? 0;
    this.button.textContent = hidden ? `Columns (${hidden} hidden)` : 'Columns';
    if (this.isOpen) this.render();
  }

  private render(): void {
    const layout = this.opts.layout();
    const hidden = new Set(layout.hidden ?? []);
    const pinned = new Set(layout.pinned ?? []);
    const query = this.search.value.trim().toLowerCase();
    const columns = applyLayout(this.opts.columns(), { ...layout, hidden: [] });
    this.list.replaceChildren();
    const add = (nodes: ColumnNode[], depth: number, parentHidden: boolean) => {
      for (const node of nodes) {
        const isHidden = hidden.has(node.key);
        if (!query || node.key.toLowerCase().includes(query)) this.list.append(this.row(node, depth, isHidden, parentHidden, pinned.has(node.key)));
        if (node.children) add(node.children, depth + 1, parentHidden || isHidden);
      }
    };
    add(columns, 0, false);
    if (!this.list.childElementCount) this.list.append(Object.assign(document.createElement('div'), { className: 'columns-empty', textContent: 'No columns' }));
  }

  private row(node: ColumnNode, depth: number, isHidden: boolean, parentHidden: boolean, isPinned: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'columns-row';
    row.classList.toggle('dim', parentHidden);
    row.style.paddingLeft = `${6 + depth * 16}px`;
    row.dataset.key = node.key;
    row.draggable = !this.search.value.trim();
    row.title = `${node.key}\nDrag to reorder`;

    const handle = document.createElement('span');
    handle.className = 'columns-grip';
    handle.textContent = '⋮⋮';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !isHidden;
    box.title = isHidden ? 'Show' : 'Hide';
    box.addEventListener('change', () => this.actions.setHidden(node.key, !box.checked));
    const label = document.createElement('label');
    label.textContent = depth ? node.key.slice(node.key.lastIndexOf('.') + 1) : node.key;
    label.addEventListener('click', () => box.click());
    row.append(handle, box, label);

    if (depth === 0) {
      const pin = document.createElement('button');
      pin.className = `icon columns-pin${isPinned ? ' on' : ''}`;
      pin.textContent = '📌';
      pin.title = isPinned ? 'Unpin' : 'Pin to the left (stays visible while scrolling sideways)';
      pin.addEventListener('click', () => this.actions.setPinned(node.key, !isPinned));
      row.append(pin);
    }

    row.addEventListener('dragstart', (e) => {
      this.dragKey = node.key;
      e.dataTransfer!.setData('text/plain', node.key);
      e.dataTransfer!.effectAllowed = 'move';
      e.stopPropagation();
    });
    row.addEventListener('dragend', () => (this.dragKey = null));
    row.addEventListener('dragover', (e) => {
      if (!this.dragKey || this.dragKey === node.key) return;
      e.preventDefault();
      const after = e.offsetY > row.offsetHeight / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-before', 'drop-after');
      if (this.dragKey) this.actions.move(this.dragKey, node.key, e.offsetY > row.offsetHeight / 2);
      this.dragKey = null;
    });
    return row;
  }
}

/** Right-click menu of a column header. */
export class ColumnMenu {
  private readonly menu = document.getElementById('columnMenu')!;

  constructor(
    private readonly opts: ColumnsUiOptions,
    private readonly actions: LayoutActions,
    private readonly openPanel: () => void,
  ) {
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen && !this.menu.contains(e.target as Node)) this.close();
    });
    window.addEventListener('blur', () => this.close());
  }

  get isOpen(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  open(x: number, y: number, key: string): void {
    const layout = this.opts.layout();
    const top = key.split('.')[0];
    const pinned = layout.pinned?.includes(top) ?? false;
    const items: [string, () => void][] = [[`Hide ${key}`, () => this.actions.setHidden(key, true)]];
    items.push([pinned ? `Unpin ${top}` : `Pin ${top} to the left`, () => this.actions.setPinned(top, !pinned)]);
    if (layout.widths?.[key]) items.push(['Reset width', () => this.actions.resetWidth(key)]);
    items.push(['Columns…', this.openPanel]);
    if (layout.hidden?.length || layout.order?.length || layout.pinned?.length || Object.keys(layout.widths ?? {}).length) {
      items.push(['Reset all columns', () => this.actions.reset()]);
    }
    this.menu.replaceChildren(
      ...items.map(([label, action]) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => {
          this.close();
          action();
        });
        return b;
      }),
    );
    this.menu.classList.remove('hidden');
    const { innerWidth, innerHeight } = window;
    this.menu.style.left = `${Math.min(x, innerWidth - this.menu.offsetWidth - 4)}px`;
    this.menu.style.top = `${Math.min(y, innerHeight - this.menu.offsetHeight - 4)}px`;
    (this.menu.firstElementChild as HTMLElement).focus();
  }

  close(): void {
    this.menu.classList.add('hidden');
  }
}
