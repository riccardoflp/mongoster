// The quick pick and the input box, at the top of the window as in VS Code.
import type { InputBoxRequest, QuickPickEntry, QuickPickRequest, Severity } from '../protocol';
import { h, host, label, plain } from './dom';

const overlay = document.getElementById('quick-input')!;
const box = h('div', { class: 'quick-box', role: 'dialog', 'aria-modal': 'true' });
overlay.append(box);

/** Closes what is open, answering it as cancelled. */
let dismiss: (() => void) | undefined;
let openId: number | undefined;
let outside: ((e: MouseEvent) => void) | undefined;

function show(id: number, ignoreFocusOut: boolean | undefined, cancel: () => void): void {
  dismiss?.();
  openId = id;
  overlay.hidden = false;
  outside = (e) => {
    if (!ignoreFocusOut && !box.contains(e.target as Node)) cancel();
  };
  overlay.addEventListener('mousedown', outside);
  dismiss = cancel;
}

function hide(): void {
  if (outside) overlay.removeEventListener('mousedown', outside);
  outside = undefined;
  dismiss = undefined;
  openId = undefined;
  overlay.hidden = true;
  box.onkeydown = null;
  box.replaceChildren();
}

/** The host closed the input (an input box accepted after its last validation). */
export function hideQuickInput(id: number): void {
  if (openId === id) hide();
}

export function quickInputOpen(): boolean {
  return openId !== undefined;
}

// ---- quick pick

export function showQuickPick(request: QuickPickRequest): void {
  const many = !!request.canPickMany;
  const checked = new Set<number>(request.items.flatMap((item, i) => (many && item.picked ? [i] : [])));
  let shown: number[] = [];
  let focused = 0;
  let done = false;

  const finish = (picked: number[] | undefined) => {
    if (done) return;
    done = true;
    hide();
    host.send({ type: 'quickPickResult', id: request.id, picked });
  };
  show(request.id, request.ignoreFocusOut, () => finish(undefined));

  const input = h('input', { class: 'quick-text', type: 'text', spellcheck: 'false', placeholder: request.placeHolder ?? '', 'aria-label': request.title ?? request.placeHolder ?? 'Pick' });
  const all = h('input', { type: 'checkbox', class: 'quick-all', title: 'Toggle all', 'aria-label': 'Toggle all' });
  const ok = h('button', { class: 'button', type: 'button' }, 'OK');
  const list = h('div', { class: 'quick-list', role: 'listbox' });
  box.replaceChildren();
  if (request.title) box.append(h('div', { class: 'quick-title' }, request.title));
  box.append(h('div', { class: 'quick-row' }, many ? all : undefined, input, many ? ok : undefined), list);

  const matches = (item: QuickPickEntry, words: string[]) => {
    const text = [plain(item.label), request.matchOnDescription ? item.description : '', request.matchOnDetail ? item.detail : ''].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  };

  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = request.items.flatMap((item, i) => (!item.separator && matches(item, words) ? [i] : []));
    focused = Math.min(focused, Math.max(shown.length - 1, 0));
    list.replaceChildren(
      ...shown.map((index, position) => {
        const item = request.items[index];
        const row = h('div', { class: `quick-item${position === focused ? ' focused' : ''}`, role: 'option', 'aria-selected': position === focused });
        if (many) {
          const check = h('input', { type: 'checkbox', tabindex: -1 });
          check.checked = checked.has(index);
          row.append(check);
        }
        const text = h('div', { class: 'quick-item-text' }, h('div', { class: 'quick-item-line' }, h('span', { class: 'quick-label' }, label(item.label)), item.description ? h('span', { class: 'quick-description' }, item.description) : undefined));
        if (item.detail) text.append(h('div', { class: 'quick-detail' }, item.detail));
        row.append(text);
        row.addEventListener('mousemove', () => {
          if (focused === position) return;
          focused = position;
          list.querySelector('.focused')?.classList.remove('focused');
          row.classList.add('focused');
        });
        row.addEventListener('click', () => {
          if (!many) return finish([index]);
          toggle(index);
        });
        return row;
      }),
    );
    if (!shown.length) list.append(h('div', { class: 'quick-empty' }, 'No matching results'));
    if (many) {
      all.checked = shown.length > 0 && shown.every((i) => checked.has(i));
      ok.textContent = `OK${checked.size ? ` (${checked.size})` : ''}`;
    }
    list.querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
  };

  const toggle = (index: number) => {
    if (checked.has(index)) checked.delete(index);
    else checked.add(index);
    draw();
    input.focus();
  };

  input.addEventListener('input', () => {
    focused = 0;
    draw();
  });
  all.addEventListener('change', () => {
    for (const i of shown) all.checked ? checked.add(i) : checked.delete(i);
    draw();
    input.focus();
  });
  ok.addEventListener('click', () => finish([...checked].sort((a, b) => a - b)));
  box.onkeydown = (e) => {
    const step = (by: number) => {
      focused = Math.min(Math.max(focused + by, 0), Math.max(shown.length - 1, 0));
      draw();
    };
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'PageDown') step(10);
    else if (e.key === 'PageUp') step(-10);
    else if (e.key === 'Escape') finish(undefined);
    else if (e.key === 'Enter') {
      if (many) finish([...checked].sort((a, b) => a - b));
      else if (shown.length) finish([shown[focused]]);
    } else if (e.key === ' ' && many && e.target !== input) {
      if (shown.length) toggle(shown[focused]);
    } else return;
    e.preventDefault();
  };

  draw();
  input.focus();
}

