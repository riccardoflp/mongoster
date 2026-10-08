// Visual filter builder: rows of field, operator and value under the Filter box. Changing a row
// rewrites the filter text; a filter changed elsewhere (typed, dropped, from the history) rebuilds the
// rows, unless it uses operators the rows can't show.
import { BUILDER_OPS, BUILDER_TYPES, BuilderOp, BuilderQuery, BuilderRow, NO_VALUE, filterToRows, rowComplete, rowsToFilter } from '../shared/builder';
import type { FieldHint } from '../shared/complete';
import { formatFilter, parseQuery, toShell } from '../shared/query';

export interface BuilderHost {
  text(): string;
  /** Puts the text in the Filter box (without running it). */
  setText(text: string): void;
  run(): void;
  fields(): FieldHint[];
  /** The builder was opened or closed (to remember it). */
  toggled(open: boolean): void;
}

const PLACEHOLDERS: Partial<Record<BuilderOp, string>> = {
  in: '1, 2, 3  or  "a", "b"',
  nin: '1, 2, 3  or  "a", "b"',
  regex: '/^mario/i',
  size: '3',
};
const VALUE_PLACEHOLDER = 'Mario, 42, true, ISODate("2024-01-01"), ObjectId("…")';

export class FilterBuilder {
  private query: BuilderQuery = { combine: 'and', rows: [] };
  /** The filter text the rows match: another text rebuilds them. */
  private synced: string | null = null;
  /** Why the filter can't be shown as rows. */
  private unsupported = '';
  private error = '';
  private readonly fieldList: HTMLDataListElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly toggle: HTMLButtonElement,
    private readonly host: BuilderHost,
  ) {
    this.fieldList = document.createElement('datalist');
    this.fieldList.id = 'builderFields';
    document.body.append(this.fieldList);
    toggle.addEventListener('click', () => {
      this.setOpen(!this.isOpen());
      host.toggled(this.isOpen());
    });
  }

  isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  setOpen(open: boolean): void {
    this.root.classList.toggle('hidden', !open);
    this.toggle.setAttribute('aria-expanded', String(open));
    this.toggle.classList.toggle('active', open);
    if (!open) return;
    this.synced = null;
    this.sync();
    if (!this.unsupported && !this.query.rows.length) this.add();
  }

  /** Rebuilds the rows if the filter text changed elsewhere. */
  sync(): void {
    if (!this.isOpen()) return;
    const text = this.host.text();
    if (text === this.synced) return;
    this.synced = text;
    this.error = '';
    let filter: unknown;
    try {
      filter = text.trim() ? parseQuery(text) : {};
    } catch {
      this.unsupported = 'The filter has a syntax error: fix it in the box above to edit it here.';
      this.render();
      return;
    }
    const q = filterToRows(filter);
    if (!q) {
      this.unsupported = "This filter uses operators the rows can't show ($elemMatch, $expr, nested $or…): edit it in the box above, or Clear to start over here.";
      this.render();
      return;
    }
    this.unsupported = '';
    // Rows still being filled in aren't in the text: they stay.
    this.query = { combine: q.combine, rows: [...q.rows, ...this.query.rows.filter((r) => !rowComplete(r))] };
    this.render();
  }

  /** Writes the rows into the Filter box. */
  private write(): void {
    try {
      const filter = rowsToFilter(this.query);
      const text = Object.keys(filter).length ? formatFilter(filter) : '';
      this.error = '';
      this.synced = text;
      this.host.setText(text);
    } catch (err) {
      this.error = (err as Error).message;
    }
    this.renderNote();
    this.markIncomplete();
  }

  private add(): void {
    this.query.rows.push({ field: '', op: 'eq', value: '' });
    this.render();
    const fields = this.root.querySelectorAll<HTMLInputElement>('.b-field');
    fields[fields.length - 1]?.focus();
  }

  private clear(): void {
    this.query = { combine: this.query.combine, rows: [] };
    this.unsupported = '';
    this.synced = '';
    this.host.setText('');
    this.add();
  }

  private fillFields(): void {
    this.fieldList.textContent = '';
    for (const hint of this.host.fields()) {
      const option = document.createElement('option');
      option.value = hint.path;
      this.fieldList.append(option);
    }
  }

  /** Sample values of the row's field, as suggestions. */
  private fillValues(list: HTMLDataListElement, row: BuilderRow): void {
    list.textContent = '';
    const hint = this.host.fields().find((h) => h.path === row.field.trim());
    for (const v of hint?.values.slice(0, 30) ?? []) {
      const option = document.createElement('option');
      option.value = toShell(v.value);
      list.append(option);
    }
  }

  private keys(input: HTMLElement): void {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.host.run();
      }
    });
  }

  private rowElement(row: BuilderRow, index: number): HTMLElement {
    const box = document.createElement('div');
    box.className = 'builder-row';

    const field = document.createElement('input');
    field.className = 'b-field';
    field.value = row.field;
    field.placeholder = 'field';
    field.spellcheck = false;
    field.setAttribute('list', this.fieldList.id);
    field.setAttribute('aria-label', `Field of condition ${index + 1}`);
    field.addEventListener('focus', () => this.fillFields());
    field.addEventListener('input', () => {
      row.field = field.value;
      this.write();
    });
    this.keys(field);

    const op = document.createElement('select');
    op.className = 'b-op';
    op.setAttribute('aria-label', `Operator of condition ${index + 1}`);
    for (const o of BUILDER_OPS) {
      const option = document.createElement('option');
      option.value = o.op;
      option.textContent = o.label;
      option.title = o.title;
      op.append(option);
    }
    op.value = row.op;
    op.title = BUILDER_OPS.find((o) => o.op === row.op)?.title ?? '';
    op.addEventListener('change', () => {
      const next = op.value as BuilderOp;
      if (next === 'type') row.value = BUILDER_TYPES.includes(row.value) ? row.value : 'string';
      else if (NO_VALUE.includes(next) || row.op === 'type') row.value = '';
      row.op = next;
      this.render();
      this.write();
      this.root.querySelectorAll<HTMLElement>('.b-value')[index]?.focus();
    });

    let value: HTMLElement;
    if (NO_VALUE.includes(row.op)) {
      value = document.createElement('span');
      value.className = 'b-value b-none';
    } else if (row.op === 'type') {
      const select = document.createElement('select');
      select.className = 'b-value';
      select.setAttribute('aria-label', `Type of condition ${index + 1}`);
      for (const t of BUILDER_TYPES) {
        const option = document.createElement('option');
        option.value = option.textContent = t;
        select.append(option);
      }
      select.value = row.value;
      select.addEventListener('change', () => {
        row.value = select.value;
        this.write();
      });
      value = select;
    } else {
      const input = document.createElement('input');
      input.className = 'b-value';
      input.value = row.value;
      input.placeholder = PLACEHOLDERS[row.op] ?? VALUE_PLACEHOLDER;
      input.spellcheck = false;
      input.setAttribute('aria-label', `Value of condition ${index + 1}`);
      const list = document.createElement('datalist');
      list.id = `builderValues${index}`;
      input.setAttribute('list', list.id);
      input.addEventListener('focus', () => this.fillValues(list, row));
      input.addEventListener('input', () => {
        row.value = input.value;
        this.write();
      });
      this.keys(input);
      box.append(list);
      value = input;
    }

    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.textContent = '✕';
    remove.title = 'Remove the condition';
    remove.addEventListener('click', () => {
      this.query.rows.splice(index, 1);
      this.render();
      this.write();
    });

    box.append(field, op, value, remove);
    return box;
  }

  private renderNote(): void {
    const note = this.root.querySelector<HTMLElement>('.builder-note');
    if (!note) return;
    const text = this.error || this.unsupported;
    note.textContent = text;
    note.classList.toggle('hidden', !text);
    note.classList.toggle('failed', !!this.error);
  }

  /** Rows not filled in yet aren't part of the filter: they're marked. */
  private markIncomplete(): void {
    this.root.querySelectorAll('.builder-row').forEach((box, i) => {
      const row = this.query.rows[i];
      box.classList.toggle('incomplete', !!row && !rowComplete(row));
    });
  }

  render(): void {
    this.root.textContent = '';
    const head = document.createElement('div');
    head.className = 'builder-head';
    const combine = document.createElement('select');
    combine.className = 'b-combine';
    combine.setAttribute('aria-label', 'Match all or any of the conditions');
    for (const [v, label] of [
      ['and', 'all'],
      ['or', 'any'],
    ]) {
      const option = document.createElement('option');
      option.value = v;
      option.textContent = label;
      combine.append(option);
    }
    combine.value = this.query.combine;
    combine.disabled = !!this.unsupported;
    combine.addEventListener('change', () => {
      this.query.combine = combine.value as BuilderQuery['combine'];
      this.write();
    });
    const label = (text: string) => {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    };
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const add = document.createElement('button');
    add.className = 'secondary';
    add.textContent = '+ Condition';
    add.title = 'Add a condition';
    add.disabled = !!this.unsupported;
    add.addEventListener('click', () => this.add());
    const clear = document.createElement('button');
    clear.className = 'secondary';
    clear.textContent = 'Clear';
    clear.title = 'Remove every condition (and the filter)';
    clear.addEventListener('click', () => this.clear());
    head.append(label('Match'), combine, label('of these conditions'), spacer, add, clear);
    this.root.append(head);

    if (!this.unsupported) {
      const rows = document.createElement('div');
      rows.className = 'builder-rows';
      this.query.rows.forEach((row, i) => rows.append(this.rowElement(row, i)));
      this.root.append(rows);
    }
    const note = document.createElement('div');
    note.className = 'builder-note hidden';
    this.root.append(note);
    this.renderNote();
    this.markIncomplete();
  }
}
