// The color theme and the layout of the app: the theme follows the operating system unless the user chose one.
import { nativeTheme } from 'electron';
import type { Layout, ThemeInfo, ThemeKind } from '../protocol';
import { THEMES, ThemeDefinition, defaultTheme, findTheme, themeInfo } from '../theme';
import { ColorThemeKind, EventEmitter, Uri } from './base';
import { post } from './bridge';
import { THEME_SCHEME } from './documents';
import { settings } from './storage';

export const THEME_SETTING = 'app.theme';
export const LAYOUT_SETTING = 'app.layout';

export interface ColorTheme {
  readonly kind: ColorThemeKind;
}

const changed = new EventEmitter<ColorTheme>();
export const onDidChangeActiveColorTheme = changed.event;

/** The theme chosen in the settings, or none when the app follows the operating system. */
function chosenTheme(): ThemeDefinition | undefined {
  const chosen = settings.value(THEME_SETTING);
  return typeof chosen === 'string' ? findTheme(chosen) : undefined;
}

/** Feature: settings.appearance */
export function activeTheme(): ThemeDefinition {
  return chosenTheme() ?? defaultTheme(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

export function themeKind(): ThemeKind {
  return activeTheme().kind;
}

export function activeThemeInfo(): ThemeInfo {
  return themeInfo(activeTheme());
}

export function layout(): Layout {
  return settings.value(LAYOUT_SETTING) === 'compact' ? 'compact' : 'islands';
}

/** The color of the window before the page paints it: what shows around the panels, or the editor's. */
export function windowBackground(): string {
  const vars = activeThemeInfo().vars;
  return (layout() === 'islands' ? vars['mongoster-window-background'] : vars['editor-background']).slice(0, 7);
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
      themes: THEMES.map((t) => ({ label: t.label, uiTheme: t.kind === 'dark' ? 'vs-dark' : 'vs', path: `${t.id}.json` })),
    },
  },
};

export function initAppearance(): void {
  let current = activeTheme().id;
  const apply = () => {
    // The native menus and dialogs follow the kind of the chosen theme.
    nativeTheme.themeSource = chosenTheme()?.kind ?? 'system';
    const theme = activeTheme();
    if (theme.id === current) return;
    current = theme.id;
    post({ type: 'theme', theme: themeInfo(theme) });
    // As in VS Code, any change of theme is announced, also between two of the same kind.
    changed.fire(activeColorTheme);
    // The extension reads the syntax colors again from the theme now named here.
    settings.fire(['workbench.colorTheme']);
  };
  settings.compute('workbench.colorTheme', () => activeTheme().label);
  settings.onDidChange((e) => {
    if (e.affectsConfiguration(THEME_SETTING)) apply();
    if (e.affectsConfiguration(LAYOUT_SETTING)) post({ type: 'layout', layout: layout() });
  });
  nativeTheme.on('updated', apply);
  apply();
}
