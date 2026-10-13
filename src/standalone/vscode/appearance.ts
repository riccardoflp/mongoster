// The color theme of the app: dark or light, following the operating system unless the user chose one.
import { nativeTheme } from 'electron';
import type { ThemeKind } from '../protocol';
import { THEME_NAMES, themeInfo } from '../theme';
import { ColorThemeKind, EventEmitter, Uri } from './base';
import { post } from './bridge';
import { THEME_SCHEME } from './documents';
import { settings } from './storage';

export const THEME_SETTING = 'app.theme';

export interface ColorTheme {
  readonly kind: ColorThemeKind;
}

const changed = new EventEmitter<ColorTheme>();
export const onDidChangeActiveColorTheme = changed.event;

export function themeKind(): ThemeKind {
  const chosen = settings.value(THEME_SETTING);
  if (chosen === 'dark' || chosen === 'light') return chosen;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export const activeColorTheme: ColorTheme = {
  get kind() {
    return themeKind() === 'dark' ? ColorThemeKind.Dark : ColorThemeKind.Light;
  },
};

/**
 * The app's themes as an extension contributing them, which is where the extension code looks for
 * the syntax colors of the active theme.
 */
export const themeExtension = {
  id: 'mongoster.app-themes',
  extensionUri: Uri.from({ scheme: THEME_SCHEME, path: '/themes' }),
  packageJSON: {
    contributes: {
      themes: [
        { label: THEME_NAMES.dark, uiTheme: 'vs-dark', path: 'dark.json' },
        { label: THEME_NAMES.light, uiTheme: 'vs', path: 'light.json' },
      ],
    },
  },
};

export function initAppearance(): void {
  let current = themeKind();
  const apply = () => {
    const chosen = settings.value(THEME_SETTING);
    // The native menus and dialogs follow the choice too.
    nativeTheme.themeSource = chosen === 'dark' || chosen === 'light' ? chosen : 'system';
    const kind = themeKind();
    if (kind === current) return;
    current = kind;
    post({ type: 'theme', theme: themeInfo(kind) });
    changed.fire(activeColorTheme);
    settings.fire(['workbench.colorTheme']);
  };
  settings.compute('workbench.colorTheme', () => THEME_NAMES[themeKind()]);
  settings.onDidChange((e) => {
    if (e.affectsConfiguration(THEME_SETTING)) apply();
  });
  nativeTheme.on('updated', apply);
  apply();
}
