// The colors that mark connections and collections (D16, D17): eleven presets, which are theme colors, and custom
// colors `#rrggbb`. Where VS Code takes only a theme color (icons and names in the tree, tab icons, the names of editor
// tabs) a custom color shows as its nearest preset; where Mongoster draws it itself it is exact.
// No vscode dependency: the host, the webviews and the desktop app's theme use it.

/** The presets, in the order the quick picks show them. The first six are the theme's `charts.*` colors. */
export const PRESET_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'teal', 'indigo', 'brown', 'gray'] as const;
export type PresetColor = (typeof PRESET_COLORS)[number];
/** A custom color: `#` and six lower-case hex digits. */
export type HexColor = `#${string}`;
export type Color = PresetColor | HexColor;

/** The theme's own `charts.*` colors; the others are contributed by Mongoster as `mongoster.color.<name>`. */
const CHARTS: readonly string[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/**
 * The default value of each preset in dark and light themes: VS Code's `charts.*` for the first six, Mongoster's
 * `contributes.colors` defaults for the others (a test checks `package.json` against this table), and the colors of
 * the leaves in `media/connection/`.
 */
export const PRESET_DEFAULTS: Record<PresetColor, { dark: string; light: string }> = {
  red: { dark: '#f14c4c', light: '#e51400' },
  orange: { dark: '#d18616', light: '#d18616' },
  yellow: { dark: '#cca700', light: '#bf8803' },
  green: { dark: '#89d185', light: '#388a34' },
  blue: { dark: '#3794ff', light: '#1a85ff' },
  purple: { dark: '#b180d7', light: '#652d90' },
  pink: { dark: '#f075b5', light: '#c2185b' },
  teal: { dark: '#4ec9b0', light: '#00897b' },
  indigo: { dark: '#8c9eff', light: '#3949ab' },
  brown: { dark: '#c8956b', light: '#8d6e63' },
  gray: { dark: '#a6a6a6', light: '#6e6e6e' },
};

/** The hue of each preset other than gray, brown and indigo, to find the nearest one of a custom color. */
const HUES: Record<Exclude<PresetColor, 'gray' | 'brown' | 'indigo'>, number> = {
  red: 0,
  orange: 30,
  yellow: 55,
  green: 125,
  teal: 170,
  blue: 215,
  purple: 280,
  pink: 330,
};

export function isPreset(value: unknown): value is PresetColor {
  return typeof value === 'string' && (PRESET_COLORS as readonly string[]).includes(value);
}

/** `#rrggbb` or `#rgb`, any case, as `#rrggbb` in lower case; undefined for anything else. */
export function normalizeHex(value: string): HexColor | undefined {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (!hex) return undefined;
  return `#${(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex).toLowerCase()}`;
}

/** A preset name or a custom color in its stored form (`#rrggbb`, lower case). */
export function isColor(value: unknown): value is Color {
  return isPreset(value) || (typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value));
}

/** The stored form of a color read from a file: a preset name, or a hex color normalized; undefined otherwise. */
export function readColor(value: unknown): Color | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return isPreset(v) ? v : normalizeHex(v);
}

/**
 * The preset nearest to a color: a preset is itself; a custom color goes to the preset of the nearest hue, gray when
 * it has almost no saturation, brown when it is a dark orange, indigo when it is a deep blue.
 */
export function nearestPreset(color: Color): PresetColor {
  if (isPreset(color)) return color;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.12) return 'gray';
  const hue = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  // A dark orange is brown.
  if (max < 0.65 && hue >= 10 && hue <= 45) return 'brown';
  const distance = (c: keyof typeof HUES) => Math.min(Math.abs(hue - HUES[c]), 360 - Math.abs(hue - HUES[c]));
  const nearest = (Object.keys(HUES) as (keyof typeof HUES)[]).reduce((best, c) => (distance(c) < distance(best) ? c : best));
  // A darker, deeper blue is indigo; a bright one stays blue.
  return nearest === 'blue' && hue >= 220 && max < 0.8 ? 'indigo' : nearest;
}

/** The theme color id of a preset, or of a custom color's nearest preset. */
export function themeColorId(color: Color): string {
  const preset = nearestPreset(color);
  return CHARTS.includes(preset) ? `charts.${preset}` : `mongoster.color.${preset}`;
}

/** A color as CSS, for the webviews: the theme's variable of a preset (with its dark default), or the custom color. */
export function cssColorOf(color: Color): string {
  if (!isPreset(color)) return color;
  return `var(--vscode-${themeColorId(color).replace(/\./g, '-')}, ${PRESET_DEFAULTS[color].dark})`;
}

/** The name a color is shown with: `Pink`, or the custom color `#12abef`. */
export function colorLabel(color: Color): string {
  return isPreset(color) ? `${color[0].toUpperCase()}${color.slice(1)}` : color;
}

/** What a choice of `Set Color…` sets: a color, none, the connection's color (collections only), or a custom one. */
export type ColorChoiceValue = Color | 'none' | 'connection' | 'custom';

export interface ColorChoice {
  label: string;
  value: ColorChoiceValue;
  /** The preset whose leaf the item shows. */
  icon?: PresetColor;
  description?: string;
}

/**
 * The choices of `Set Color…`: the eleven presets, `None`, for a collection `Connection's Color` (described with the
 * connection's color), and `Custom Color…` (described with the custom color in use). The current choice is described
 * `current`: for a connection `current` undefined is `None`, for a collection it is `Connection's Color`.
 */
export function colorChoices(current: Color | 'none' | undefined, collection?: { connectionColor: Color | undefined }): ColorChoice[] {
  const now: ColorChoiceValue = current === undefined ? (collection ? 'connection' : 'none') : isPreset(current) || current === 'none' ? current : 'custom';
  const choices: ColorChoice[] = [
    ...PRESET_COLORS.map((color): ColorChoice => ({ label: colorLabel(color), value: color, icon: color })),
    { label: 'None', value: 'none' },
    ...(collection ? [{ label: "Connection's Color", value: 'connection' as const, description: collection.connectionColor ? colorLabel(collection.connectionColor) : 'none' }] : []),
    { label: 'Custom Color…', value: 'custom', ...(now === 'custom' && { description: current }) },
  ];
  return choices.map((c) => (c.value === now ? { ...c, description: [c.description, 'current'].filter(Boolean).join(' · ') } : c));
}
