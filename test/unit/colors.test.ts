// The colors of connections and collections (D17): the presets, custom colors, the nearest preset where VS Code takes
// only theme colors, the files and theme colors that must agree with the table, and Compass's codes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  PRESET_COLORS,
  PRESET_DEFAULTS,
  colorChoices,
  colorLabel,
  cssColorOf,
  isColor,
  nearestPreset,
  normalizeHex,
  readColor,
  themeColorId,
} from '../../src/shared/colors';
import { compassColor, colorFrom, parseConnections, serializeConnections } from '../../src/shared/connectionsFile';
import { paintTab, tabIcon, themeColorOf } from '../../src/connectionColors';
import { paintStripe } from '../../src/webview/stripe';

describe('presets and custom colors', () => {
  it('has eleven presets: the six charts colors first, then five of its own', () => {
    expect(PRESET_COLORS).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'teal', 'indigo', 'brown', 'gray']);
    expect(themeColorId('red')).toBe('charts.red');
    expect(themeColorId('pink')).toBe('mongoster.color.pink');
  });

  it('reads a preset name or a hex color, and refuses anything else', () => {
    expect(readColor(' Teal ')).toBe('teal');
    expect(readColor('#ABC')).toBe('#aabbcc');
    expect(readColor('12abef')).toBe('#12abef');
    expect(readColor('magenta')).toBeUndefined();
    expect(readColor('#12345')).toBeUndefined();
    expect(readColor(7)).toBeUndefined();
    expect(normalizeHex('#FfFfFf')).toBe('#ffffff');
    expect(isColor('#12abef')).toBe(true);
    expect(isColor('#12ABEF')).toBe(false);
    expect(isColor('none')).toBe(false);
  });

  it('takes a custom color to the nearest preset', () => {
    expect(nearestPreset('#ff0000')).toBe('red');
    expect(nearestPreset('#ffa500')).toBe('orange');
    expect(nearestPreset('#00ff00')).toBe('green');
    expect(nearestPreset('#20b2aa')).toBe('teal');
    expect(nearestPreset('#1e90ff')).toBe('blue');
    expect(nearestPreset('#4b0082')).toBe('purple');
    expect(nearestPreset('#5c6bc0')).toBe('indigo');
    expect(nearestPreset('#ff69b4')).toBe('pink');
    expect(nearestPreset('#8b4513')).toBe('brown');
    expect(nearestPreset('#808080')).toBe('gray');
    expect(nearestPreset('#101010')).toBe('gray');
    expect(nearestPreset('teal')).toBe('teal');
    expect(themeColorId('#ff69b4')).toBe('mongoster.color.pink');
    expect(themeColorId('#ff0000')).toBe('charts.red');
  });

  it('writes a color as CSS: the theme variable of a preset, the custom color as it is', () => {
    expect(cssColorOf('red')).toBe('var(--vscode-charts-red, #f14c4c)');
    expect(cssColorOf('gray')).toBe('var(--vscode-mongoster-color-gray, #a6a6a6)');
    expect(cssColorOf('#12abef')).toBe('#12abef');
    expect(colorLabel('indigo')).toBe('Indigo');
    expect(colorLabel('#12abef')).toBe('#12abef');
  });
});

describe('the choices of Set Color… on a connection', () => {
  it('offers the presets with their leaves, None and Custom Color…', () => {
    const choices = colorChoices(undefined);
    expect(choices.map((c) => c.label)).toEqual([...PRESET_COLORS.map(colorLabel), 'None', 'Custom Color…']);
    expect(choices.slice(0, 11).every((c) => c.icon === c.value)).toBe(true);
    expect(choices.find((c) => c.value === 'none')?.description).toBe('current');
    expect(colorChoices('brown').find((c) => c.value === 'brown')?.description).toBe('current');
    expect(colorChoices('#12abef').at(-1)?.description).toBe('#12abef · current');
  });
});

describe('the files and theme colors that follow the presets', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { colors: { id: string; defaults: Record<string, string> }[] } };

  it("contributes the five presets VS Code lacks, with the table's defaults", () => {
    const own = PRESET_COLORS.filter((c) => themeColorId(c).startsWith('mongoster.'));
    expect(pkg.contributes.colors.map((c) => c.id)).toEqual(own.map(themeColorId));
    for (const c of own) {
      const declared = pkg.contributes.colors.find((d) => d.id === themeColorId(c))!.defaults;
      expect(declared, c).toMatchObject({ dark: PRESET_DEFAULTS[c].dark, light: PRESET_DEFAULTS[c].light });
    }
  });

  it('has a leaf for each preset, in its dark and light color', () => {
    for (const c of PRESET_COLORS) {
      for (const kind of ['dark', 'light'] as const) {
        const svg = readFileSync(`media/connection/${c}-${kind}.svg`, 'utf8');
        expect(svg, `${c}-${kind}`).toContain(`fill="${PRESET_DEFAULTS[c][kind]}"`);
      }
    }
  });
});

describe('where a custom color shows', () => {
  const root = vscode.Uri.from({ scheme: 'file', path: '/ext' });

  it("is its nearest preset's theme color and leaf where VS Code takes only those", () => {
    expect(themeColorOf('#ff69b4').id).toBe('mongoster.color.pink');
    expect((tabIcon(root, '#ff69b4') as { light: vscode.Uri }).light.path).toBe('/ext/media/connection/pink-light.svg');
  });

  it("is exact on the desktop app's line above the tab", () => {
    const panel = {} as vscode.WebviewPanel & { tabColor?: unknown };
    paintTab(panel, root, '#ff69b4');
    expect(panel.tabColor).toBe('#ff69b4');
    paintTab(panel, root, 'teal');
    expect((panel.tabColor as vscode.ThemeColor).id).toBe('mongoster.color.teal');
    paintTab(panel, root, undefined);
    expect(panel.tabColor).toBeUndefined();
  });

  it('is exact on the stripe of the webviews', () => {
    const props = new Map<string, string>();
    const element = { dataset: {} as Record<string, string>, style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } };
    paintStripe(element as unknown as HTMLElement, '#FF69B4');
    expect(element.dataset.color).toBe('#ff69b4');
    expect(props.get('--conn-color')).toBe('#ff69b4');
    paintStripe(element as unknown as HTMLElement, 'pink');
    expect(props.get('--conn-color')).toBe('var(--vscode-mongoster-color-pink, #f075b5)');
    paintStripe(element as unknown as HTMLElement, undefined);
    expect(element.dataset.color).toBeUndefined();
    expect(props.has('--conn-color')).toBe(false);
  });
});

describe("Compass's colors", () => {
  it('writes each preset as a Compass code and reads it back; brown goes as orange, a custom color as its nearest', () => {
    for (const c of PRESET_COLORS) expect(colorFrom(compassColor(c)), c).toBe(c === 'brown' ? 'orange' : c);
    expect(compassColor('#ff69b4')).toBe('color7');
  });

  it("keeps a custom color in Mongoster's format, and takes it to the nearest preset in Compass's", async () => {
    const list = [{ name: 'a', uri: 'mongodb://h/db', color: '#12abef' as const, notes: [] }];
    const mongoster = await serializeConnections(list, 'mongoster', { secrets: 'remove' });
    expect((await parseConnections(mongoster.text)).connections[0].color).toBe('#12abef');
    const compass = await serializeConnections(list, 'compass', { secrets: 'remove' });
    expect((await parseConnections(compass.text)).connections[0].color).toBe('blue');
  });
});
