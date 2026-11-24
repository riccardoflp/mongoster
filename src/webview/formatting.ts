// Conditional formatting in the collection tab: the Formatting pane, docked at the right of the table. It lists the
// formatting rules (reorder, turn on and off, name, remove), edits a rule in place while the table repaints, shows
// the legend of a field rule (its values with their colors, or the ends of its scale), and hides or shows every color
// with one button. The colors themselves are decided by TableFormat in src/shared/formatting.ts and painted by
// renderGrid, with `applyPaint`. The rules are in four sections, one per scope (this collection, its database, its
// connection, everywhere); a rule is moved or copied from one to another by dragging it or from its menu.
import { cssColorOf, colorLabel } from '../shared/colors';
import { Legend, LegendEntry, VALUE_COLORS, fieldLegend, resolveField, valueText } from '../shared/formatField';
import {
  ConditionRule,
  FORMATTING_PANE_WIDTH,
  FORMAT_COLORS,
  FORMAT_SCOPES,
  FieldRule,
  FormatColor,
  FormatPaint,
  FormatRule,
  FormatScope,
  FormattingPane,
  MAX_FORMAT_RULES,
  MAX_PINNED,
  SCOPE_FULL,
  ScopedRules,
  conditionError,
  isFieldRule,
  moveRule,
  newRuleId,
  paintLevel,
  readFormattingPane,
  ruleSummary,
  rulesInOrder,
  scopeOfRule,
} from '../shared/formatting';
import { parseQuery } from '../shared/query';
import { MenuItem, PopupMenu } from './popupMenu';

export interface FormattingOptions {
  /** The rules that reach the collection, by scope. */
  rules(): ScopedRules;
  /** Saves the rules of the scopes that changed and colors the table again. */
  change(changes: Partial<ScopedRules>): void;
  /** The scopes whose rules this collection does not take. */
  off(): FormatScope[];
  setOff(off: FormatScope[]): void;
  /** `Export Formatting…` and `Import Formatting…`: the host asks what and where. */
  transfer(what: 'export' | 'import'): void;
  /** The names the sections of the database and the connection show. */
  names(): { database: string; connection: string };
  /** Why each invalid rule colors nothing, by rule id. */
  errors(): Map<string, string>;
  /** The columns' dotted keys, offered for a rule's field. */
  fields(): string[];
  /** The documents of the page, for the legends. */
  docs(): unknown[];
  /** Gives a condition's text area the filter's highlighting and autocompletion. */
  complete(field: HTMLTextAreaElement): void;
  /** Saves the pane's state for every tab; the table is colored again when its colors are hidden or shown. */
  savePane(pane: FormattingPane, recolor: boolean): void;
}

/** What a new condition rule starts with. */
export interface RulePreset {
  field?: string;
  condition?: string;
}

/**
 * Sets a rule's color on a row (its tbody), a cell or a swatch: `data-fmt` names the color, and the strength, a color
 * on its way to another and the outline are set on the element for the styles of media/webview.css.
 */
