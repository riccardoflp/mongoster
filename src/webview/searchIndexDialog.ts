// Search index dialog: creates an Atlas Search or Vector Search index, or changes the definition of
// one. The definition is edited as text (mongosh syntax, with colors and suggestions); the templates
// and the form above it (mapped fields; vector path, dimensions, similarity, filter fields) rewrite
// the parts of it they show, and follow what is typed in it.
import type { FieldHint } from '../shared/complete';
import type { SearchIndexInfo } from '../shared/messages';
import { isPlainObject, parseQuery, prettyShell, toShell } from '../shared/query';
import {
  DEFAULT_NAMES,
  QUANTIZATIONS,
  SIMILARITIES,
  SearchIndexType,
  VectorForm,
  dynamicDefinition,
  mappedPaths,
  readVectorForm,
  searchFieldTypes,
  searchIndexCommand,
  setMapped,
  staticDefinition,
  vectorCandidates,
  vectorDefinition,
  writeVectorForm,
} from '../shared/searchIndexes';

export interface SearchIndexDialogCallbacks {
  /** Creates the index or changes `original`. */
  save(original: string | undefined, name: string, type: SearchIndexType, definition: string): Promise<{ ok: boolean; message?: string }>;
  /** The outcome, when the dialog is no longer there to show it. */
  notify(message: string, error: boolean): void;
  copy(text: string): void;
  fields(): FieldHint[];
  indexes(): SearchIndexInfo[];
  collection(): string;
}

