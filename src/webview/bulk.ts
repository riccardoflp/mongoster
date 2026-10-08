// "Update many" / "Delete many" dialog: shows the filter and how many documents it matches before writing.
import type { WebviewMessage } from '../shared/messages';

export type BulkOp = 'update' | 'delete';

export class BulkDialog {
  private readonly modal = document.getElementById('bulkModal')!;
  private readonly title = document.getElementById('bulkTitle')!;
  private readonly filterView = document.getElementById('bulkFilter')!;
  private readonly update = document.getElementById('bulkUpdate') as HTMLTextAreaElement;
  private readonly countView = document.getElementById('bulkCount')!;
  private readonly error = document.getElementById('bulkError')!;
  private readonly applyButton = document.getElementById('bulkApply') as HTMLButtonElement;
  private readonly cancelButton = document.getElementById('bulkCancel') as HTMLButtonElement;
  private op: BulkOp = 'update';
  private filter = '';
  private count: number | null = null;
  private request = 0;
  private busy = false;

  constructor(private readonly post: (message: WebviewMessage) => void) {
    document.getElementById('bulkClose')!.addEventListener('click', () => this.close());
    this.cancelButton.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    this.applyButton.addEventListener('click', () => this.apply());
    this.update.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.apply();
      }
    });
    this.update.addEventListener('input', () => this.showError(null));
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  open(op: BulkOp, filter: string, collection: string): void {
    this.op = op;
    this.filter = filter;
    this.count = null;
    this.busy = false;
    this.modal.classList.toggle('delete', op === 'delete');
    this.title.textContent = `${op === 'update' ? 'Update' : 'Delete'} many · ${collection}`;
    const empty = !filter.trim();
    this.filterView.textContent = empty ? '{ }  — no filter: every document of the collection' : filter.trim();
    this.filterView.classList.toggle('warn', empty);
    this.countView.textContent = 'Counting matching documents…';
    this.showError(null);
    this.render();
    this.modal.classList.remove('hidden');
    (op === 'update' ? this.update : this.cancelButton).focus();
    this.post({ type: 'bulkCount', requestId: ++this.request, filter });
  }

  close(): void {
    if (this.busy) return;
    this.request++;
    this.modal.classList.add('hidden');
  }

  onCount(m: { requestId: number; count?: number; error?: string }): void {
    if (m.requestId !== this.request) return;
    if (m.error !== undefined) {
      this.countView.textContent = '';
      this.showError(m.error);
      return;
    }
    this.count = m.count ?? 0;
    this.countView.textContent = this.count
      ? `${documents(this.count)} ${this.count === 1 ? 'matches' : 'match'} the filter.`
      : 'No documents match the filter.';
    this.render();
  }

  onResult(m: { requestId: number; ok: boolean; message?: string }): void {
    if (m.requestId !== this.request) return;
    this.busy = false;
    if (m.ok) {
      this.close();
      return;
    }
    // No message: the confirmation was cancelled.
    if (m.message) this.showError(m.message);
    this.render();
  }

  private apply(): void {
    if (this.busy || !this.count) return;
    if (this.op === 'update' && !this.update.value.trim()) {
      this.showError('Enter the changes, e.g. { $set: { field: "value" } }');
      this.update.focus();
      return;
    }
    this.busy = true;
    this.showError(null);
    this.render();
    this.post({
      type: 'bulkApply',
      requestId: ++this.request,
      op: this.op,
      filter: this.filter,
      update: this.op === 'update' ? this.update.value : undefined,
    });
  }

  private render(): void {
    const verb = this.op === 'update' ? 'Update' : 'Delete';
    this.applyButton.textContent = this.busy
      ? `${this.op === 'update' ? 'Updating' : 'Deleting'}…`
      : this.count
        ? `${verb} ${documents(this.count)}`
        : verb;
    this.applyButton.disabled = this.busy || !this.count;
    this.applyButton.classList.toggle('danger-primary', this.op === 'delete');
    this.cancelButton.disabled = this.busy;
    this.update.disabled = this.busy;
  }

  private showError(message: string | null): void {
    this.error.textContent = message ?? '';
    this.error.classList.toggle('hidden', !message);
  }
}

function documents(n: number): string {
  return `${n.toLocaleString()} document${n === 1 ? '' : 's'}`;
}
