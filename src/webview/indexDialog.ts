// Index dialog: creates an index or changes an existing one. The definition is edited as a form
// (fields, types and the common options) or as the keys and options createIndex takes; the command
// and, for an existing index, what the change takes are shown while editing.
import type { IndexInfo } from '../shared/messages';
import { isPlainObject, parseQuery, prettyShell, toShell } from '../shared/query';
import { IndexSpec, KEY_TYPES, TTL_UNIT_NAMES, defaultIndexName, editableSpec, indexCommand, indexName, normalizeSpec, planIndexChange, ttlParts, ttlSeconds, wildcardWarnings } from '../shared/indexes';

export interface IndexDialogCallbacks {
  /** Creates the index or changes `original`; `ok: false` without a message means cancelled. */
  save(original: string | undefined, keys: string, options: string): Promise<{ ok: boolean; message?: string }>;
  /** The outcome of a change, when the dialog is no longer there to show it. */
  notify(message: string, error: boolean): void;
  copy(text: string): void;
  /** Paths of the fields seen in the collection. */
  fields(): string[];
  indexes(): IndexInfo[];
  documents(): number | undefined;
  collection(): string;
}

const TYPE_LABELS: Record<string, string> = { '1': '1 (ascending)', '-1': '-1 (descending)' };
/** Options with a control of their own in the form; the others go in "More options". */
const FORM_OPTIONS = new Set(['name', 'unique', 'sparse', 'hidden', 'expireAfterSeconds', 'partialFilterExpression', 'collation', 'weights', 'default_language']);
/** Above this many documents, creating an index says that the build takes a while. */
const LARGE_COLLECTION = 100_000;

