// The Choose a Color tab: the system's color picker, a field for `#rrggbb` or a preset name, the presets as
// swatches, and a preview of the stripe and of the preset shown where only presets are taken (D17).
import { type Color, PRESET_COLORS, PRESET_DEFAULTS, colorLabel, cssColorOf, isPreset, nearestPreset, readColor } from '../shared/colors';
import type { ColorPickerHostMessage, ColorPickerViewMessage } from '../shared/messages';
import { paintStripe } from './stripe';

declare function acquireVsCodeApi(): { postMessage(m: ColorPickerViewMessage): void };

const vscode = acquireVsCodeApi();
const post = (m: ColorPickerViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const native = el<HTMLInputElement>('native');
const field = el<HTMLInputElement>('value');
const apply = el<HTMLButtonElement>('apply');
let color: Color | undefined;

/** The hex the system's picker shows for a color: a preset's dark default. */
const hexOf = (c: Color) => (isPreset(c) ? PRESET_DEFAULTS[c].dark : c);

function show(next: Color | undefined, from?: 'native' | 'field'): void {
  color = next;
  apply.disabled = !next;
  el('error').classList.toggle('hidden', !!next || !field.value.trim());
  if (!next) return;
  if (from !== 'native') native.value = hexOf(next);
  if (from !== 'field') field.value = isPreset(next) ? colorLabel(next) : next;
  paintStripe(document.body, next);
  for (const swatch of el('swatches').children) swatch.classList.toggle('selected', (swatch as HTMLElement).dataset.preset === next);
  const preset = nearestPreset(next);
  const nearest = el('nearest');
  nearest.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.setProperty('background', cssColorOf(preset));
  nearest.append(
    isPreset(next) ? 'A preset: the tree, the tab icons and the names of editor tabs take it too, and it follows the theme.' : 'Shown as ',
    ...(isPreset(next) ? [] : [dot, colorLabel(preset), ' in the tree, on tab icons and on the names of editor tabs, which take only the presets.']),
  );
}

for (const preset of PRESET_COLORS) {
  const swatch = document.createElement('button');
  swatch.className = 'swatch';
  swatch.dataset.preset = preset;
  swatch.title = colorLabel(preset);
  swatch.setAttribute('aria-label', colorLabel(preset));
  swatch.style.setProperty('background', cssColorOf(preset));
  swatch.addEventListener('click', () => show(preset));
  el('swatches').append(swatch);
}

native.addEventListener('input', () => show(readColor(native.value), 'native'));
field.addEventListener('input', () => show(readColor(field.value), 'field'));
field.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && color) post({ type: 'apply', color });
});
apply.addEventListener('click', () => color && post({ type: 'apply', color }));
el('cancel').addEventListener('click', () => post({ type: 'cancel' }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') post({ type: 'cancel' });
});

window.addEventListener('message', (e: MessageEvent<ColorPickerHostMessage>) => {
  if (e.data.type !== 'init') return;
  show(readColor(e.data.color) ?? 'blue');
  field.focus();
});
post({ type: 'ready' });
