// A small menu at the pointer or under a button: the actions on a document of the grid, the copy formats.
/** `heading`: a caption over the items that follow it (e.g. "Copy 3 documents as"); `items`: a submenu. */
export type MenuItem =
  | { label: string; title?: string; action: () => void }
  | { label: string; title?: string; items: MenuItem[] }
  | { heading: string }
  | 'separator';

export class PopupMenu {
  /** The submenu opened from one of the items. */
  private child?: PopupMenu;
  /** The item of the parent menu this submenu belongs to. */
  private opener?: HTMLButtonElement;

  constructor(
    private readonly menu: HTMLElement,
    private readonly parent?: PopupMenu,
  ) {
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen && !this.contains(e.target as Node)) this.close();
    });
    window.addEventListener('blur', () => this.close());
    this.menu.addEventListener('keydown', (e) => {
      const buttons = [...this.menu.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape' || (e.key === 'ArrowLeft' && this.parent)) this.closeToParent();
      else if (e.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus();
      else if (e.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
      else if (e.key === 'ArrowRight' && buttons[at]?.getAttribute('aria-haspopup')) buttons[at].click();
      else return;
      // Escape closes only the menu, not the dialog under it.
      e.preventDefault();
      e.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  /** Whether `node` is in this menu or one of its open submenus. */
  private contains(node: Node): boolean {
    return this.menu.contains(node) || (!!this.child?.isOpen && this.child.contains(node));
  }

  open(x: number, y: number, items: MenuItem[]): void {
    this.child?.close();
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
        if ('items' in item) {
          b.classList.add('menu-more');
          b.setAttribute('aria-haspopup', 'menu');
          b.setAttribute('aria-expanded', 'false');
          const show = () => this.openChild(b, item.items);
          b.addEventListener('click', show);
          b.addEventListener('mouseenter', show);
        } else {
          b.addEventListener('mouseenter', () => this.child?.close());
          b.addEventListener('click', () => {
            this.root().close();
            item.action();
          });
        }
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
    this.child?.close();
    if (!this.isOpen) return;
    this.menu.classList.add('hidden');
    this.opener?.setAttribute('aria-expanded', 'false');
  }

  private root(): PopupMenu {
    return this.parent ? this.parent.root() : this;
  }

  /** Escape (or ← in a submenu): back to the item that opened it. */
  private closeToParent(): void {
    this.close();
    this.opener?.focus();
  }

  /** The submenu of `button`, on its right (on its left when there is no room). */
  private openChild(button: HTMLButtonElement, items: MenuItem[]): void {
    if (this.child?.isOpen && this.child.opener === button) return;
    if (!this.child) {
      const el = document.createElement('div');
      el.className = 'context-menu hidden';
      el.setAttribute('role', 'menu');
      document.body.append(el);
      this.child = new PopupMenu(el, this);
    }
    const child = this.child;
    child.opener?.setAttribute('aria-expanded', 'false');
    child.opener = button;
    button.setAttribute('aria-expanded', 'true');
    const r = button.getBoundingClientRect();
    child.open(r.right - 2, r.top - 4, items);
    if (r.right - 2 + child.menu.offsetWidth > window.innerWidth - 4) child.menu.style.left = `${Math.max(4, r.left - child.menu.offsetWidth + 2)}px`;
  }
}
