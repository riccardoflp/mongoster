import * as vscode from 'vscode';
import JSON5 from 'json5';
import { ROLE_SCOPES, TokenColors, TokenRole, TokenRule, customizationRules, isColor, resolveTokenColors } from './shared/tokenColors';

/**
 * The syntax colors of the active color theme, for the values shown in the webviews. Webviews get
 * the theme's UI colors from VS Code but not its syntax colors, so they are read from the theme's
 * file (with its `include`s) and `editor.tokenColorCustomizations`, and sent again when they change.
 */
export class ThemeColors {
  private static colors: TokenColors = {};
  private static readonly webviews = new Set<vscode.Webview>();
  private static loading = 0;

  static init(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => void ThemeColors.reload()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('editor.tokenColorCustomizations') ||
          e.affectsConfiguration('workbench.colorTheme') ||
          e.affectsConfiguration('workbench.preferredDarkColorTheme') ||
          e.affectsConfiguration('workbench.preferredLightColorTheme') ||
          e.affectsConfiguration('workbench.preferredHighContrastColorTheme') ||
          e.affectsConfiguration('workbench.preferredHighContrastLightColorTheme') ||
          e.affectsConfiguration('window.autoDetectColorScheme')
        )
          void ThemeColors.reload();
      }),
      vscode.extensions.onDidChange(() => void ThemeColors.reload()),
    );
    void ThemeColors.reload();
  }

  /** The colors as a `data-token-colors` attribute for the webview's `<body>`. */
  static bodyAttribute(): string {
    return ` data-token-colors="${JSON.stringify(ThemeColors.colors).replace(/"/g, '&quot;')}"`;
  }

  /** Sends the colors to the panel's webview whenever they change, until it's closed. */
  static attach(panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    ThemeColors.webviews.add(webview);
    panel.onDidDispose(() => ThemeColors.webviews.delete(webview));
  }

  private static async reload(): Promise<void> {
    const run = ++ThemeColors.loading;
    let colors: TokenColors = {};
    try {
      colors = await loadColors();
    } catch {
      // An unreadable theme keeps the default colors of the webviews.
    }
    if (run !== ThemeColors.loading) return;
    const same = (Object.keys(ROLE_SCOPES) as TokenRole[]).every((r) => colors[r] === ThemeColors.colors[r]);
    ThemeColors.colors = colors;
    if (!same) for (const w of ThemeColors.webviews) void w.postMessage({ type: 'tokenColors', colors });
  }
}

interface ThemeContribution {
  id?: string;
  label?: string;
  path?: string;
  uiTheme?: string;
}

const UI_THEME: Record<number, string> = {
  [vscode.ColorThemeKind.Light]: 'vs',
  [vscode.ColorThemeKind.Dark]: 'vs-dark',
  [vscode.ColorThemeKind.HighContrast]: 'hc-black',
  [vscode.ColorThemeKind.HighContrastLight]: 'hc-light',
};

/** The settings that can name the active theme, the most likely first for the current kind of theme. */
function themeNames(): string[] {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const kind = vscode.window.activeColorTheme.kind;
  const preferred: Record<number, string> = {
    [vscode.ColorThemeKind.Light]: 'preferredLightColorTheme',
    [vscode.ColorThemeKind.Dark]: 'preferredDarkColorTheme',
    [vscode.ColorThemeKind.HighContrast]: 'preferredHighContrastColorTheme',
    [vscode.ColorThemeKind.HighContrastLight]: 'preferredHighContrastLightColorTheme',
  };
  const auto = vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme');
  const names = auto ? [preferred[kind], 'colorTheme'] : ['colorTheme', preferred[kind]];
  return names.map((n) => workbench.get<string>(n)).filter((n): n is string => !!n);
}

function findTheme(name: string): { extension: vscode.Extension<unknown>; theme: ThemeContribution } | undefined {
  for (const extension of vscode.extensions.all) {
    const themes = (extension.packageJSON?.contributes?.themes ?? []) as ThemeContribution[];
    const theme = Array.isArray(themes) ? themes.find((t) => (t.id ?? t.label) === name) : undefined;
    if (theme?.path) return { extension, theme };
  }
  return undefined;
}

async function loadColors(): Promise<TokenColors> {
  const kind = UI_THEME[vscode.window.activeColorTheme.kind];
  const found = themeNames()
    .map((name) => ({ name, match: findTheme(name) }))
    .filter((f) => f.match);
  // The theme in the settings may not be the one showing (e.g. high contrast forced by the OS).
  const active = found.find((f) => f.match!.theme.uiTheme === kind) ?? found[0];
  if (!active) return {};
  const rules = await readRules(vscode.Uri.joinPath(active.match!.extension.extensionUri, active.match!.theme.path!), 0);
  const custom = vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations');
  return resolveTokenColors([...rules, ...customizationRules(custom, active.name)]);
}

/** The token rules of a theme file: those of the file it includes first, then its own. */
async function readRules(uri: vscode.Uri, depth: number): Promise<TokenRule[]> {
  if (depth > 8 || !uri.path.toLowerCase().endsWith('.json')) return []; // .tmTheme files aren't read
  const theme = JSON5.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as {
    include?: string;
    tokenColors?: TokenRule[] | string;
  };
  const dir = vscode.Uri.joinPath(uri, '..');
  const included = typeof theme.include === 'string' ? await readRules(vscode.Uri.joinPath(dir, theme.include), depth + 1) : [];
  const own = Array.isArray(theme.tokenColors)
    ? theme.tokenColors
    : typeof theme.tokenColors === 'string'
      ? await readRules(vscode.Uri.joinPath(dir, theme.tokenColors), depth + 1)
      : [];
  return [...included, ...own.filter((r) => r && typeof r === 'object' && isColor(r.settings?.foreground))];
}
