// Suggestion popup for the query inputs: field names, operators and frequent values while typing.
// Tab or Enter inserts, arrows move, Escape closes, Ctrl+Space opens it on demand.
import { CompletionItem, CompletionKind, CompletionResult, FieldHint, complete } from '../shared/complete';

type TextField = HTMLTextAreaElement | HTMLInputElement;

export interface CompletionSource {
  kind(): CompletionKind;
  fields(): FieldHint[];
}

const MAX_ITEMS = 50;
const ICONS: Record<CompletionItem['kind'], string> = { field: '◆', operator: '$', stage: '▸', value: '=' };

export class Completer {
  private readonly box = document.createElement('div');
  private target: TextField | null = null;
  private source: CompletionSource | null = null;
  private result: CompletionResult | null = null;
  private selected = 0;
  private inserting = false;
  private readonly sources = new WeakMap<TextField, CompletionSource>();

  constructor() {
    this.box.className = 'completions hidden';
    this.box.setAttribute('role', 'listbox');
    // Keep the focus in the input while clicking a suggestion.
    this.box.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(this.box);
    window.addEventListener('resize', () => this.close());
    document.addEventListener(
      'scroll',
      (e) => {
        if (this.box.contains(e.target as Node)) return;
        // The input itself scrolls as it grows or wraps: follow the caret.
        const target = this.target;
        if (target && e.target === target && this.result) this.position(target, this.result.from);
        else this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.result !== null;
  }

  attach(field: TextField, source: CompletionSource): void {
    field.setAttribute('autocomplete', 'off');
    this.sources.set(field, source);
    field.addEventListener('input', (e) => {
      if (this.inserting) return;
      const data = (e as InputEvent).data ?? '';
      if (this.target === field && this.isOpen) this.update(field, source, false);
      else if ((e as InputEvent).inputType === 'insertText' && /[\w$"':{.]$/.test(data)) this.update(field, source, false);
    });
    field.addEventListener('keydown', (e) => this.keydown(e as KeyboardEvent, field, source), true);
    field.addEventListener('blur', () => this.close());
    field.addEventListener('click', () => this.close());
  }

  /** New field names arrived: updates the suggestions of the focused input, if it was typing a word. */
  refresh(): void {
    const field = document.activeElement as TextField | null;
    const source = field && this.sources.get(field);
    if (source) this.update(field, source, false);
  }

  close(): void {
    if (!this.result) return;
    this.result = null;
    this.target = null;
    this.box.classList.add('hidden');
    this.box.replaceChildren();
  }

  private keydown(e: KeyboardEvent, field: TextField, source: CompletionSource): void {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.update(field, source, true);
      return;
    }
    if (!this.result || this.target !== field) return;
    const count = this.result.items.length;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    let handled = true;
    if (e.key === 'ArrowDown') this.select((this.selected + 1) % count);
    else if (e.key === 'ArrowUp') this.select((this.selected - 1 + count) % count);
    else if (e.key === 'PageDown') this.select(Math.min(this.selected + 8, count - 1));
    else if (e.key === 'PageUp') this.select(Math.max(this.selected - 8, 0));
    else if ((e.key === 'Enter' || e.key === 'Tab') && plain) this.accept(this.selected);
    else if (e.key === 'Escape') this.close();
    else {
      handled = false;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || (e.key === 'Enter' && !plain)) this.close();
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  /** Recomputes the suggestions at the caret; `force` shows them even with nothing typed. */
  private update(field: TextField, source: CompletionSource, force: boolean): void {
    const caret = field.selectionStart ?? field.value.length;
    if (field.selectionEnd !== caret) return this.close();
    const result = complete(field.value, caret, source.kind(), source.fields());
    if (!result || !result.items.length) return this.close();
    // Unasked, a list of everything only makes sense right after {, [, : or , (where a key or value starts).
    if (!force && !this.isOpen && !result.prefix && !/[{:[,]\s*$/.test(field.value.slice(0, caret))) return this.close();
    result.items = result.items.slice(0, MAX_ITEMS);
    const keep = this.result && this.target === field ? this.result.items[this.selected]?.label : undefined;
    this.result = result;
    this.target = field;
    this.source = source;
    this.render();
    const again = keep === undefined ? -1 : result.items.findIndex((i) => i.label === keep);
    this.select(again >= 0 ? again : 0);
    this.position(field, result.from);
  }

  private accept(index: number): void {
    const field = this.target;
    const result = this.result;
    const source = this.source;
    if (!field || !result || !source) return;
    const item = result.items[index];
    field.focus();
    field.setSelectionRange(result.from, result.to);
    // execCommand keeps the edit in the input's undo history; setRangeText is the fallback.
    this.inserting = true;
    try {
      if (!document.execCommand('insertText', false, item.insert)) {
        field.setRangeText(item.insert, result.from, result.to, 'end');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } finally {
      this.inserting = false;
    }
    const caret = result.from + (item.cursor ?? item.insert.length);
    field.setSelectionRange(caret, caret);
    this.close();
    // What comes next (values after a key, fields inside a new object) is offered right away.
    this.update(field, source, false);
  }

  private render(): void {
    const result = this.result!;
    this.box.replaceChildren(
      ...result.items.map((item, i) => {
        const row = document.createElement('div');
        row.className = `completion kind-${item.kind}`;
        row.setAttribute('role', 'option');
        const icon = document.createElement('span');
        icon.className = 'completion-icon';
        icon.textContent = ICONS[item.kind];
        const label = document.createElement('span');
        label.className = 'completion-label';
        label.append(...highlight(item.label, result.prefix));
        row.append(icon, label);
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'completion-detail';
          detail.textContent = item.detail;
          row.append(detail);
        }
        row.addEventListener('mousemove', () => this.select(i, false));
        row.addEventListener('click', () => this.accept(i));
        return row;
      }),
    );
    this.box.classList.remove('hidden');
  }

  private select(index: number, scroll = true): void {
    const rows = this.box.children;
    rows[this.selected]?.classList.remove('selected');
    this.selected = index;
    const row = rows[index] as HTMLElement | undefined;
    row?.classList.add('selected');
    row?.setAttribute('aria-selected', 'true');
    if (scroll) row?.scrollIntoView({ block: 'nearest' });
  }

  private position(field: TextField, offset: number): void {
    const caret = caretPosition(field, offset);
    const box = this.box;
    box.style.left = '0px';
    box.style.top = '0px';
    const { width, height } = box.getBoundingClientRect();
    const left = Math.max(4, Math.min(caret.left, window.innerWidth - width - 4));
    const below = caret.top + caret.height + 2;
    const top = below + height > window.innerHeight - 4 && caret.top - height - 2 > 0 ? caret.top - height - 2 : below;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }
}

/** Label with the typed prefix in bold where it matches. */
function highlight(label: string, prefix: string): Node[] {
  const bare = prefix.replace(/^\$+/, '').toLowerCase();
  if (!bare) return [document.createTextNode(label)];
  const at = label.toLowerCase().indexOf(bare);
  if (at < 0) return [document.createTextNode(label)];
  const strong = document.createElement('strong');
  strong.textContent = label.slice(at, at + bare.length);
  return [document.createTextNode(label.slice(0, at)), strong, document.createTextNode(label.slice(at + bare.length))];
}

const MIRRORED = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
  'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing',
  'wordSpacing', 'tabSize',
] as const;

/** Viewport position of character `offset` of the field, measured on an invisible copy of it. */
function caretPosition(field: TextField, offset: number): { left: number; top: number; height: number } {
  const style = getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const p of MIRRORED) mirror.style[p] = style[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.overflow = 'hidden';
  const multiline = field instanceof HTMLTextAreaElement;
  mirror.style.whiteSpace = multiline ? 'pre-wrap' : 'pre';
  if (multiline) mirror.style.overflowWrap = 'break-word';
  mirror.textContent = field.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  document.body.append(mirror);
  const rect = field.getBoundingClientRect();
  const left = rect.left + marker.offsetLeft - field.scrollLeft;
  const top = rect.top + marker.offsetTop - field.scrollTop;
  const height = marker.offsetHeight || parseFloat(style.lineHeight) || 16;
  mirror.remove();
  return { left: Math.min(left, rect.right), top, height };
}
