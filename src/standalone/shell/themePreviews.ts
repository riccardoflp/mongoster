// The color themes as small previews under the shortcuts of the empty tab area: clicking one chooses it. They show
// only when the area is tall enough for them under the shortcuts; the theme is the `app.theme` setting, as in
// `View › Theme` and the Settings tab.
import type { ThemePreview } from '../protocol';
import { h, host } from './dom';

const watermark = document.getElementById('watermark')!;
const section = document.getElementById('theme-previews')!;
const grid = section.querySelector<HTMLElement>('.theme-grid')!;
const SYSTEM = 'system';

/** A window in the theme's colors: the side bar with a button, the tabs, and a few lines of code. */
function shot(t: ThemePreview): HTMLElement {
  const line = (...parts: [number, number][]) =>
    h('span', { class: 'shot-line' }, ...parts.map(([color, width]) => bar(t.syntax[color], width)));
  const bar = (color: string, width: number) => {
    const el = h('span', { class: 'shot-bar' });
    el.style.background = color;
    el.style.width = `${width}%`;
    return el;
  };
  const side = h('span', { class: 'shot-side' }, bar(t.accent, 100), bar(t.foreground, 70), bar(t.foreground, 55));
  const editor = h(
    'span',
    { class: 'shot-editor' },
    h('span', { class: 'shot-tabs' }),
    line([0, 22], [1, 30]),
    line([1, 26], [2, 44]),
    line([1, 20], [3, 18]),
    line([4, 60]),
  );
  side.style.background = t.sideBar;
  side.querySelectorAll<HTMLElement>('.shot-bar').forEach((b, i) => i > 0 && (b.style.opacity = '0.35'));
  editor.style.background = t.editor;
  (editor.firstChild as HTMLElement).style.background = t.tabs;
  const el = h('span', { class: 'shot' }, side, editor);
  el.style.background = t.window;
  return el;
}

function tile(id: string, label: string, ...shots: HTMLElement[]): HTMLElement {
  const el = h('button', { class: 'theme-tile', type: 'button', role: 'radio', 'data-theme': id, title: label }, h('span', { class: 'shots' }, ...shots), h('span', { class: 'theme-name' }, label));
  el.addEventListener('click', () => {
    chosenTheme(id);
    host.send({ type: 'settingChange', key: 'app.theme', value: id });
  });
  return el;
}

/** The previews fit under the shortcuts, or are hidden: they never push the logo and the shortcuts out of sight. */
function fit(): void {
  if (!grid.childElementCount) return;
  section.hidden = false;
  const gap = parseFloat(getComputedStyle(watermark).rowGap) || 0;
  const shown = [...watermark.children].filter((c) => (c as HTMLElement).offsetParent !== null) as HTMLElement[];
  const needed = shown.reduce((sum, c) => sum + c.offsetHeight, 0) + gap * (shown.length - 1);
  section.hidden = needed > watermark.clientHeight - 2 * gap;
}

export function showThemePreviews(themes: ThemePreview[], chosen: string): void {
  const dark = themes.find((t) => t.kind === 'dark');
  const light = themes.find((t) => t.kind === 'light');
  // Following the system shows the default dark and light themes, cut across.
  const system = dark && light ? [tile(SYSTEM, 'Follow the System', shot(dark), shot(light))] : [];
  grid.replaceChildren(...system, ...themes.map((t) => tile(t.id, t.label, shot(t))));
  chosenTheme(chosen);
  new ResizeObserver(fit).observe(watermark);
  fit();
}

/** The theme chosen now, wherever it was chosen: its preview is marked. */
export function chosenTheme(value: unknown): void {
  if (typeof value !== 'string') return;
  for (const el of grid.querySelectorAll<HTMLElement>('.theme-tile')) el.setAttribute('aria-checked', String(el.dataset.theme === value));
}