type Definition = Record<string, unknown>;
/** BSON types a vector index can filter on. */
const FILTER_TYPES = new Set(['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId', 'binData']);

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class SearchIndexDialog {
  private readonly modal = el('searchIndexModal');
  private readonly title = el('searchIndexTitle');
  private readonly name = el<HTMLInputElement>('searchIndexName');
  private readonly searchTab = el<HTMLButtonElement>('searchTypeSearch');
  private readonly vectorTab = el<HTMLButtonElement>('searchTypeVector');
  private readonly path = el<HTMLInputElement>('searchVectorPath');
  private readonly paths = el('searchVectorPaths');
  private readonly dims = el<HTMLInputElement>('searchVectorDims');
  private readonly similarity = el<HTMLSelectElement>('searchVectorSimilarity');
  private readonly quantization = el<HTMLSelectElement>('searchVectorQuantization');
  private readonly fieldsLabel = el('searchFieldsLabel');
  private readonly fieldList = el('searchFieldList');
  readonly definition = el<HTMLTextAreaElement>('searchIndexDefinition');
  private readonly preview = el('searchIndexPreview');
  private readonly plan = el('searchIndexPlan');
  private readonly error = el('searchIndexError');
  private readonly saveButton = el<HTMLButtonElement>('searchIndexSave');
  private readonly cancelButton = el<HTMLButtonElement>('searchIndexCancel');
  private readonly copyButton = el<HTMLButtonElement>('searchIndexCopy');
  private type: SearchIndexType = 'search';
  /** The index being changed, as it is now; undefined when creating one. */
  private original?: SearchIndexInfo;
  /** What was written for each type, to switch back and forth while creating. */
  private texts: Partial<Record<SearchIndexType, string>> = {};
  /** The dimensions were filled in from the sampled vectors, not typed. */
  private autoDims = false;
  private busy = false;
  private session = 0;

  constructor(private readonly cb: SearchIndexDialogCallbacks) {
    for (const s of SIMILARITIES) this.similarity.append(new Option(s, s));
    for (const q of QUANTIZATIONS) this.quantization.append(new Option(q, q));
    el('searchIndexClose').addEventListener('click', () => this.close());
    this.cancelButton.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    this.searchTab.addEventListener('click', () => this.setType('search'));
    this.vectorTab.addEventListener('click', () => this.setType('vectorSearch'));
    el('searchTplDynamic').addEventListener('click', () => this.setDefinition(dynamicDefinition()));
    el('searchTplStatic').addEventListener('click', () => this.setDefinition(staticDefinition(this.cb.fields())));
    this.saveButton.addEventListener('click', () => void this.save());
    this.copyButton.addEventListener('click', () => {
      const def = this.parse();
      if ('definition' in def) this.cb.copy(this.command(def.definition));
    });
    this.definition.addEventListener('input', () => {
      this.syncForm();
      this.update();
    });
    this.name.addEventListener('input', () => this.update());
    this.path.addEventListener('input', () => {
      const hint = this.cb.fields().find((h) => h.path === this.path.value.trim());
      if (hint?.vector && (this.autoDims || !this.dims.value)) {
        this.dims.value = String(hint.vector.max);
        this.autoDims = true;
      }
      this.applyVectorForm();
    });
    this.dims.addEventListener('input', () => {
      this.autoDims = false;
      this.applyVectorForm();
    });
    for (const input of [this.similarity, this.quantization]) input.addEventListener('change', () => this.applyVectorForm());
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.save();
      }
    });
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  /** The completion kind of the definition. */
  get kind(): 'searchDefinition' | 'vectorDefinition' {
    return this.type === 'vectorSearch' ? 'vectorDefinition' : 'searchDefinition';
  }

  /** An empty dialog, or one changing the definition of `index`. */
  open(index?: SearchIndexInfo): void {
    this.session++;
    this.busy = false;
    this.original = index;
    this.texts = {};
    this.type = index?.type === 'vectorSearch' ? 'vectorSearch' : 'search';
    this.title.textContent = index ? `Edit search index · ${index.name}` : `Create search index · ${this.cb.collection()}`;
    this.name.value = index?.name ?? '';
    this.name.disabled = !!index;
    this.name.title = index ? 'A search index keeps its name: to rename it, create another one and drop this one' : '';
    this.searchTab.disabled = this.vectorTab.disabled = !!index;
    this.showError(null);
    this.refreshFields();
    this.definition.value = index ? prettyShell(index.definition, 0, 60) : this.template(this.type);
    this.showType();
    this.syncForm();
    this.update();
    this.modal.classList.remove('hidden');
    (index ? this.definition : this.name).focus();
  }

  close(): void {
    this.session++;
    this.modal.classList.add('hidden');
  }

  /** The sampled fields arrived or changed: suggested as vector paths and in the field list. */
  refreshFields(): void {
    this.paths.replaceChildren(
      ...vectorCandidates(this.cb.fields()).map((h) => {
        const v = h.vector!;
        return new Option(`${v.min === v.max ? v.max : `${v.min}–${v.max}`} numbers`, h.path);
      }),
    );
    if (this.isOpen) this.syncForm();
  }

  // ---- type and templates

  private template(type: SearchIndexType): string {
    if (type === 'search') return prettyShell(dynamicDefinition(), 0, 60);
    const [candidate] = vectorCandidates(this.cb.fields());
    this.autoDims = !!candidate;
    return prettyShell(vectorDefinition({ path: candidate?.path ?? '', numDimensions: candidate?.vector?.max, similarity: 'cosine', quantization: 'none', filters: [] }), 0, 60);
  }

  private setType(type: SearchIndexType): void {
    if (type === this.type || this.original || this.busy) return;
    this.texts[this.type] = this.definition.value;
    this.type = type;
    this.definition.value = this.texts[type] ?? this.template(type);
    this.showError(null);
    this.showType();
    this.syncForm();
    this.update();
  }

  private showType(): void {
    const vector = this.type === 'vectorSearch';
    this.modal.classList.toggle('vector', vector);
    this.searchTab.setAttribute('aria-selected', String(!vector));
    this.vectorTab.setAttribute('aria-selected', String(vector));
    this.name.placeholder = DEFAULT_NAMES[this.type];
    this.fieldsLabel.textContent = vector ? 'Filter fields' : 'Fields';
    this.fieldsLabel.title = vector
      ? 'Fields $vectorSearch can pre-filter on (its filter option)'
      : 'Fields indexed one by one (static mapping), with the types seen in the documents';
  }

  private setDefinition(definition: Definition): void {
    this.definition.value = prettyShell(definition, 0, 60);
    this.showError(null);
    this.syncForm();
    this.update();
  }

  // ---- form ⇄ definition

  private parse(): { definition: Definition } | { error: string } {
    if (!this.definition.value.trim()) return { error: 'Enter the definition of the index.' };
    try {
      const value = parseQuery(this.definition.value);
      if (!isPlainObject(value)) return { error: 'The definition must be an object, e.g. { mappings: { dynamic: true } }' };
      return { definition: value };
    } catch (err) {
      return { error: `Definition: ${(err as Error).message}` };
    }
  }

  /** The definition being edited, for a change made with the form; null (and a message) when it can't be read. */
  private current(): Definition | null {
    const result = this.parse();
    if ('definition' in result) return result.definition;
    this.showError(`Fix the definition before changing it with the form: ${result.error}`);
    return null;
  }

  /** The form shows what the definition says. */
  private syncForm(): void {
    const result = this.parse();
    const definition = 'definition' in result ? result.definition : undefined;
    let ticked: string[] = [];
    if (this.type === 'vectorSearch') {
      const form = definition ? readVectorForm(definition) : undefined;
      if (form) {
        if (document.activeElement !== this.path) this.path.value = form.path;
        if (document.activeElement !== this.dims) this.dims.value = form.numDimensions ? String(form.numDimensions) : '';
        this.similarity.value = SIMILARITIES.includes(form.similarity) ? form.similarity : 'cosine';
        this.quantization.value = QUANTIZATIONS.includes(form.quantization) ? form.quantization : 'none';
        ticked = form.filters;
      }
    } else if (definition) {
      ticked = mappedPaths(definition);
    }
    this.renderFields(ticked, !definition);
  }

  private readVectorForm(filters: string[]): VectorForm {
    const dims = Number(this.dims.value);
    return {
      path: this.path.value.trim(),
      numDimensions: this.dims.value.trim() && Number.isFinite(dims) ? dims : undefined,
      similarity: this.similarity.value,
      quantization: this.quantization.value,
      filters,
    };
  }

  private applyVectorForm(): void {
    const definition = this.current();
    if (!definition) return;
    this.definition.value = prettyShell(writeVectorForm(definition, this.readVectorForm(readVectorForm(definition).filters)), 0, 60);
    this.showError(null);
    this.syncForm();
    this.update();
  }

  /** The sampled fields as checkboxes, ticked when the definition has them; `stale`: the definition doesn't parse. */
  private renderFields(ticked: string[], stale: boolean): void {
    const hints = this.cb.fields();
    const vector = this.type === 'vectorSearch';
    const offered = hints.filter((h) => (vector ? !h.vector && h.types.some((t) => FILTER_TYPES.has(t)) : searchFieldTypes(h).length > 0));
    const paths = [...new Set([...offered.map((h) => h.path), ...ticked])];
    this.fieldList.classList.toggle('stale', stale);
    if (!paths.length) {
      const empty = document.createElement('span');
      empty.className = 'index-hint';
      empty.textContent = hints.length ? 'No field of a type that can be indexed here.' : 'The fields of the documents are being read…';
      this.fieldList.replaceChildren(empty);
      return;
    }
    this.fieldList.replaceChildren(
      ...paths.map((path) => {
        const hint = hints.find((h) => h.path === path);
        const label = document.createElement('label');
        label.className = 'search-field';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = ticked.includes(path);
        box.disabled = stale;
        box.addEventListener('change', () => this.toggleField(path, box.checked));
        const name = document.createElement('span');
        name.textContent = path;
        const type = document.createElement('span');
        type.className = 'search-field-type';
        type.textContent = vector ? (hint?.types.filter((t) => t !== 'null').join(' | ') ?? '') : searchFieldTypes(hint).join(' | ');
        label.append(box, name, type);
        label.title = hint ? `${hint.types.join(' | ')} · in ${Math.round(hint.ratio * 100)}% of the documents sampled` : 'Not in the documents sampled';
        return label;
      }),
    );
  }

  private toggleField(path: string, on: boolean): void {
    const definition = this.current();
    if (!definition) {
      this.syncForm();
      return;
    }
    let next: Definition;
    if (this.type === 'vectorSearch') {
      const form = readVectorForm(definition);
      const filters = on ? [...form.filters, path] : form.filters.filter((f) => f !== path);
      next = writeVectorForm(definition, { ...form, filters });
    } else {
      next = setMapped(definition, path, on, this.cb.fields());
    }
    this.definition.value = prettyShell(next, 0, 60);
    this.showError(null);
    this.syncForm();
    this.update();
  }

  // ---- state

  private indexName(): string {
    return this.original?.name ?? (this.name.value.trim() || DEFAULT_NAMES[this.type]);
  }

  private command(definition: Definition): string {
    return searchIndexCommand(this.cb.collection(), this.indexName(), this.type, definition, !!this.original);
  }

  private update(): void {
    const result = this.parse();
    const definition = 'definition' in result ? result.definition : undefined;
    this.preview.textContent = definition ? this.command(definition) : '';
    this.preview.classList.toggle('no-command', !definition);
    this.copyButton.disabled = !definition;

    const notes: string[] = [];
    let warn = false;
    let unchanged = false;
    if (definition && this.original) {
      unchanged = toShell(definition) === toShell(this.original.definition);
      notes.push(unchanged ? 'No changes yet.' : 'The index is built again with the new definition, in the background: queries keep using the current one until it is ready.');
    } else if (!this.original) {
      const name = this.indexName();
      if (this.cb.indexes().some((ix) => ix.name === name)) {
        warn = true;
        notes.push(`The collection already has a search index named ${name}.`);
      }
    }
    if (definition && this.type === 'vectorSearch') {
      const form = readVectorForm(definition);
      const hint = this.cb.fields().find((h) => h.path === form.path);
      if (hint?.vector && form.numDimensions && (form.numDimensions < hint.vector.min || form.numDimensions > hint.vector.max)) {
        warn = true;
        const seen = hint.vector.min === hint.vector.max ? `${hint.vector.max}` : `${hint.vector.min} to ${hint.vector.max}`;
        notes.push(`The vectors of ${form.path} in the documents sampled have ${seen} numbers, not ${form.numDimensions}: documents whose vector has another length aren't indexed.`);
      } else if (form.path && hint && !hint.vector) {
        warn = true;
        notes.push(`${form.path} isn't an array of numbers in the documents sampled.`);
      }
    } else if (definition) {
      const mappings = isPlainObject(definition.mappings) ? definition.mappings : undefined;
      if (mappings && mappings.dynamic !== true && !isPlainObject(mappings.dynamic) && !mappedPaths(definition).length) {
        warn = true;
        notes.push('No field is mapped: the index would find nothing. Turn on the dynamic mapping or tick some fields.');
      }
    }
    this.plan.textContent = notes.join(' ');
    this.plan.classList.toggle('warn', warn);
    this.plan.classList.toggle('hidden', !notes.length);

    const verb = this.original ? ['Save changes', 'Saving…'] : ['Create search index', 'Creating…'];
    this.saveButton.textContent = verb[this.busy ? 1 : 0];
    this.saveButton.disabled = this.busy || unchanged;
    this.modal.classList.toggle('busy', this.busy);
  }

  private async save(): Promise<void> {
    if (this.busy || this.saveButton.disabled) return;
    const result = this.parse();
    if ('error' in result) {
      this.showError(result.error);
      return;
    }
    this.showError(null);
    const session = this.session;
    this.busy = true;
    this.update();
    const res = await this.cb.save(this.original?.name, this.indexName(), this.type, toShell(result.definition));
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
    if (res.message) this.showError(res.message);
    this.update();
  }

  private showError(message: string | null): void {
    this.error.textContent = message ?? '';
    this.error.classList.toggle('hidden', !message);
  }
}
