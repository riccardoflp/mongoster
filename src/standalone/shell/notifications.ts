// Messages and progress: notifications stacked at the bottom right, and modal dialogs for the
// questions that must be answered before going on.
import type { Severity } from '../protocol';
import { h, host, icon, iconButton } from './dom';

const stack = document.getElementById('notifications')!;
const modal = document.getElementById('modal')!;

const ICONS: Record<Severity, string> = { info: 'info', warning: 'warning', error: 'error' };
/** How long a message without buttons stays, by severity; errors stay until closed. */
const LIFETIME: Record<Severity, number> = { info: 8_000, warning: 12_000, error: 0 };

const toasts = new Map<number, { el: HTMLElement; close(): void }>();

export interface MessageRequest {
  id: number;
  severity: Severity;
  message: string;
  detail?: string;
  modal: boolean;
  actions: string[];
}

export function showMessage(request: MessageRequest): void {
  if (request.modal) showModal(request);
  else showToast(request);
}

function showToast(request: MessageRequest): void {
  let done = false;
  let timer: number | undefined;
  const answer = (action?: string) => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    el.remove();
    toasts.delete(request.id);
    host.send({ type: 'notifyResult', id: request.id, action });
  };
  const el = h(
    'div',
    { class: `toast ${request.severity}`, role: request.severity === 'error' ? 'alert' : 'status' },
    icon(ICONS[request.severity], 'toast-icon'),
    h('div', { class: 'toast-message' }, request.message),
    iconButton('close', 'Close', () => answer()),
  );
  if (request.actions.length) {
    const buttons = h('div', { class: 'toast-actions' });
    request.actions.forEach((action, i) => {
      const button = h('button', { class: `button${i === 0 ? '' : ' secondary'}`, type: 'button' }, action);
      button.addEventListener('click', () => answer(action));
      buttons.append(button);
    });
    el.append(buttons);
  }
  const lifetime = request.actions.length ? 0 : LIFETIME[request.severity];
  const start = () => {
    if (lifetime) timer = window.setTimeout(() => answer(), lifetime);
  };
  // Reading it keeps it there.
  el.addEventListener('mouseenter', () => window.clearTimeout(timer));
  el.addEventListener('mouseleave', start);
  start();
  toasts.set(request.id, { el, close: () => answer() });
  stack.append(el);
}

export function closeMessage(id: number): void {
  toasts.get(id)?.close();
}

// ---- modal questions, one at a time

const waiting: MessageRequest[] = [];
let asking = false;

function showModal(request: MessageRequest): void {
  waiting.push(request);
  if (!asking) nextModal();
}

function nextModal(): void {
  const request = waiting.shift();
  if (!request) {
    asking = false;
    modal.hidden = true;
    modal.replaceChildren();
    return;
  }
  asking = true;
  const previous = document.activeElement as HTMLElement | null;
  const answer = (action?: string) => {
    modal.onkeydown = null;
    host.send({ type: 'notifyResult', id: request.id, action });
    nextModal();
    if (!asking) previous?.focus?.();
  };
  const buttons = h('div', { class: 'modal-buttons' });
  request.actions.forEach((action, i) => {
    const button = h('button', { class: `button${i === 0 ? '' : ' secondary'}`, type: 'button' }, action);
    button.addEventListener('click', () => answer(action));
    buttons.append(button);
  });
  const cancel = h('button', { class: 'button secondary', type: 'button' }, request.actions.length ? 'Cancel' : 'OK');
  cancel.addEventListener('click', () => answer());
  buttons.append(cancel);
  const dialog = h(
    'div',
    { class: 'modal-box', role: 'alertdialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-body' }, icon(ICONS[request.severity], `modal-icon ${request.severity}`), h('div', {}, h('div', { class: 'modal-message' }, request.message), request.detail ? h('div', { class: 'modal-detail' }, request.detail) : undefined)),
    buttons,
  );
  modal.replaceChildren(dialog);
  modal.hidden = false;
  modal.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      answer();
    } else if (e.key === 'Tab') {
      // The focus stays among the dialog's buttons.
      const all = [...buttons.querySelectorAll('button')];
      const index = all.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      all[(index + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
    }
  };
  // As in VS Code, Enter takes the first answer.
  (buttons.querySelector('button') ?? cancel).focus();
}

export function modalOpen(): boolean {
  return asking;
}

// ---- progress

const running = new Map<number, { el: HTMLElement; title: HTMLElement; bar: HTMLElement }>();

export function showProgress(id: number, title: string, message: string | undefined, percent: number | undefined, cancellable: boolean): void {
  let entry = running.get(id);
  if (!entry) {
    const titleEl = h('div', { class: 'toast-message' });
    const bar = h('div', { class: 'progress-bar' }, h('div', { class: 'progress-fill' }));
    const el = h('div', { class: 'toast progress', role: 'status' }, icon('loading', 'toast-icon spin'), titleEl);
    if (cancellable) {
      const cancel = h('button', { class: 'button secondary', type: 'button' }, 'Cancel');
      cancel.addEventListener('click', () => {
        cancel.disabled = true;
        host.send({ type: 'progressCancel', id });
      });
      el.append(h('div', { class: 'toast-actions' }, cancel));
    }
    el.append(bar);
    stack.append(el);
    entry = { el, title: titleEl, bar };
    running.set(id, entry);
  }
  entry.title.textContent = message ? `${title}: ${message}` : title;
  const fill = entry.bar.firstElementChild as HTMLElement;
  entry.bar.classList.toggle('indeterminate', percent === undefined);
  fill.style.width = percent === undefined ? '' : `${Math.round(percent)}%`;
}

export function endProgress(id: number): void {
  running.get(id)?.el.remove();
  running.delete(id);
}
