// Syntax colors for the query inputs. The input keeps its text, caret and selection with the text
// made transparent, and a copy of the text in colors is laid over it, with the same font, padding
// and scroll; the input stays a plain textarea for typing, completions and drops.
import { tokenize } from '../shared/syntax';

type TextField = HTMLTextAreaElement | HTMLInputElement;

/** What sets where the text of the input falls: the overlay copies it. */
const METRICS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'tabSize',
  'textIndent',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
] as const;

export function highlight(field: TextField): void {
  if (field.classList.contains('hl-field')) return;
  const single = field instanceof HTMLInputElement;
  const box = document.createElement('div');
  box.className = single ? 'hl single' : 'hl';
  box.setAttribute('aria-hidden', 'true');
  field.classList.add('hl-field');

  const render = () => {
    const text = field.value;
    const parts: (string | HTMLSpanElement)[] = [];
    let at = 0;
    for (const t of tokenize(text)) {
      if (t.from > at) parts.push(text.slice(at, t.from));
      const span = document.createElement('span');
      span.className = `t-${t.role}`;
      span.textContent = text.slice(t.from, t.to);
      parts.push(span);
      at = t.to;
    }
    // The space keeps a last empty line as tall as in the textarea.
    parts.push(text.slice(at) + ' ');
    box.replaceChildren(...parts);
  };

  const scroll = () => {
    box.scrollTop = field.scrollTop;
    box.scrollLeft = field.scrollLeft;
  };

  const layout = () => {
    const parent = field.parentElement;
    if (!parent || !field.getClientRects().length) {
      box.style.display = 'none';
      return;
    }
    if (box.parentElement !== parent) {
      if (getComputedStyle(parent).position === 'static') parent.classList.add('hl-host');
      field.after(box);
    }
    box.style.display = '';
    const s = getComputedStyle(field);
    for (const m of METRICS) box.style[m] = s[m];
    const f = field.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    box.style.left = `${f.left - p.left - parent.clientLeft + parent.scrollLeft + field.clientLeft}px`;
    box.style.top = `${f.top - p.top - parent.clientTop + parent.scrollTop + field.clientTop}px`;
    box.style.width = `${field.clientWidth}px`;
    box.style.height = `${field.clientHeight}px`;
    // An input centers its line in its height.
    if (single) box.style.lineHeight = `${field.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)}px`;
    scroll();
  };

  // The value set by the code (history, builder, drops) doesn't fire `input`.
  const proto = Object.getPrototypeOf(field) as object;
  const value = Object.getOwnPropertyDescriptor(proto, 'value')!;
  Object.defineProperty(field, 'value', {
    configurable: true,
    get(this: TextField) {
      return value.get!.call(this) as string;
    },
    set(this: TextField, v: string) {
      value.set!.call(this, v);
      render();
      requestAnimationFrame(layout);
    },
  });

  field.addEventListener('input', () => {
    render();
    scroll();
  });
  field.addEventListener('scroll', scroll);
  // An input scrolls sideways with the caret without always firing `scroll`.
  for (const type of ['keydown', 'keyup', 'mouseup', 'select', 'focus']) field.addEventListener(type, () => requestAnimationFrame(scroll));
  const observer = new ResizeObserver(layout);
  observer.observe(field);
  // The field is built before it is placed, as the stages are.
  requestAnimationFrame(() => {
    if (field.parentElement) observer.observe(field.parentElement);
    layout();
  });
  render();
}
