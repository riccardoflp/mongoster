// The part of the `vscode` module that the tested modules need when they are loaded: classes they extend
// or create. Nothing here does anything.
export class TreeItem {
  constructor(
    public label?: unknown,
    public collapsibleState?: number,
  ) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
  ) {}
  static from(c: { scheme: string; authority?: string; path?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '');
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, base.authority, [base.path, ...parts].join('/'));
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

export class FileDecoration {
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: ThemeColor,
  ) {}
}