interface FieldRow {
  row: HTMLElement;
  field: HTMLInputElement;
  type: HTMLSelectElement;
  weight: HTMLInputElement;
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class IndexDialog {
  private readonly modal = el('indexModal');
  private readonly title = el('indexTitle');
  private readonly form = el('indexForm');
  private readonly textBox = el('indexText');
  private readonly formTab = el<HTMLButtonElement>('indexModeForm');
  private readonly textTab = el<HTMLButtonElement>('indexModeText');
  private readonly fieldList = el('indexFields');
  private readonly datalist = el('indexFieldList');
  private readonly name = el<HTMLInputElement>('indexName');
  private readonly unique = el<HTMLInputElement>('indexUnique');
  private readonly sparse = el<HTMLInputElement>('indexSparse');
  private readonly hidden = el<HTMLInputElement>('indexHidden');
  private readonly ttl = el<HTMLInputElement>('indexTtl');
  private readonly ttlValue = el<HTMLInputElement>('indexTtlValue');
  private readonly ttlUnit = el<HTMLSelectElement>('indexTtlUnit');
  private readonly partial = el<HTMLInputElement>('indexPartial');
  private readonly partialFilter = el<HTMLTextAreaElement>('indexPartialFilter');
  private readonly collation = el<HTMLInputElement>('indexCollation');
  private readonly collationValue = el<HTMLInputElement>('indexCollationValue');
  private readonly language = el<HTMLInputElement>('indexLanguage');
  private readonly more = el<HTMLTextAreaElement>('indexMore');
  private readonly keys = el<HTMLTextAreaElement>('indexKeys');
  private readonly options = el<HTMLTextAreaElement>('indexOptions');
  private readonly preview = el('indexPreview');
  private readonly warnings = el('indexWarnings');
  private readonly plan = el('indexPlan');
  private readonly error = el('indexError');
  private readonly saveButton = el<HTMLButtonElement>('indexSave');
  private readonly cancelButton = el<HTMLButtonElement>('indexCancel');
  private readonly copyButton = el<HTMLButtonElement>('indexCopy');
  private rows: FieldRow[] = [];
  private textMode = false;
  /** The index being changed, as it is now; undefined when creating one. */
  private original?: { name: string; spec: IndexSpec };
  private busy = false;
  /** Tells the answer to a save apart from one of a dialog closed meanwhile. */
  private session = 0;

  constructor(private readonly cb: IndexDialogCallbacks) {
    for (const unit of TTL_UNIT_NAMES) this.ttlUnit.append(new Option(unit, unit));
    el('indexClose').addEventListener('click', () => this.close());
    this.cancelButton.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    el('indexAddField').addEventListener('click', () => {
      this.addRow('', 1).field.focus();
      this.update();
    });
    this.formTab.addEventListener('click', () => this.setTextMode(false));
    this.textTab.addEventListener('click', () => this.setTextMode(true));
    this.saveButton.addEventListener('click', () => void this.save());
    this.copyButton.addEventListener('click', () => {
      const spec = this.read();
      if ('spec' in spec) this.cb.copy(indexCommand(this.cb.collection(), spec.spec));
    });
    this.modal.addEventListener('input', () => this.update());
    this.modal.addEventListener('change', () => this.update());
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.save();
      }
    });
    // Typing the value of an option turns the option on.
    const turnsOn: [HTMLElement, HTMLInputElement][] = [
      [this.ttlValue, this.ttl],
      [this.ttlUnit, this.ttl],
      [this.partialFilter, this.partial],
      [this.collationValue, this.collation],
    ];
    for (const [input, box] of turnsOn) input.addEventListener('input', () => (box.checked = true));
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  /** An empty dialog, one on a copy of `spec`, or one changing the index `original` (whose definition is `spec`). */
  open(spec?: IndexSpec, original?: string): void {
    this.session++;
    this.busy = false;
    this.original = spec && original !== undefined ? { name: original, spec } : undefined;
    this.title.textContent = this.original ? `Edit index · ${original}` : `Create index · ${this.cb.collection()}`;
    this.refreshFields();
    this.showError(null);
    const start = spec ?? { keys: {}, options: {} };
    // What the form can't show (a key that is neither a direction nor a type) is edited as text.
    this.textMode = !this.fillForm(start);
    if (this.textMode) this.fillText(start);
    this.showMode();
    this.update();
    this.modal.classList.remove('hidden');
    (this.textMode ? this.keys : this.rows[0]?.field ?? this.name).focus();
  }

  close(): void {
    // A build goes on without the dialog: its outcome is shown in the tab.
    this.session++;
    this.modal.classList.add('hidden');
  }

  /** The fields of the collection arrived or changed: they are suggested in the field names. */
  refreshFields(): void {
    this.datalist.replaceChildren(...this.cb.fields().map((path) => new Option(path, path)));
  }

  // ---- form

  private addRow(field: string, type: unknown, weight?: unknown): FieldRow {
    const row = document.createElement('div');
    row.className = 'index-field';
    const name = document.createElement('input');
    name.spellcheck = false;
    name.placeholder = 'field, nested.field or $** for every field';
    name.setAttribute('list', this.datalist.id);
    name.setAttribute('aria-label', 'Field');
    name.value = field;
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Direction or type');
    select.title = 'Direction of the field in the index, or the type of index';
    const value = String(type);
    for (const t of new Set(['1', '-1', ...KEY_TYPES, value])) select.append(new Option(TYPE_LABELS[t] ?? t, t));
    select.value = value;
    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.min = '1';
    weightInput.className = 'index-weight';
    weightInput.placeholder = 'weight';
    weightInput.title = 'Weight of the field in the text score (1 when empty)';
    weightInput.value = weight === undefined ? '' : String(weight);
    const entry: FieldRow = { row, field: name, type: select, weight: weightInput };
    const move = (by: number) => {
      const i = this.rows.indexOf(entry);
      const j = i + by;
      if (j < 0 || j >= this.rows.length) return;
      this.rows.splice(i, 1);
      this.rows.splice(j, 0, entry);
      this.fieldList.replaceChildren(...this.rows.map((r) => r.row));
      this.update();
    };
    row.append(
      name,
      select,
      weightInput,
      iconButton('↑', 'Move up: the order of the fields is part of the index', () => move(-1)),
      iconButton('↓', 'Move down', () => move(1)),
      iconButton('✕', 'Remove the field', () => {
        this.rows.splice(this.rows.indexOf(entry), 1);
        row.remove();
        this.update();
      }),
    );
    this.rows.push(entry);
    this.fieldList.append(row);
    return entry;
  }

  /** Shows the definition in the form; false when it has keys the form can't show. */
  private fillForm(spec: IndexSpec): boolean {
    const o = spec.options;
    const entries = Object.entries(spec.keys);
    if (!entries.every(([, v]) => v === 1 || v === -1 || typeof v === 'string')) return false;
    const weights = isPlainObject(o.weights) && Object.entries(o.weights).every(([f, w]) => spec.keys[f] === 'text' && typeof w === 'number') ? o.weights : undefined;

    this.rows = [];
    this.fieldList.replaceChildren();
    for (const [field, type] of entries) this.addRow(field, type, weights?.[field]);
    if (!entries.length) this.addRow('', 1);

    const more: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!FORM_OPTIONS.has(k)) more[k] = v;
    const flag = (box: HTMLInputElement, key: string) => {
      box.checked = o[key] === true;
      if (o[key] !== undefined && typeof o[key] !== 'boolean') more[key] = o[key];
    };
    this.name.value = typeof o.name === 'string' ? o.name : '';
    flag(this.unique, 'unique');
    flag(this.sparse, 'sparse');
    flag(this.hidden, 'hidden');

    const ttl = typeof o.expireAfterSeconds === 'number' ? ttlParts(o.expireAfterSeconds) : undefined;
    this.ttl.checked = !!ttl;
    this.ttlValue.value = ttl ? String(ttl.value) : '';
    this.ttlUnit.value = ttl?.unit ?? 'days';
    if (!ttl && o.expireAfterSeconds !== undefined) more.expireAfterSeconds = o.expireAfterSeconds;

    const object = (box: HTMLInputElement, input: HTMLInputElement | HTMLTextAreaElement, key: string, format: (v: unknown) => string) => {
      box.checked = isPlainObject(o[key]);
      input.value = box.checked ? format(o[key]) : '';
      if (!box.checked && o[key] !== undefined) more[key] = o[key];
    };
    object(this.partial, this.partialFilter, 'partialFilterExpression', (v) => prettyShell(v, 0, 60));
    object(this.collation, this.collationValue, 'collation', (v) => toShell(v));
    this.language.value = typeof o.default_language === 'string' ? o.default_language : '';
    if (o.weights !== undefined && !weights) more.weights = o.weights;
    this.more.value = Object.keys(more).length ? prettyShell(more, 0, 60) : '';
    return true;
  }

  private readForm(): IndexSpec {
    const keys: Record<string, unknown> = {};
    const weights: Record<string, number> = {};
    for (const r of this.rows) {
      const field = r.field.value.trim();
      if (!field) continue;
      if (field in keys) throw new Error(`The field ${field} is listed twice.`);
      const type = r.type.value;
      keys[field] = type === '1' || type === '-1' ? Number(type) : type;
      if (type === 'text' && r.weight.value.trim()) {
        const w = Number(r.weight.value);
        if (!Number.isInteger(w) || w < 1) throw new Error(`The weight of ${field} must be a whole number from 1.`);
        weights[field] = w;
      }
    }
    if (!Object.keys(keys).length) throw new Error('Add at least one field to index.');

    const options: Record<string, unknown> = { ...object(this.more.value, 'More options') };
    if (this.name.value.trim()) options.name = this.name.value.trim();
    if (this.unique.checked) options.unique = true;
    if (this.sparse.checked) options.sparse = true;
    if (this.hidden.checked) options.hidden = true;
    if (this.ttl.checked) {
      const value = Number(this.ttlValue.value);
      if (!this.ttlValue.value.trim() || !Number.isInteger(value) || value < 0) throw new Error('TTL: enter after how long the documents expire.');
      options.expireAfterSeconds = ttlSeconds(value, this.ttlUnit.value);
    }
    if (this.partial.checked) {
      if (!this.partialFilter.value.trim()) throw new Error('Partial: enter the filter of the documents to index, e.g. { status: "active" }');
      options.partialFilterExpression = object(this.partialFilter.value, 'Partial filter');
    }
    if (this.collation.checked) {
      if (!this.collationValue.value.trim()) throw new Error('Collation: enter at least the locale, e.g. { locale: "en", strength: 2 }');
      options.collation = object(this.collationValue.value, 'Collation');
    }
    if (Object.keys(weights).length) options.weights = weights;
    if (this.language.value.trim()) options.default_language = this.language.value.trim();
    return { keys, options };
  }

  // ---- text

  private fillText(spec: IndexSpec): void {
    this.keys.value = Object.keys(spec.keys).length ? prettyShell(spec.keys, 0, 60) : '';
    this.options.value = Object.keys(spec.options).length ? prettyShell(spec.options, 0, 60) : '';
  }

  private readText(): IndexSpec {
    const keys = object(this.keys.value, 'Keys');
    if (!Object.keys(keys).length) throw new Error('Keys: enter the fields to index, e.g. { status: 1, createdAt: -1 }');
    return { keys, options: object(this.options.value, 'Options') };
  }

  private setTextMode(text: boolean): void {
    if (text === this.textMode || this.busy) return;
    this.showError(null);
    if (text) {
      // An unfinished form still opens as text, with what could be read of it.
      try {
        this.fillText(this.readForm());
      } catch {
        this.fillText({ keys: {}, options: {} });
      }
    } else {
      let spec: IndexSpec;
      try {
        spec = this.keys.value.trim() || this.options.value.trim() ? { keys: object(this.keys.value, 'Keys'), options: object(this.options.value, 'Options') } : { keys: {}, options: {} };
      } catch (err) {
        this.showError((err as Error).message);
        return;
      }
      if (!this.fillForm(spec)) {
        this.showError('These keys can only be edited as text: the form takes a direction (1, -1) or an index type for each field.');
        return;
      }
    }
    this.textMode = text;
    this.showMode();
    this.update();
  }

  private showMode(): void {
    this.form.classList.toggle('hidden', this.textMode);
    this.textBox.classList.toggle('hidden', !this.textMode);
    this.formTab.setAttribute('aria-selected', String(!this.textMode));
    this.textTab.setAttribute('aria-selected', String(this.textMode));
  }

  // ---- state

  private read(): { spec: IndexSpec } | { error: string } {
    try {
      return { spec: this.textMode ? this.readText() : this.readForm() };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** After every edit: the command, and what saving would do. */
  private update(): void {
    const hasText = this.rows.some((r) => r.type.value === 'text');
    for (const r of this.rows) r.weight.classList.toggle('hidden', r.type.value !== 'text');
    this.form.classList.toggle('has-text', hasText);

    const result = this.read();
    const spec = 'spec' in result ? result.spec : undefined;
    this.name.placeholder = spec ? defaultIndexName(spec.keys) : 'generated from the fields';
    this.preview.textContent = spec ? indexCommand(this.cb.collection(), spec) : '';
    this.preview.classList.toggle('no-command', !spec);
    this.copyButton.disabled = !spec;

    // What the server would refuse, or build differently from what was meant: said before saving.
    const warnings = spec ? wildcardWarnings(spec) : [];
    this.warnings.replaceChildren(
      ...warnings.map((w) => {
        const line = document.createElement('div');
        line.textContent = w;
        return line;
      }),
    );
    this.warnings.classList.toggle('hidden', !warnings.length);

    let note = '';
    let warn = false;
    let unchanged = false;
    if (spec && this.original) {
      const change = planIndexChange(this.original.spec, spec);
      unchanged = change.kind === 'none';
      if (change.kind === 'none') note = 'No changes yet.';
      else if (change.kind === 'modify') note = 'Applied to the existing index: nothing is built again.';
      else {
        warn = true;
        note = `MongoDB can't change the ${change.changed.join(', ')} of an existing index: it will be dropped and built again, after a confirmation.`;
      }
    } else if (spec) {
      const indexes = this.cb.indexes();
      const keys = JSON.stringify(spec.keys);
      const named = indexes.find((ix) => ix.name === indexName(spec));
      const same = indexes.find((ix) => JSON.stringify(editableSpec(ix.name, ix.key, ix.options).keys) === keys);
      const documents = this.cb.documents() ?? 0;
      warn = !!(named ?? same);
      if (named) note = `The collection already has an index named ${named.name}.`;
      else if (same) note = `The index ${same.name} already has these keys: MongoDB takes a second one only with a different collation, partial filter, sparse or unique.`;
      else if (documents >= LARGE_COLLECTION) {
        note = `The build reads the ${documents.toLocaleString()} documents of the collection: it can take a while and loads the server.`;
      }
    }
    this.plan.textContent = note;
    this.plan.classList.toggle('warn', warn);
    this.plan.classList.toggle('hidden', !note);

    const verb = this.original ? ['Save changes', 'Saving…'] : ['Create index', 'Creating…'];
    this.saveButton.textContent = verb[this.busy ? 1 : 0];
    this.saveButton.disabled = this.busy || unchanged;
    this.cancelButton.textContent = this.busy ? 'Close' : 'Cancel';
    this.cancelButton.title = this.busy ? 'The index keeps being built: the Indexes tab shows when it is done' : '';
    this.modal.classList.toggle('busy', this.busy);
  }

  private async save(): Promise<void> {
    if (this.busy || this.saveButton.disabled) return;
    const result = this.read();
    if ('error' in result) {
      this.showError(result.error);
      return;
    }
    this.showError(null);
    const { keys, options } = normalizeSpec(result.spec);
    const session = this.session;
    this.busy = true;
    this.update();
    const res = await this.cb.save(this.original?.name, toShell(keys), Object.keys(options).length ? toShell(options) : '');
    if (session !== this.session) {
      if (res.message) this.cb.notify(res.message, !res.ok);
      return;
    }
    this.busy = false;
    if (res.ok) {
      this.close();
      if (res.message) this.cb.notify(res.message, false);
      return;
    }
    // No message: the confirmation was cancelled.
    if (res.message) this.showError(res.message);
    this.update();
  }

  private showError(message: string | null): void {
    this.error.textContent = message ?? '';
    this.error.classList.toggle('hidden', !message);
  }
}

/** A mongosh object from one of the dialog's inputs; empty text is no options. */
function object(source: string, label: string): Record<string, unknown> {
  if (!source.trim()) return {};
  let value: unknown;
  try {
    value = parseQuery(source);
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must be an object, e.g. { … }`);
  return value;
}

function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'icon';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
