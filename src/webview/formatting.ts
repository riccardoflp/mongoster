// Conditional formatting in the collection tab: the "Formatting" panel (the list of rules: reorder, turn on and off,
// edit, remove) and the dialog that adds or edits a rule. The colors themselves are decided by TableFormat in
// src/shared/formatting.ts and painted by renderGrid.
import { FORMAT_COLORS, FormatColor, FormatRule, MAX_FORMAT_RULES, conditionError, newRuleId } from '../shared/formatting';

export interface FormattingOptions {
  rules(): FormatRule[];
  /** Saves the rules and colors the table again. */
  change(rules: FormatRule[]): void;
  /** Why each invalid rule colors nothing, by rule id. */
  errors(): Map<string, string>;
  /** The columns' dotted keys, offered for a cell rule's field. */
  fields(): string[];
}

/** What the dialog starts with when adding a rule. */
export interface RulePreset {
  field?: string;
  condition?: string;
}

const COLOR_NAMES: Record<FormatColor, string> = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };

function swatch(color: FormatColor): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'fmt-swatch';
  s.dataset.fmt = color;
  return s;
}

/**
 * Feature: query.format-rules
 * The `Formatting` button of the status bar and its panel.
 */
export class FormattingPanel {
  private readonly panel = document.getElementById('formattingPanel')!;
  private readonly list = document.getElementById('formattingList')!;
  private readonly button = document.getElementById('formattingBtn')!;
  private dragId: string | null = null;

  constructor(
    private readonly opts: FormattingOptions,
    private readonly dialog: FormatDialog,
  ) {
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen) this.close();
      else this.open();
    });
    document.getElementById('formattingAdd')!.addEventListener('click', () => this.edit());
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
    this.render();
    (this.list.querySelector('input, button') as HTMLElement | null)?.focus();
  }

  close(): void {
    this.panel.classList.add('hidden');
    this.button.setAttribute('aria-expanded', 'false');
  }

  /** Updates the button's label; re-renders the list when open. */
  update(): void {
    const on = this.opts.rules().filter((r) => r.enabled !== false).length;
    this.button.textContent = on ? `Formatting (${on})` : 'Formatting';
    if (this.isOpen) this.render();
  }

  /** Opens the dialog for a rule, or for a new one; the panel comes back after it, if it was open. */
  edit(rule?: FormatRule, preset?: RulePreset): void {
    const reopen = this.isOpen;
    this.close();
    this.dialog.open(rule, preset, () => reopen && this.open());
  }

  private render(): void {
    const rules = this.opts.rules();
    const errors = this.opts.errors();
    this.list.replaceChildren();
    if (!rules.length) {
      const empty = document.createElement('div');
      empty.className = 'columns-empty';
      empty.textContent = "No formatting rules. Add one, or use Format Cells… in a column header's menu.";
      this.list.append(empty);
      return;
    }
    for (const rule of rules) this.list.append(this.row(rule, errors.get(rule.id)));
  }

  private replace(id: string, change: (r: FormatRule) => FormatRule | undefined): void {
    const next = this.opts.rules().flatMap((r) => (r.id === id ? (change(r) ?? []) : [r]));
    this.opts.change(next);
  }

  private row(rule: FormatRule, error: string | undefined): HTMLElement {
    const row = document.createElement('div');
    row.className = 'columns-row formatting-row';
    row.classList.toggle('dim', rule.enabled === false);
    row.classList.toggle('invalid', !!error);
    row.draggable = true;
    row.title = `${rule.field ? `The cell of ${rule.field}` : 'The row'} when the document matches ${rule.condition}${error ? `\n${error}` : ''}\nDrag to reorder: the first matching rule wins · double-click to edit`;

    const grip = document.createElement('span');
    grip.className = 'columns-grip';
    grip.textContent = '⋮⋮';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = rule.enabled !== false;
    box.title = box.checked ? 'Turn off' : 'Turn on';
    box.setAttribute('aria-label', `${box.title} the rule ${rule.condition}`);
    box.addEventListener('change', () => this.replace(rule.id, ({ enabled: _, ...r }) => (box.checked ? r : { ...r, enabled: false })));
    const target = document.createElement('span');
    target.className = 'formatting-target';
    target.textContent = rule.field ?? 'Row';
    const condition = document.createElement('span');
    condition.className = 'formatting-condition';
    condition.textContent = rule.condition.replace(/\s+/g, ' ');
    row.append(grip, box, swatch(rule.color), target, condition);
    if (error) {
      const warn = document.createElement('span');
      warn.className = 'formatting-warning';
      warn.textContent = '⚠';
      warn.title = error;
      row.append(warn);
    }
    const edit = document.createElement('button');
    edit.className = 'icon';
    edit.textContent = '✎';
    edit.title = 'Edit…';
    edit.addEventListener('click', () => this.edit(rule));
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.addEventListener('click', () => this.replace(rule.id, () => undefined));
    row.append(edit, remove);
    row.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('button, input')) this.edit(rule);
    });

    row.addEventListener('dragstart', (e) => {
      this.dragId = rule.id;
      e.dataTransfer!.setData('text/plain', rule.id);
      e.dataTransfer!.effectAllowed = 'move';
      e.stopPropagation();
    });
    row.addEventListener('dragend', () => (this.dragId = null));
    row.addEventListener('dragover', (e) => {
      if (!this.dragId || this.dragId === rule.id) return;
      e.preventDefault();
      const after = e.offsetY > row.offsetHeight / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-before', 'drop-after');
      if (this.dragId) this.move(this.dragId, rule.id, e.offsetY > row.offsetHeight / 2);
      this.dragId = null;
    });
    return row;
  }

  private move(source: string, target: string, after: boolean): void {
    const rules = this.opts.rules();
    const moving = rules.find((r) => r.id === source);
    if (!moving || source === target) return;
    const rest = rules.filter((r) => r.id !== source);
    const at = rest.findIndex((r) => r.id === target) + (after ? 1 : 0);
    rest.splice(at, 0, moving);
    this.opts.change(rest);
  }
}

