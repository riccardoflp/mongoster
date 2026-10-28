// A small menu at the pointer or under a button: the actions on a document of the grid, the copy formats.
/** `heading`: a caption over the items that follow it (e.g. "Copy 3 documents as"). */
export type MenuItem = { label: string; title?: string; action: () => void } | { heading: string } | 'separator';

export class PopupMenu {
  constructor(private readonly menu: HTMLElement) {
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen && !this.menu.contains(e.target as Node)) this.close();
    });
    window.addEventListener('blur', () => this.close());
    this.menu.addEventListener('keydown', (e) => {
      const buttons = [...this.menu.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus();
      else if (e.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
      else return;
      // Escape closes only the menu, not the dialog under it.
      e.preventDefault();
      e.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  open(x: number, y: number, items: MenuItem[]): void {
    // Items under a heading are indented, up to the next separator.
    let sub = false;
    this.menu.replaceChildren(
      ...items.map((item) => {
        if (item === 'separator') {
          sub = false;
          return document.createElement('hr');
        }
        if ('heading' in item) {
          sub = true;
          const h = document.createElement('div');
          h.className = 'menu-heading';
          h.textContent = item.heading;
          return h;
        }
        const b = document.createElement('button');
        if (sub) b.className = 'menu-sub';
        b.textContent = item.label;
        b.setAttribute('role', 'menuitem');
        if (item.title) b.title = item.title;
        b.addEventListener('click', () => {
          this.close();
          item.action();
        });
        return b;
      }),
    );
    this.menu.classList.remove('hidden');
    const { innerWidth, innerHeight } = window;
    this.menu.style.left = `${Math.max(4, Math.min(x, innerWidth - this.menu.offsetWidth - 4))}px`;
    this.menu.style.top = `${Math.max(4, Math.min(y, innerHeight - this.menu.offsetHeight - 4))}px`;
    this.menu.querySelector('button')?.focus();
  }

  /** Opens under `anchor`, aligned to its right edge. */
  openBelow(anchor: HTMLElement, items: MenuItem[]): void {
    const r = anchor.getBoundingClientRect();
    this.open(r.left, r.bottom + 2, items);
    this.menu.style.left = `${Math.max(4, r.right - this.menu.offsetWidth)}px`;
  }

  close(): void {
    if (!this.isOpen) return;
    this.menu.classList.add('hidden');
  }
}