// ---- input box

export interface InputBoxHandle {
  validation(seq: number, message: string | undefined, severity: Severity | undefined): void;
}

let currentInput: (InputBoxHandle & { id: number }) | undefined;

export function inputValidation(id: number, seq: number, message: string | undefined, severity: Severity | undefined): void {
  if (currentInput?.id === id) currentInput.validation(seq, message, severity);
}

export function showInputBox(request: InputBoxRequest): void {
  let done = false;
  let seq = 0;
  let waiting = false;

  const cancel = () => {
    if (done) return;
    done = true;
    hide();
    currentInput = undefined;
    host.send({ type: 'inputBoxResult', id: request.id });
  };
  show(request.id, request.ignoreFocusOut, cancel);

  const input = h('input', {
    class: 'quick-text',
    type: request.password ? 'password' : 'text',
    spellcheck: 'false',
    placeholder: request.placeHolder ?? '',
    'aria-label': request.prompt ?? request.title ?? 'Input',
  });
  input.value = request.value ?? '';
  const hint = "Press 'Enter' to confirm or 'Escape' to cancel";
  const message = h('div', { class: 'quick-message' }, request.prompt ? `${request.prompt} (${hint})` : hint);
  box.replaceChildren();
  if (request.title) box.append(h('div', { class: 'quick-title' }, request.title));
  box.append(h('div', { class: 'quick-row' }, input), message);

  const validate = () => host.send({ type: 'inputValidate', id: request.id, seq: ++seq, value: input.value });

  currentInput = {
    id: request.id,
    validation: (answered, text, severity) => {
      // -1 answers an Enter that the host refused; the others answer what was typed, if still current.
      if (answered === -1) waiting = false;
      else if (answered !== seq) return;
      message.textContent = text ?? (request.prompt ? `${request.prompt} (${hint})` : hint);
      message.className = `quick-message${text ? ` ${severity ?? 'error'}` : ''}`;
      input.classList.toggle('invalid', !!text && (severity ?? 'error') === 'error');
    },
  };

  input.addEventListener('input', validate);
  box.onkeydown = (e) => {
    if (e.key === 'Escape') cancel();
    else if (e.key === 'Enter') {
      // The host validates the value again and closes the box when it accepts it.
      if (waiting) return;
      waiting = true;
      host.send({ type: 'inputBoxResult', id: request.id, value: input.value });
    } else return;
    e.preventDefault();
  };

  input.focus();
  if (request.valueSelection) input.setSelectionRange(request.valueSelection[0], request.valueSelection[1]);
  else input.select();
  // The starting value is validated too, as VS Code does.
  if (input.value) validate();
}
