// "Insert" dialog: documents typed or pasted in mongosh syntax or Extended JSON, inserted in place
// without going through an editor tab.
import type { WebviewMessage } from '../shared/messages';
import type { FieldHint } from '../shared/complete';
import { insertTemplate, parseDocuments } from '../shared/formats';

export interface InsertDialogCallbacks {
  post(message: WebviewMessage): void;
  /** Fields of the collection, for the template. */
  fields(): FieldHint[];
}

const EMPTY = '{\n  \n}';

export class InsertDialog {
  private readonly modal = document.getElementById('insertModal')!;
  private readonly title = document.getElementById('insertTitle')!;
  private readonly text = document.getElementById('insertText') as HTMLTextAreaElement;
  private readonly status = document.getElementById('insertStatus')!;
  private readonly error = document.getElementById('insertError')!;
  private readonly keep = document.getElementById('insertKeep') as HTMLInputElement;
  private readonly applyButton = document.getElementById('insertApply') as HTMLButtonElement;
  private readonly cancelButton = document.getElementById('insertCancel') as HTMLButtonElement;
  private readonly editorButton = document.getElementById('insertEditor') as HTMLButtonElement;
  private count = 0;
  private request = 0;
  private busy = false;
  /** Text left in the dialog when it was closed without inserting, shown again by Insert. */
  private draft = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly cb: InsertDialogCallbacks) {
    document.getElementById('insertClose')!.addEventListener('click', () => this.close());
    this.cancelButton.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    this.applyButton.addEventListener('click', () => this.apply());
    this.editorButton.addEventListener('click', () => {
      this.cb.post({ type: 'insertInEditor', text: this.text.value });
      this.draft = '';
      this.close();
    });
    document.getElementById('insertTemplate')!.addEventListener('click', () => {
      this.setText(insertTemplate(this.cb.fields()));
      this.text.focus();
    });
    this.text.addEventListener('keydown', (e) => this.keydown(e));
    this.text.addEventListener('input', () => {
      this.showError(null);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.check(), 250);
    });
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  /** Opens with `text` (e.g. a duplicated document), or with what was left in it last time. */
  open(collection: string, text?: string): void {
    this.title.textContent = `Insert into ${collection}`;
    this.busy = false;
    this.setText(text ?? (this.draft || EMPTY));
    this.status.classList.remove('done');
    this.modal.classList.remove('hidden');
    this.text.focus();
    // The caret inside the empty document, or at the end of the text.
    const inside = this.text.value === EMPTY ? 4 : this.text.value.length;
    this.text.setSelectionRange(inside, inside);
    this.text.scrollTop = 0;
  }

  close(): void {
    if (this.busy) return;
    this.request++;
    const value = this.text.value.trim();
    this.draft = value && value !== EMPTY ? this.text.value : '';
    this.modal.classList.add('hidden');
  }

  onResult(m: { requestId: number; ok: boolean; message?: string }): void {
    if (m.requestId !== this.request) return;
    this.busy = false;
    if (m.ok && !this.keep.checked) {
      this.draft = '';
      this.text.value = '';
      this.close();
      return;
    }
    if (m.ok) {
      this.status.textContent = m.message ?? 'Inserted.';
      this.status.classList.add('done');
    } else if (m.message) this.showError(m.message);
    this.render();
    this.text.focus();
  }

  private setText(text: string): void {
    this.text.value = text;
    this.text.dispatchEvent(new Event('input'));
    clearTimeout(this.timer);
    this.check();
  }

  /** Counts the documents as the text is typed, so mistakes show before inserting. */
  private check(): boolean {
    this.status.classList.remove('done');
    try {
      this.count = parseDocuments(this.text.value).length;
      this.status.textContent = `${this.count.toLocaleString()} document${this.count === 1 ? '' : 's'} to insert`;
      this.status.classList.remove('invalid');
    } catch (err) {
      this.count = 0;
      this.status.textContent = this.text.value.trim() ? (err as Error).message : '';
      this.status.classList.add('invalid');
    }
    this.render();
    return this.count > 0;
  }

  private apply(): void {
    if (this.busy) return;
    clearTimeout(this.timer);
    if (!this.check()) {
      this.showError(this.status.textContent || 'Enter a document, e.g. { name: "Ada" }');
      this.text.focus();
      return;
    }
    this.busy = true;
    this.showError(null);
    this.render();
    this.cb.post({ type: 'insertDocuments', requestId: ++this.request, text: this.text.value });
  }

  private keydown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.apply();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      // New lines keep the indentation, one level more after an opening bracket.
      const { value, selectionStart: from, selectionEnd: to } = this.text;
      const line = value.slice(value.lastIndexOf('\n', from - 1) + 1, from);
      const indent = /^\s*/.exec(line)![0];
      const before = value.slice(0, from).trimEnd().slice(-1);
      const after = value.slice(to).trimStart()[0];
      e.preventDefault();
      if (before === '{' || before === '[') {
        const inner = `\n${indent}  `;
        const closing = (before === '{' && after === '}') || (before === '[' && after === ']');
        this.text.setRangeText(closing ? `${inner}\n${indent}` : inner, from, to, 'start');
        this.text.setSelectionRange(from + inner.length, from + inner.length);
      } else {
        this.text.setRangeText(`\n${indent}`, from, to, 'end');
      }
      this.text.dispatchEvent(new Event('input'));
    }
  }

  private render(): void {
    this.applyButton.textContent = this.busy ? 'Inserting…' : this.count > 1 ? `Insert ${this.count.toLocaleString()} documents` : 'Insert';
    this.applyButton.disabled = this.busy;
    this.cancelButton.disabled = this.busy;
    this.text.disabled = this.busy;
    // The editor tab saves one document.
    this.editorButton.disabled = this.busy || this.count > 1;
    this.editorButton.title =
      this.count > 1 ? 'An editor tab inserts one document: use Insert for several' : 'Edit in an editor tab instead: saving it (Ctrl+S) inserts the document';
  }

  private showError(message: string | null): void {
    this.error.textContent = message ?? '';
    this.error.classList.toggle('hidden', !message);
  }
}