export function applyPaint(el: HTMLElement, paint: FormatPaint | undefined, target: 'row' | 'cell'): void {
  if (!paint) return;
  el.dataset.fmt = paint.color;
  if (paint.toward) {
    el.style.setProperty('--fmt-solid', `color-mix(in srgb, ${cssColorOf(paint.toward.color)} ${Math.round(paint.toward.share * 100)}%, ${cssColorOf(paint.color)})`);
  }
  if (paint.strength !== undefined) el.style.setProperty('--fmt-level', `${paintLevel(paint, target)}%`);
  if (paint.outlined) el.dataset.fmtOutlined = '';
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function swatch(paint: FormatPaint): HTMLSpanElement {
  const s = make('span', 'fmt-swatch');
  applyPaint(s, paint, 'cell');
  return s;
}

function labeled(text: string, control: HTMLElement): HTMLLabelElement {
  const l = make('label', 'fmt-field');
  l.append(make('span', 'fmt-field-name', text), control);
  return l;
}

function select<T extends string>(options: [T, string][], value: T, title: string, change: (value: T) => void): HTMLSelectElement {
  const s = make('select');
  s.title = title;
  for (const [v, label] of options) s.append(Object.assign(make('option'), { value: v, textContent: label }));
  s.value = value;
  s.addEventListener('change', () => change(s.value as T));
  return s;
}

/** The scales between two colors that are offered; any other scale is one color growing stronger. */
const TWO_COLOR_SCALES: Record<string, { from: FormatColor; to: FormatColor }> = {
  'red-green': { from: 'red', to: 'green' },
  'green-red': { from: 'green', to: 'red' },
};

const isValid = (rule: FormatRule) => (isFieldRule(rule) ? !!rule.field && !rule.field.startsWith('$') : !conditionError(rule.condition));

/**
 * Feature: query.format-rules
 * The `Formatting` button of the status bar and the pane it opens and closes.
 */
export class FormattingPaneUi {
  private readonly paneEl = document.getElementById('formattingPane')!;
  private readonly list = document.getElementById('formattingList')!;
  private readonly button = document.getElementById('formattingBtn')!;
  private readonly eye = document.getElementById('formattingEye')!;
  private readonly splitter = document.getElementById('formattingSplitter')!;
  private readonly menu = new PopupMenu(document.getElementById('formattingMenu')!);
  private pane: FormattingPane = readFormattingPane(undefined);
  /** The rule open for editing. */
  private openId: string | null = null;
  /** A rule being added that can't color anything yet (no condition, no field): shown last in the collection's, not stored. */
  private draft: FormatRule | null = null;
  /** The value of the open field rule whose color is being chosen. */
  private pinning: string | null = null;
  private dragId: string | null = null;
  /** Set while the pane itself saves a change made by typing, so that the list is not rebuilt under the caret. */
  private typing = false;
  private fieldList = make('datalist');

  constructor(private readonly opts: FormattingOptions) {
    this.fieldList.id = 'formattingFields';
    this.paneEl.append(this.fieldList);
    this.button.addEventListener('click', () => this.setPane({ ...this.pane, open: !this.pane.open }));
    document.getElementById('formattingClose')!.addEventListener('click', () => this.setPane({ ...this.pane, open: false }));
    this.eye.addEventListener('click', () => this.setPane({ ...this.pane, hidden: !this.pane.hidden }));
    const add = document.getElementById('formattingAdd')!;
    add.addEventListener('click', () =>
      this.menu.openBelow(add, [
        { label: 'Condition…', title: 'Color the row or a cell of the documents matching a filter', action: () => this.addCondition() },
        { label: 'By Field…', title: "Color by a field's values: true and false, a scale for numbers and dates, a color per value", action: () => this.addField() },
      ]),
    );
    const more = document.getElementById('formattingMore')!;
    more.addEventListener('click', () =>
      this.menu.openBelow(more, [
        { label: 'Export Formatting…', title: 'Write formatting rules to a file, to share them; nothing of the connection is in it', action: () => this.opts.transfer('export') },
        { label: 'Import Formatting…', title: 'Add the formatting rules of a file to the ones already here', action: () => this.opts.transfer('import') },
      ]),
    );
    this.dragging();
  }

  /** `Hide Formatting` is on: the table shows no color. */
  get hidden(): boolean {
    return this.pane.hidden;
  }

  get isOpen(): boolean {
    return this.pane.open;
  }

  /** The stored state (at init, or changed in another tab). */
  apply(pane: FormattingPane): void {
    this.pane = pane;
    this.paint();
    this.update();
  }

  close(): void {
    if (this.pane.open) this.setPane({ ...this.pane, open: false });
  }

  /** The rules or the page changed: the button's label, and the list when the pane is open. */
  update(): void {
    const on = rulesInOrder(this.opts.rules(), this.opts.off()).filter((r) => r.enabled !== false).length;
    this.button.textContent = this.pane.hidden ? 'Formatting (off)' : on ? `Formatting (${on})` : 'Formatting';
    if (this.pane.open && !this.typing) this.render();
  }

  /** A new condition rule: added at once when its condition is given, else typed in the pane first. */
  addCondition(preset?: RulePreset): void {
    if (this.full()) return;
    const rule: ConditionRule = { id: newRuleId(), condition: preset?.condition ?? '', color: this.unusedColor() };
    if (preset?.field) rule.field = preset.field;
    this.add(rule, '.fmt-condition');
  }

  /**
   * Feature: query.format-rules
   * A new field rule, `auto`. The first field rule of the list colors the row, the next ones their cell; a scale
   * takes its ends from the page.
   */
  addField(field = ''): void {
    if (this.full()) return;
    const first = !this.own().some(isFieldRule);
    this.add(this.withEnds({ id: newRuleId(), kind: 'field', field, target: first ? 'row' : 'cell', mode: 'auto' }), '.fmt-rule-field');
  }

  private add(rule: FormatRule, focus: string): void {
    this.openId = rule.id;
    this.pinning = null;
    if (isValid(rule)) {
      this.draft = null;
      this.opts.change({ collection: [...this.own(), rule] });
    } else {
      this.draft = rule;
    }
    if (!this.pane.open) this.setPane({ ...this.pane, open: true });
    else this.render();
    const el = this.list.querySelector<HTMLElement>(`.fmt-rule.open ${focus}`);
    el?.scrollIntoView({ block: 'nearest' });
    if (this.draft) el?.focus();
  }

  /** The collection's own rules: where a new rule goes. */
  private own(): FormatRule[] {
    return this.opts.rules().collection;
  }

  private full(): boolean {
    if (this.own().length < MAX_FORMAT_RULES) return false;
    if (!this.pane.open) this.setPane({ ...this.pane, open: true });
    this.note(`A collection keeps at most ${MAX_FORMAT_RULES} formatting rules.`);
    return true;
  }

  private note(text: string): void {
    const n = document.getElementById('formattingNote')!;
    n.textContent = text;
    n.classList.toggle('hidden', !text);
  }

  /** A scale without ends takes the ones of the page, so that a value keeps its color on the next page. */
  private withEnds(rule: FieldRule): FieldRule {
    if (!rule.field || (rule.min !== undefined && rule.max !== undefined)) return rule;
    const r = resolveField(rule, this.opts.docs());
    if (r.mode !== 'scale' || r.min === undefined || r.max === undefined) return rule;
    return { ...rule, min: rule.min ?? r.min, max: rule.max ?? r.max };
  }

  /** A new rule takes the first color no rule uses yet, so that two rules are told apart. */
  private unusedColor(): FormatColor {
    const used = new Set(rulesInOrder(this.opts.rules()).map((r) => (isFieldRule(r) ? undefined : r.color)));
    return FORMAT_COLORS.find((c) => !used.has(c)) ?? 'red';
  }

  private setPane(pane: FormattingPane): void {
    const recolor = pane.hidden !== this.pane.hidden;
    this.pane = pane;
    if (!pane.open) this.draft = null;
    this.paint();
    this.opts.savePane(pane, recolor);
    if (!recolor) this.update();
  }

  private paint(): void {
    document.body.classList.toggle('fmt-pane-open', this.pane.open);
    document.body.classList.toggle('fmt-hidden', this.pane.hidden);
    document.body.style.setProperty('--fmt-pane-width', `${this.pane.width}px`);
    this.button.setAttribute('aria-expanded', String(this.pane.open));
    this.eye.setAttribute('aria-pressed', String(this.pane.hidden));
    this.eye.classList.toggle('active', this.pane.hidden);
    this.eye.textContent = this.pane.hidden ? 'Show Formatting' : 'Hide Formatting';
    this.eye.title = this.pane.hidden ? 'Color the tables again by the rules' : 'Show the tables without colors; the rules stay as they are';
    this.splitter.setAttribute('aria-valuenow', String(this.pane.width));
  }

  /** Dragging the splitter, at the pane's left edge, resizes it live and saves the width when released. */
  private dragging(): void {
    const clamp = (w: number) => readFormattingPane({ width: w }).width;
    this.splitter.setAttribute('aria-valuemin', String(FORMATTING_PANE_WIDTH.min));
    this.splitter.setAttribute('aria-valuemax', String(FORMATTING_PANE_WIDTH.max));
    this.splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = this.pane.width;
      this.splitter.setPointerCapture(e.pointerId);
      document.body.classList.add('pane-resizing');
      const move = (ev: PointerEvent) => {
        this.pane = { ...this.pane, width: clamp(startWidth - (ev.clientX - startX)) };
        this.paint();
      };
      const up = () => {
        this.splitter.removeEventListener('pointermove', move);
        this.splitter.removeEventListener('pointerup', up);
        this.splitter.removeEventListener('pointercancel', up);
        document.body.classList.remove('pane-resizing');
        if (this.pane.width !== startWidth) this.opts.savePane(this.pane, false);
      };
      this.splitter.addEventListener('pointermove', move);
      this.splitter.addEventListener('pointerup', up);
      this.splitter.addEventListener('pointercancel', up);
    });
    this.splitter.addEventListener('dblclick', () => this.setPane({ ...this.pane, width: FORMATTING_PANE_WIDTH.default }));
    this.splitter.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0;
      if (!step) return;
      e.preventDefault();
      this.setPane({ ...this.pane, width: clamp(this.pane.width + step) });
    });
  }

  // -------------------------------------------------------------------------
  // The list

  private render(): void {
    // The control that had the focus gets it back in the rebuilt list.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#formattingList [data-k]')?.dataset.k;
    const scroll = this.list.scrollTop;
    const rules = this.opts.rules();
    const errors = this.opts.errors();
    const off = this.opts.off();
    const fields = new Set(this.opts.fields());
    this.note('');
    this.fieldList.replaceChildren(...[...fields].map((k) => Object.assign(make('option'), { value: k })));
    this.list.replaceChildren();
    if (!this.draft && !rulesInOrder(rules).length) {
      this.list.append(make('div', 'columns-empty', "No formatting rules. Add one, or use Color by This Field or Format Cells… in a column header's menu."));
    }
    for (const scope of FORMAT_SCOPES) {
      const list = scope === 'collection' && this.draft ? [...rules[scope], this.draft] : rules[scope];
      const section = make('div', 'fmt-section');
      section.classList.toggle('off', off.includes(scope));
      section.append(this.sectionHead(scope, list.length, off));
      // A rule about a field this table does not have colors nothing here: usual for the rules of a wider scope.
      const absent = (r: FormatRule) => scope !== 'collection' && !!r.field && fields.size > 0 && !fields.has(r.field);
      for (const rule of list) section.append(this.row(rule, scope, errors.get(rule.id), absent(rule)));
      this.list.append(section);
    }
    this.list.scrollTop = scroll;
    if (focused) this.list.querySelector<HTMLElement>(`.fmt-rule.open [data-k="${focused}"]`)?.focus();
  }

  private scopeTitle(scope: FormatScope): string {
    const { database, connection } = this.opts.names();
    return { collection: 'This collection', database: `Database ${database}`, connection: `Connection ${connection}`, global: 'Everywhere' }[scope];
  }

  /** A section's head: whether this collection takes the scope's rules, its name, how many rules. A rule dropped on it goes last in the scope. */
  private sectionHead(scope: FormatScope, count: number, off: FormatScope[]): HTMLElement {
    const head = make('div', 'fmt-section-head');
    const box = make('input');
    box.type = 'checkbox';
    box.checked = !off.includes(scope);
    const title = this.scopeTitle(scope);
    box.title = box.checked ? `Leave these rules out of this collection's table` : `Color this collection's table by these rules too`;
    box.setAttribute('aria-label', `${title}: ${box.title}`);
    box.addEventListener('change', () => this.opts.setOff(FORMAT_SCOPES.filter((s) => (s === scope ? !box.checked : off.includes(s)))));
    const name = make('span', 'fmt-section-title', title);
    name.title = {
      collection: 'Rules for this collection only',
      database: 'Rules for every collection of this database',
      connection: 'Rules for every collection of this connection',
      global: 'Rules for every collection of every connection',
    }[scope];
    head.append(box, name, make('span', 'fmt-section-count', count ? String(count) : 'no rules'));
    head.addEventListener('dragover', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      head.classList.add('drop-after');
    });
    head.addEventListener('dragleave', () => head.classList.remove('drop-after'));
    head.addEventListener('drop', (e) => {
      e.preventDefault();
      head.classList.remove('drop-after');
      if (this.dragId) this.moveTo(this.dragId, scope);
      this.dragId = null;
    });
    return head;
  }

  /**
   * Feature: query.format-rules
   * Moves a rule to a scope (or within its own), or copies it there: beside a rule, or last.
   */
  private moveTo(id: string, scope: FormatScope, place: { beside?: string; after?: boolean; copy?: boolean } = {}): void {
    const changes = moveRule(this.opts.rules(), id, scope, { beside: place.beside, after: place.after, ...(place.copy && { copyId: newRuleId() }) });
    if (typeof changes === 'string') return this.note(changes === SCOPE_FULL ? `${this.scopeTitle(scope)} keeps at most ${MAX_FORMAT_RULES} formatting rules.` : changes);
    if (changes) this.opts.change(changes);
  }

  /** Replaces a rule (or removes it) in its scope, saves, and rebuilds the list. */
  private replace(id: string, change: (r: FormatRule) => FormatRule | undefined): void {
    if (this.draft?.id === id) {
      const next = change(this.draft);
      this.draft = null;
      if (next && isValid(next)) return this.opts.change({ collection: [...this.own(), next] });
      this.draft = next ?? null;
      return this.render();
    }
    const rules = this.opts.rules();
    const scope = scopeOfRule(rules, id);
    if (scope) this.opts.change({ [scope]: rules[scope].flatMap((r) => (r.id === id ? (change(r) ?? []) : [r])) });
  }

  /**
   * Like `replace`, for a change typed in a text box: the table is colored again but the list stays as it is, with
   * the caret where it was; `after` then updates what the change shows elsewhere in the rule.
   */
  private typed(id: string, change: (r: FormatRule) => FormatRule, after?: () => void): void {
    this.typing = true;
    try {
      if (this.draft?.id === id) {
        this.draft = change(this.draft);
        if (isValid(this.draft)) {
          const rule = this.draft;
          this.draft = null;
          this.opts.change({ collection: [...this.own(), rule] });
        }
      } else {
        const rules = this.opts.rules();
        const scope = scopeOfRule(rules, id);
        if (scope) this.opts.change({ [scope]: rules[scope].map((r) => (r.id === id ? change(r) : r)) });
      }
    } finally {
      this.typing = false;
    }
    after?.();
  }

  private find(id: string): FormatRule | undefined {
    return this.draft?.id === id ? this.draft : rulesInOrder(this.opts.rules()).find((r) => r.id === id);
  }

  private row(rule: FormatRule, scope: FormatScope, error: string | undefined, absent: boolean): HTMLElement {
    const open = this.openId === rule.id;
    const row = make('div', 'fmt-rule');
    row.classList.toggle('absent', absent);
    row.classList.toggle('open', open);
    row.classList.toggle('dim', rule.enabled === false);
    row.classList.toggle('invalid', !!error);

    const head = make('div', 'columns-row fmt-rule-head');
    head.tabIndex = 0;
    head.draggable = rule !== this.draft;
    head.setAttribute('aria-expanded', String(open));
    const grip = make('span', 'columns-grip', '⋮⋮');
    const box = make('input');
    box.type = 'checkbox';
    box.checked = rule.enabled !== false;
    box.title = box.checked ? 'Turn off' : 'Turn on';
    box.addEventListener('change', () => this.replace(rule.id, ({ enabled: _, ...r }) => (box.checked ? r : { ...r, enabled: false })));
    const swatches = make('span', 'fmt-swatches');
    const target = make('span', 'formatting-target');
    const label = make('span', 'formatting-condition');
    const warn = make('span', 'formatting-warning', '⚠');
    const remove = make('button', 'icon', '✕');
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      if (this.openId === rule.id) this.openId = null;
      this.replace(rule.id, () => undefined);
    });
    const more = make('button', 'icon', '⋯');
    more.title = 'Move or copy the rule to another scope';
    more.setAttribute('aria-haspopup', 'menu');
    more.classList.toggle('hidden', rule === this.draft);
    more.addEventListener('click', () => this.menu.openBelow(more, this.scopeItems(rule.id, scope)));
    head.append(grip, box, swatches, target, label, warn, more, remove);

    /** What the head says of the rule; called again when the rule changes while it is open. */
    const describe = (r: FormatRule, problem: string | undefined) => {
      const summary = ruleSummary(r);
      box.setAttribute('aria-label', `${box.title} the rule ${r.name ?? summary}`);
      swatches.replaceChildren(...this.headSwatches(r));
      target.textContent = isFieldRule(r) ? (r.target === 'row' ? 'Row' : 'Cell') : (r.field ?? 'Row');
      label.textContent = r.name ?? (summary || 'New rule');
      label.classList.toggle('named', !!r.name);
      warn.classList.toggle('hidden', !problem);
      warn.title = problem ?? '';
      row.classList.toggle('invalid', !!problem);
      head.title = `${r.name ? `${r.name}\n` : ''}${
        isFieldRule(r) ? `The ${r.target === 'row' ? 'row' : `cell of ${r.field}`} by the value of ${r.field}` : `${r.field ? `The cell of ${r.field}` : 'The row'} when the document matches ${r.condition}`
      }${problem ? `\n${problem}` : ''}${absent ? `\nNo ${r.field} in this table.` : ''}\nDrag to reorder, or into another scope: the first rule that gives a color wins · click to ${open ? 'close' : 'edit'} · F2 to name`;
    };
    describe(rule, error);

    const toggle = () => {
      this.openId = open ? null : rule.id;
      this.pinning = null;
      if (open && this.draft?.id === rule.id) this.draft = null;
      this.render();
    };
    head.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button, input')) toggle();
    });
    head.addEventListener('keydown', (e) => {
      if (e.target !== head) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'F2') {
        e.preventDefault();
        this.openId = rule.id;
        this.render();
        this.list.querySelector<HTMLElement>('.fmt-rule.open .fmt-name')?.focus();
      }
    });
    this.reordering(head, rule, scope);
    row.append(head);
    if (open) row.append(this.editor(rule, error, describe));
    return row;
  }

  /** The colors a rule shows in its head: its color, the ends of its scale, or its first values. */
  private headSwatches(rule: FormatRule): HTMLElement[] {
    if (!isFieldRule(rule)) return [swatch({ color: rule.color })];
    const legend = fieldLegend(rule, this.opts.docs());
    if (legend.mode === 'scale') return [this.scaleBar(rule, 'fmt-scale-mini')];
    return legend.entries.slice(0, 3).map((e) => swatch(e.paint));
  }

  private scaleBar(rule: FieldRule, className: string): HTMLElement {
    const bar = make('span', className);
    const to = cssColorOf(rule.scale?.to ?? 'blue');
    const stops = rule.scale?.from
      ? [cssColorOf(rule.scale.from), cssColorOf('yellow'), to].map((c) => `color-mix(in srgb, ${c} 30%, transparent)`)
      : [6, 45].map((level) => `color-mix(in srgb, ${to} ${level}%, transparent)`);
    bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    return bar;
  }

  /** `Move To ▸` and `Copy To ▸` of a rule's menu: the other scopes. */
  private scopeItems(id: string, from: FormatScope): MenuItem[] {
    const labels: Record<FormatScope, string> = { collection: 'This Collection', database: 'This Database', connection: 'This Connection', global: 'Everywhere' };
    const others = FORMAT_SCOPES.filter((s) => s !== from);
    const items = (copy: boolean): MenuItem[] => others.map((scope) => ({ label: labels[scope], title: this.scopeTitle(scope), action: () => this.moveTo(id, scope, { copy }) }));
    return [
      { label: 'Move To', title: 'The rule leaves this scope for another', items: items(false) },
      { label: 'Copy To', title: 'A copy of the rule in another scope', items: items(true) },
    ];
  }

  private reordering(head: HTMLElement, rule: FormatRule, scope: FormatScope): void {
    head.addEventListener('dragstart', (e) => {
      this.dragId = rule.id;
      e.dataTransfer!.setData('text/plain', rule.id);
      e.dataTransfer!.effectAllowed = 'move';
      e.stopPropagation();
    });
    head.addEventListener('dragend', () => (this.dragId = null));
    head.addEventListener('dragover', (e) => {
      if (!this.dragId || this.dragId === rule.id || rule === this.draft) return;
      e.preventDefault();
      const after = e.offsetY > head.offsetHeight / 2;
      head.classList.toggle('drop-before', !after);
      head.classList.toggle('drop-after', after);
    });
    head.addEventListener('dragleave', () => head.classList.remove('drop-before', 'drop-after'));
    head.addEventListener('drop', (e) => {
      e.preventDefault();
      head.classList.remove('drop-before', 'drop-after');
      if (this.dragId) this.moveTo(this.dragId, scope, { beside: rule.id, after: e.offsetY > head.offsetHeight / 2 });
      this.dragId = null;
    });
  }

  // -------------------------------------------------------------------------
  // The rule open for editing

  private editor(rule: FormatRule, error: string | undefined, describe: (r: FormatRule, problem: string | undefined) => void): HTMLElement {
    const body = make('div', 'fmt-rule-body');
    /** The head follows what is typed in the body. */
    const refresh = () => {
      const now = this.find(rule.id);
      if (now) describe(now, isFieldRule(now) ? undefined : conditionError(now.condition));
    };

    const name = make('input', 'fmt-name');
    name.dataset.k = 'name';
    name.spellcheck = false;
    name.value = rule.name ?? '';
    name.placeholder = ruleSummary(rule) || 'Name';
    name.title = 'A name for the rule, shown in place of its condition or field';
    name.addEventListener('input', () =>
      this.typed(
        rule.id,
        ({ name: _, ...r }) => (name.value.trim() ? { ...r, name: name.value.trim() } : r),
        refresh,
      ),
    );
    body.append(labeled('Name', name));
    if (isFieldRule(rule)) this.fieldEditor(body, rule, refresh);
    else this.conditionEditor(body, rule, error, refresh);
    return body;
  }

  private fieldInput(value: string, placeholder: string): HTMLInputElement {
    const field = make('input', 'fmt-rule-field');
    field.dataset.k = 'field';
    field.spellcheck = false;
    field.setAttribute('list', this.fieldList.id);
    field.placeholder = placeholder;
    field.value = value;
    return field;
  }

  private colorChoices(current: FormatColor | undefined, colors: readonly FormatColor[], label: string, choose: (color: FormatColor) => void): HTMLElement {
    const group = make('div', 'format-colors');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    for (const color of colors) {
      const b = make('button', 'fmt-choice');
      b.type = 'button';
      b.dataset.k = `${label}-${color}`;
      b.title = colorLabel(color);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', colorLabel(color));
      b.setAttribute('aria-checked', String(color === current));
      b.append(swatch({ color }));
      b.addEventListener('click', () => choose(color));
      group.append(b);
    }
    return group;
  }

  private conditionEditor(body: HTMLElement, rule: ConditionRule, error: string | undefined, refresh: () => void): void {
    const field = this.fieldInput(rule.field ?? '', 'the whole row');
    field.title = "The field whose cell is colored; empty: the document's whole row";
    field.addEventListener('input', () => {
      const value = field.value.trim();
      const bad = value.startsWith('$');
      field.classList.toggle('invalid', bad);
      if (!bad) this.typed(rule.id, (r) => (isFieldRule(r) ? r : (({ field: _, ...rest }) => (value ? { ...rest, field: value } : rest))(r)), refresh);
    });
    body.append(labeled('Color the cell of', field));

    const condition = make('textarea', 'fmt-condition');
    condition.dataset.k = 'condition';
    condition.rows = 3;
    condition.spellcheck = false;
    condition.placeholder = '{ status: "failed" }  —  a filter, as in the query bar';
    condition.value = rule.condition;
    const problem = make('div', 'error');
    const show = (message: string | undefined) => {
      problem.textContent = message ?? '';
      problem.classList.toggle('hidden', !message);
      condition.classList.toggle('invalid', !!message);
    };
    show(rule.condition.trim() ? error : undefined);
    condition.addEventListener('input', () => {
      const message = conditionError(condition.value);
      // An empty box says nothing yet; a condition that can't be used is shown and not stored.
      show(condition.value.trim() ? message : undefined);
      if (!message) this.typed(rule.id, (r) => (isFieldRule(r) ? r : { ...r, condition: condition.value.trim() }), refresh);
    });
    body.append(labeled('When the document matches', condition), problem);
    this.opts.complete(condition);

    body.append(
      labeled(
        'Color',
        this.colorChoices(rule.color, FORMAT_COLORS, 'Color', (color) => this.replace(rule.id, (r) => (isFieldRule(r) ? r : { ...r, color }))),
      ),
    );
  }

  private fieldEditor(body: HTMLElement, rule: FieldRule, refresh: () => void): void {
    const change = (next: (r: FieldRule) => FieldRule) => this.replace(rule.id, (r) => (isFieldRule(r) ? next(r) : r));
    const legendBox = make('div', 'fmt-legend');
    const field = this.fieldInput(rule.field, 'field');
    field.title = 'The field whose values choose the color';
    field.addEventListener('input', () => {
      const value = field.value.trim();
      const bad = !value || value.startsWith('$');
      field.classList.toggle('invalid', bad);
      // The ends of a scale belong to the field they were read from.
      if (!bad) this.typed(rule.id, (r) => (isFieldRule(r) ? (({ min: _, max: __, ...rest }) => ({ ...rest, field: value }))(r) : r), refresh);
    });
    // The legend follows once the field is typed; a little later, so that a click that ends the typing still lands.
    field.addEventListener('change', () => setTimeout(() => this.pane.open && this.render(), 200));
    body.append(labeled('Field', field));
    body.append(
      labeled(
        'Color',
        select(
          [
            ['cell', 'The cell'],
            ['row', 'The whole row'],
          ],
          rule.target,
          'What the value colors',
          (target) => change((r) => ({ ...r, target })),
        ),
      ),
    );
    Object.assign(body.lastElementChild!.querySelector('select')!.dataset, { k: 'target' });

    const legend = fieldLegend(rule, this.opts.docs());
    const modes: [FieldRule['mode'], string][] = [
      ['auto', `Automatic (${{ boolean: 'true and false', scale: 'a scale', values: 'a color per value' }[rule.mode === 'auto' ? legend.mode : resolveField({ ...rule, mode: 'auto' }, this.opts.docs()).mode]})`],
      ['values', 'A color per value'],
      ['scale', 'A scale, for numbers and dates'],
      ['boolean', 'True and false'],
    ];
    const mode = select(modes, rule.mode, 'How the values are colored; Automatic decides from the values of the page', (m) => change((r) => this.withEnds({ ...r, mode: m })));
    mode.dataset.k = 'mode';
    body.append(labeled('As', mode));

    if (legend.mode === 'scale') this.scaleEditor(body, rule, legend, change);
    else if (legend.mode === 'boolean') this.booleanEditor(body, rule, legend, change);
    else this.valuesEditor(body, rule, legend, change);
    body.append(legendBox);
    if (rule.field && this.opts.docs().length && !legend.entries.some((e) => e.count) && legend.min === undefined) {
      legendBox.append(make('div', 'fmt-muted', `No ${rule.field} on this page.`));
    }
  }

  private booleanEditor(body: HTMLElement, rule: FieldRule, legend: Legend, change: (next: (r: FieldRule) => FieldRule) => void): void {
    const list = make('div', 'fmt-values');
    for (const entry of legend.entries) list.append(this.legendLine(entry));
    const swap = make('button', 'secondary', 'Swap Colors');
    swap.dataset.k = 'swap';
    swap.title = 'True and false exchange their colors';
    swap.addEventListener('click', () => change(({ scale: _, ...r }) => (rule.scale?.to === 'red' ? r : { ...r, scale: { from: 'green', to: 'red' } })));
    body.append(list, swap);
  }

  private scaleEditor(body: HTMLElement, rule: FieldRule, legend: Legend, change: (next: (r: FieldRule) => FieldRule) => void): void {
    const two = Object.entries(TWO_COLOR_SCALES).find(([, s]) => s.from === rule.scale?.from && s.to === rule.scale?.to)?.[0];
    const kind = select(
      [
        ['one', 'One color, stronger as the value grows'],
        ['red-green', 'Red to green'],
        ['green-red', 'Green to red'],
      ],
      two ?? 'one',
      'The colors of the scale',
      (k) => change((r) => ({ ...r, scale: TWO_COLOR_SCALES[k] ?? { to: 'blue' } })),
    );
    kind.dataset.k = 'scale';
    body.append(labeled('Scale', kind));
    if (!two) {
      body.append(
        labeled(
          'Color',
          this.colorChoices(rule.scale?.to ?? 'blue', FORMAT_COLORS, 'Scale color', (to) => change((r) => ({ ...r, scale: { to } }))),
        ),
      );
    }

    const show = (n: number | undefined) => (n === undefined ? '' : legend.dates ? new Date(n).toISOString() : String(n));
    const read = (text: string) => {
      const n = legend.dates ? new Date(text.trim()).getTime() : Number(text.trim());
      return text.trim() && Number.isFinite(n) ? n : undefined;
    };
    const end = (key: 'min' | 'max', title: string) => {
      const input = make('input', 'fmt-end');
      input.dataset.k = key;
      input.spellcheck = false;
      input.value = show(rule[key]);
      input.placeholder = show(legend[key]) || key;
      input.title = title;
      input.addEventListener('input', () => {
        const n = read(input.value);
        input.classList.toggle('invalid', !!input.value.trim() && n === undefined);
        if (n === undefined && input.value.trim()) return;
        this.typed(rule.id, (r) => {
          if (!isFieldRule(r)) return r;
          const { [key]: _, ...rest } = r;
          return n === undefined ? (rest as FieldRule) : { ...r, [key]: n };
        });
      });
      return input;
    };
    const ends = make('div', 'fmt-ends');
    const fromPage = make('button', 'secondary', 'From This Page');
    fromPage.dataset.k = 'fromPage';
    fromPage.title = "Take the smallest and the largest value of this page as the scale's ends";
    fromPage.addEventListener('click', () => change(({ min: _, max: __, ...r }) => this.withEnds(r)));
    ends.append(
      end('min', 'The value that gets the first color; smaller values get it too. Empty: the smallest of each page'),
      this.scaleBar(rule, 'fmt-scale-bar'),
      end('max', 'The value that gets the last color; larger values get it too. Empty: the largest of each page'),
    );
    body.append(ends, fromPage);
  }

  private valuesEditor(body: HTMLElement, rule: FieldRule, legend: Legend, change: (next: (r: FieldRule) => FieldRule) => void): void {
    const palettes: ['all' | FormatColor, string][] = [['all', 'All Colors'], ['gray', 'Shades of Gray'], ...VALUE_COLORS.map((c): [FormatColor, string] => [c, `Shades of ${colorLabel(c)}`])];
    const palette = select(palettes, rule.palette ?? 'all', 'Where the values that are not pinned take their colors', (p) =>
      change(({ palette: _, ...r }) => (p === 'all' ? r : { ...r, palette: p })),
    );
    palette.dataset.k = 'palette';
    body.append(labeled('Palette', palette));

    const loose = legend.entries.filter((e) => !e.pinned && e.count).length;
    if (loose > legend.colors) body.append(make('div', 'fmt-muted fmt-warn', `${rule.field} has ${loose} values on this page: the colors repeat.`));

    const pin = (text: string, color: FormatColor | undefined) => {
      this.pinning = null;
      change(({ pinned, ...r }) => {
        const rest = (pinned ?? []).filter((p) => p.value !== text);
        const next = color ? [...rest, { value: text, color }].slice(0, MAX_PINNED) : rest;
        return next.length ? { ...r, pinned: next } : r;
      });
    };
    const list = make('div', 'fmt-values');
    for (const entry of legend.entries) {
      list.append(
        this.legendLine(entry, () => {
          this.pinning = this.pinning === entry.text ? null : entry.text;
          this.render();
        }),
      );
      if (this.pinning !== entry.text) continue;
      const strip = make('div', 'fmt-pin-strip');
      strip.append(this.colorChoices(entry.pinned ? entry.paint.color : undefined, FORMAT_COLORS, `Color of ${entry.text}`, (color) => pin(entry.text, color)));
      if (entry.pinned) {
        const unpin = make('button', 'link', 'Unpin');
        unpin.dataset.k = 'unpin';
        unpin.title = 'The value takes a color of the palette again';
        unpin.addEventListener('click', () => pin(entry.text, undefined));
        strip.append(unpin);
      }
      list.append(strip);
    }
    body.append(list);

    const add = make('input', 'fmt-pin-input');
    add.dataset.k = 'pin';
    add.spellcheck = false;
    add.placeholder = '+ Pin a Value…   "home", 42, true';
    add.title = 'A value in mongosh syntax to give a color of its own (Enter); the page need not show it';
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !add.value.trim()) return;
      e.preventDefault();
      let text: string;
      try {
        text = valueText(parseQuery(add.value));
      } catch {
        // What is not mongosh syntax is the text itself.
        text = valueText(add.value.trim());
      }
      const taken = new Set((rule.pinned ?? []).map((p) => p.color));
      this.pinning = text;
      const color = VALUE_COLORS.find((c) => !taken.has(c)) ?? 'red';
      change(({ pinned, ...r }) => ({ ...r, pinned: [...(pinned ?? []).filter((p) => p.value !== text), { value: text, color }].slice(0, MAX_PINNED) }));
    });
    body.append(add);
  }

  /** A value of the legend: its color (a button that pins another one when `choose` is given), its text, how many. */
  private legendLine(entry: LegendEntry, choose?: () => void): HTMLElement {
    const line = make('div', 'fmt-value');
    line.classList.toggle('pinned', entry.pinned);
    const color = choose ? make('button', 'fmt-choice') : make('span', 'fmt-choice');
    color.append(swatch(entry.paint));
    if (choose) {
      color.dataset.k = `value-${entry.text}`;
      color.title = entry.pinned ? 'Pinned to this color: choose another, or unpin' : 'Pin this value to a color';
      color.setAttribute('aria-label', `${color.title}: ${entry.text}`);
      color.addEventListener('click', choose);
    }
    const text = make('span', 'fmt-value-text', entry.text);
    text.title = entry.text;
    line.append(color, text);
    if (entry.pinned) line.append(Object.assign(make('span', 'fmt-pin-mark', '📌'), { title: 'Pinned' }));
    line.append(make('span', 'fmt-value-count', entry.count ? String(entry.count) : '–'));
    return line;
  }
}