/** The dialog `Add formatting rule` / `Edit formatting rule`. */
export class FormatDialog {
  private readonly modal = document.getElementById('formatModal')!;
  private readonly title = document.getElementById('formatTitle')!;
  private readonly rowTarget = document.getElementById('formatRow') as HTMLInputElement;
  private readonly cellTarget = document.getElementById('formatCell') as HTMLInputElement;
  private readonly field = document.getElementById('formatField') as HTMLInputElement;
  private readonly fieldList = document.getElementById('formatFields') as HTMLDataListElement;
  readonly condition = document.getElementById('formatCondition') as HTMLTextAreaElement;
  private readonly colors = document.getElementById('formatColors')!;
  private readonly error = document.getElementById('formatError')!;
  private editing?: FormatRule;
  private color: FormatColor = 'red';
  private onClose?: () => void;

  constructor(private readonly opts: FormattingOptions) {
    for (const color of FORMAT_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fmt-choice';
      b.dataset.color = color;
      b.title = COLOR_NAMES[color];
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', COLOR_NAMES[color]);
      b.append(swatch(color));
      b.addEventListener('click', () => this.setColor(color));
      this.colors.append(b);
    }
    this.rowTarget.addEventListener('change', () => this.syncTarget());
    this.cellTarget.addEventListener('change', () => this.syncTarget());
    this.field.addEventListener('focus', () => (this.cellTarget.checked = true));
    this.condition.addEventListener('input', () => this.showError(undefined));
    this.condition.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.save();
      }
    });
    document.getElementById('formatSave')!.addEventListener('click', () => this.save());
    document.getElementById('formatCancel')!.addEventListener('click', () => this.close());
    document.getElementById('formatClose')!.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  open(rule: FormatRule | undefined, preset: RulePreset | undefined, onClose?: () => void): void {
    this.editing = rule;
    this.onClose = onClose;
    this.title.textContent = rule ? 'Edit formatting rule' : 'Add formatting rule';
    const field = rule ? rule.field : preset?.field;
    this.rowTarget.checked = !field;
    this.cellTarget.checked = !!field;
    this.field.value = field ?? '';
    this.fieldList.replaceChildren(...this.opts.fields().map((k) => Object.assign(document.createElement('option'), { value: k })));
    this.condition.value = rule?.condition ?? preset?.condition ?? '';
    this.condition.dispatchEvent(new Event('input'));
    this.setColor(rule?.color ?? this.unusedColor());
    this.showError(undefined);
    this.syncTarget();
    this.modal.classList.remove('hidden');
    this.condition.focus();
    this.condition.setSelectionRange(this.condition.value.length, this.condition.value.length);
  }

  close(): void {
    if (!this.isOpen) return;
    this.modal.classList.add('hidden');
    const done = this.onClose;
    this.onClose = undefined;
    done?.();
  }

  /** A new rule takes the first color no rule uses yet, so that two rules are told apart. */
  private unusedColor(): FormatColor {
    const used = new Set(this.opts.rules().map((r) => r.color));
    return FORMAT_COLORS.find((c) => !used.has(c)) ?? 'red';
  }

  private setColor(color: FormatColor): void {
    this.color = color;
    for (const b of this.colors.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-checked', String(b.dataset.color === color));
  }

  private syncTarget(): void {
    this.field.classList.toggle('dim', !this.cellTarget.checked);
  }

  private showError(message: string | undefined): void {
    this.error.textContent = message ?? '';
    this.error.classList.toggle('hidden', !message);
    const aboutField = !!message && message.startsWith('Type the field');
    this.condition.classList.toggle('invalid', !!message && !aboutField);
    if (message) (aboutField ? this.field : this.condition).focus();
  }

  private save(): void {
    const field = this.cellTarget.checked ? this.field.value.trim() : undefined;
    if (this.cellTarget.checked && !field) return this.showError('Type the field whose cell is colored.');
    if (field?.startsWith('$')) return this.showError('Type the field whose cell is colored, without $.');
    const error = conditionError(this.condition.value);
    if (error) return this.showError(error);
    const rules = this.opts.rules();
    if (!this.editing && rules.length >= MAX_FORMAT_RULES) return this.showError(`A collection keeps at most ${MAX_FORMAT_RULES} formatting rules.`);
    const rule: FormatRule = { id: this.editing?.id ?? newRuleId(), condition: this.condition.value.trim(), color: this.color };
    if (field) rule.field = field;
    if (this.editing?.enabled === false) rule.enabled = false;
    const next = this.editing ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
    this.opts.change(next);
    this.close();
  }
}
