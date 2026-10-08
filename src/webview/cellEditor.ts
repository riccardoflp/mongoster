// In-place editor over a grid cell: the value in mongosh syntax, Enter saves, Esc cancels.
import { parseQuery } from '../shared/query';

export interface CellEditSession {
  /** Called with the new text; resolve with an error message to keep the editor open. */
  save(text: string): Promise<string | undefined>;
}

export class CellEditor {
  private readonly box = document.createElement('div');
  private readonly input = document.createElement('textarea');
  private readonly hint = document.createElement('div');
  private session: CellEditSession | null = null;
  private cell: HTMLElement | null = null;
  private busy = false;

  constructor(private readonly container: HTMLElement) {
    this.box.className = 'cell-editor hidden';
    this.input.spellcheck = false;
    this.input.rows = 1;
    this.hint.className = 'cell-editor-hint';
    this.box.append(this.input, this.hint);
    container.append(this.box);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.commit();
      }
    });
    this.input.addEventListener('input', () => {
      this.autosize();
      this.setError(null);
    });
    // Clicking elsewhere cancels (a database write needs an explicit Enter).
    this.input.addEventListener('blur', () => {
      if (!this.busy) this.close();
    });
  }

  get isOpen(): boolean {
    return this.session !== null;
  }

  /** Opens over `cell` with `text`; `select` is the range to select (e.g. the inside of a string's quotes). */
  open(cell: HTMLElement, text: string, select: [number, number], session: CellEditSession): void {
    this.close();
    this.session = session;
    this.cell = cell;
    cell.classList.add('editing');
    const c = this.container.getBoundingClientRect();
    const r = cell.getBoundingClientRect();
    this.box.style.left = `${r.left - c.left + this.container.scrollLeft}px`;
    this.box.style.top = `${r.top - c.top + this.container.scrollTop}px`;
    this.box.style.minWidth = `${Math.max(r.width, 160)}px`;
    this.input.value = text;
    this.setError(null);
    this.box.classList.remove('hidden');
    this.autosize();
    this.input.focus();
    this.input.setSelectionRange(...select);
  }

  close(): void {
    this.session = null;
    this.busy = false;
    this.box.classList.add('hidden');
    this.box.classList.remove('busy');
    this.input.readOnly = false;
    this.cell?.classList.remove('editing');
    this.cell = null;
  }

  private async commit(): Promise<void> {
    if (!this.session || this.busy) return;
    const text = this.input.value;
    try {
      parseQuery(text);
    } catch (err) {
      this.setError((err as Error).message);
      return;
    }
    this.busy = true;
    this.input.readOnly = true;
    this.box.classList.add('busy');
    const session = this.session;
    const error = await session.save(text);
    if (this.session !== session) return;
    this.busy = false;
    this.input.readOnly = false;
    this.box.classList.remove('busy');
    if (error) {
      this.setError(error);
      this.input.focus();
    } else this.close();
  }

  private setError(message: string | null): void {
    this.box.classList.toggle('has-error', !!message);
    this.input.classList.toggle('invalid', !!message);
    this.hint.textContent = message ?? 'Enter to save · Shift+Enter new line · Esc to cancel';
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight + 2, 240)}px`;
  }
}
