// The Settings tab: a form made from the settings the extension declares in package.json.
import type { SettingField } from '../protocol';
import { h, host, markdown } from './dom';
import { Tab, activate, find, open } from './workbench';

const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
let tab: Tab | undefined;

/** `mongoster.history.maxSizeMB` → `History: Max Size MB`. */
function title(key: string): { group: string; name: string } {
  const parts = key.split('.');
  const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  const name = words(parts.pop()!);
  const group = parts.filter((p) => p !== 'mongoster').map(words).join(' › ');
  return { group, name };
}

function setControl(control: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = !!value;
  else control.value = value === undefined || value === null ? '' : String(value);
}

function field(f: SettingField): HTMLElement {
  const { group, name } = title(f.key);
  const id = `setting-${f.key}`;
  const description = h('div', { class: 'setting-description' }, markdown(f.description));
  const heading = h('label', { class: 'setting-title', for: id }, group ? h('span', { class: 'setting-group' }, `${group}: `) : undefined, name);
  let control: HTMLInputElement | HTMLSelectElement;
  const row = h('div', { class: 'setting', 'data-key': f.key });

  if (f.type === 'boolean') {
    control = h('input', { id, type: 'checkbox' });
    control.addEventListener('change', () => host.send({ type: 'settingChange', key: f.key, value: (control as HTMLInputElement).checked }));
    row.append(heading, h('div', { class: 'setting-check' }, control, description));
  } else if (f.options) {
    control = h('select', { id }, ...f.options.map((o) => h('option', { value: o }, o)));
    control.addEventListener('change', () => host.send({ type: 'settingChange', key: f.key, value: control.value }));
    row.append(heading, description, control);
  } else {
    control = h('input', { id, type: f.type === 'number' ? 'number' : 'text', min: f.minimum, max: f.maximum, spellcheck: 'false' });
    const problem = h('div', { class: 'setting-problem' });
    control.addEventListener('change', () => {
      if (f.type !== 'number') return host.send({ type: 'settingChange', key: f.key, value: control.value });
      const value = Number(control.value);
      const bad =
        control.value.trim() === '' || !Number.isFinite(value)
          ? 'Enter a number.'
          : f.minimum !== undefined && value < f.minimum
            ? `The minimum is ${f.minimum}.`
            : f.maximum !== undefined && value > f.maximum
              ? `The maximum is ${f.maximum}.`
              : '';
      problem.textContent = bad;
      control.classList.toggle('invalid', !!bad);
      if (!bad) host.send({ type: 'settingChange', key: f.key, value });
    });
    row.append(heading, description, control, problem);
  }
  setControl(control, f.value);
  controls.set(f.key, control);
  return row;
}

export function openSettings(fields: SettingField[], focus: string | undefined): void {
  const existing = tab && find({ kind: 'settings', id: 0 });
  if (!existing) {
    controls.clear();
    const content = h('div', { class: 'settings' }, h('div', { class: 'settings-inner' }, h('h1', {}, 'Settings'), ...fields.map(field)));
    tab = open({ kind: 'settings', id: 0, title: 'Settings', icon: { id: 'settings-gear' }, content, focus: () => content.focus() }, 'active', false);
    content.tabIndex = -1;
  } else activate(existing, true);
  if (focus) {
    const target = [...controls.keys()].find((k) => k.startsWith(focus));
    const row = target ? tab!.content.querySelector(`[data-key="${CSS.escape(target)}"]`) : null;
    row?.scrollIntoView({ block: 'start' });
  }
}

/** The host says what the settings are now (one may have been changed elsewhere). */
export function settingsValues(values: Record<string, unknown>): void {
  for (const [key, control] of controls) {
    if (document.activeElement === control && control instanceof HTMLInputElement && control.type !== 'checkbox') continue;
    if (key in values) setControl(control, values[key]);
  }
}
