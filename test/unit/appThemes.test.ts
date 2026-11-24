// The color themes of the desktop app: every theme gives every variable of its base, readable text, panels that stand
// out from the window in the islands layout, and the ids the settings of earlier versions name.
import { describe, expect, it } from 'vitest';
import { THEMES, defaultTheme, findTheme, mix, themeFile, themeInfo, themePreview } from '../../src/standalone/theme';

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as [r, g, b, a] (0–255, a 0–1). */
function rgba(color: string): [number, number, number, number] {
  const hex = color.length === 4 ? `#${[...color.slice(1)].map((c) => c + c).join('')}` : color;
  const n = (i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return [n(0), n(1), n(2), hex.length === 9 ? n(3) / 255 : 1];
}

/** A color with transparency as it shows over an opaque one. */
function over(color: string, below: string): [number, number, number] {
  const [r, g, b, a] = rgba(color);
  const [r2, g2, b2] = rgba(below);
  return [r * a + r2 * (1 - a), g * a + g2 * (1 - a), b * a + b2 * (1 - a)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The WCAG contrast of a text color on a background, both possibly with transparency over `base`. */
function contrast(text: string, background: string, base: string): number {
  const bg = over(background, base);
  const fg = over(text, `#${bg.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/;

describe('the themes', () => {
  it('settings.appearance: have their own ids and names, and keep the two of the earlier versions', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.label)).size).toBe(THEMES.length);
    expect(THEMES.map((t) => t.id)).not.toContain('system');
    expect(defaultTheme('dark').label).toBe('Mongoster Dark');
    expect(defaultTheme('light').label).toBe('Mongoster Light');
    expect(findTheme('no-such-theme')).toBeUndefined();
  });

  it('settings.appearance: give every variable of the base of their kind, as colors', () => {
    for (const kind of ['dark', 'light'] as const) {
      const base = Object.keys(themeInfo(defaultTheme(kind)).vars).sort();
      for (const theme of THEMES.filter((t) => t.kind === kind)) {
        const { vars, syntax } = themeInfo(theme);
        expect(Object.keys(vars).sort(), theme.id).toEqual(base);
        for (const [name, value] of Object.entries(vars)) {
          if (name.includes('font')) continue;
          expect(value === 'transparent' || COLOR.test(value), `${theme.id} ${name}: ${value}`).toBe(true);
        }
        expect(Object.values(syntax).every((c) => COLOR.test(c)), theme.id).toBe(true);
      }
    }
  });

  it('settings.appearance: have readable text on their backgrounds', () => {
    for (const theme of THEMES) {
      const v = themeInfo(theme).vars;
      const side = v['sideBar-background'];
      const pairs: [string, string, string, number][] = [
        ['the text', v.foreground, v['editor-background'], 4.5],
        ['the side bar', v['sideBar-foreground'], side, 4.5],
        ['the selected tab', v['tab-activeForeground'], v['tab-activeBackground'], 4.5],
        ['the selected row', v['list-activeSelectionForeground'], v['list-activeSelectionBackground'], 4.5],
        ['the inputs', v['input-foreground'], v['input-background'], 4.5],
        ['a button', v['button-foreground'], v['button-background'], 3],
        ['the descriptions', v.descriptionForeground, v['editor-background'], 3],
        ['the other tabs', v['tab-inactiveForeground'], v['tab-inactiveBackground'], 3],
      ];
      for (const [what, text, background, minimum] of pairs) {
        expect.soft(contrast(text, background, side), `${theme.id}: ${what}`).toBeGreaterThanOrEqual(minimum);
      }
      // The values in the table and in the editor; comments may be quieter, as in most themes.
      for (const [token, color] of Object.entries(theme.syntax)) {
        if (token === 'comment') continue;
        expect.soft(contrast(color, v['editor-background'], side), `${theme.id}: ${token}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('settings.appearance: set the panels of the islands layout apart from the window', () => {
    for (const theme of THEMES) {
      const v = themeInfo(theme).vars;
      if (v['mongoster-island-border'] !== 'transparent') continue;
      const window = v['mongoster-window-background'];
      for (const panel of [v['sideBar-background'], v['editor-background']]) {
        expect.soft(contrast(window, panel, panel), `${theme.id}: ${panel} on ${window}`).toBeGreaterThan(1.05);
      }
    }
  });

  it('settings.appearance: are color theme files with their name and syntax colors, for the extension', () => {
    const file = JSON.parse(themeFile(findTheme('nord')!)) as { name: string; tokenColors: { scope: string[]; settings: { foreground: string } }[] };
    expect(file.name).toBe('Nord');
    expect(file.tokenColors.find((r) => r.scope.includes('string'))?.settings.foreground).toBe(findTheme('nord')!.syntax.string);
  });

  it('settings.appearance: have a preview drawn with their own opaque colors', () => {
    for (const theme of THEMES) {
      const preview = themePreview(theme);
      const { vars } = themeInfo(theme);
      expect(preview).toMatchObject({ id: theme.id, label: theme.label, kind: theme.kind });
      for (const color of [preview.window, preview.sideBar, preview.tabs, preview.editor, preview.foreground, preview.accent, ...preview.syntax]) {
        expect(color, theme.id).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      }
      expect(preview.editor).toBe(vars['editor-background'].slice(0, 7));
      expect(preview.syntax).toEqual([theme.syntax.keyword, theme.syntax.property, theme.syntax.string, theme.syntax.number, theme.syntax.comment].map((c) => c.slice(0, 7)));
    }
    // The previews tell the themes apart.
    expect(new Set(THEMES.map((t) => JSON.stringify({ ...themePreview(t), id: '', label: '' }))).size).toBe(THEMES.length);
  });

  it('settings.appearance: mix two colors', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#102030', '#102030', 0.3)).toBe('#102030');
    expect(mix('#ff0000', '#0000ff', 0)).toBe('#ff0000');
  });
});
