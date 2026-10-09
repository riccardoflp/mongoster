/** The colors of the active theme's syntax highlighting, for the values shown in the webviews. */

export type TokenRole = 'key' | 'string' | 'number' | 'bool' | 'oid' | 'date' | 'regex';
export type TokenColors = Partial<Record<TokenRole, string>>;

export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string };
}

/**
 * The scopes a token of each kind has in the editor, outermost first: the values are colored as
 * in a JSON file; ObjectId, dates and regexes take the colors of keywords, types and regexes.
 */
export const ROLE_SCOPES: Record<TokenRole, string[]> = {
  key: ['source.json', 'meta.structure.dictionary.json', 'string.json', 'support.type.property-name.json'],
  string: ['source.json', 'meta.structure.dictionary.json', 'meta.structure.dictionary.value.json', 'string.quoted.double.json'],
  number: ['source.json', 'meta.structure.dictionary.json', 'meta.structure.dictionary.value.json', 'constant.numeric.json'],
  bool: ['source.json', 'meta.structure.dictionary.json', 'meta.structure.dictionary.value.json', 'constant.language.json'],
  oid: ['source.js', 'keyword.control.flow.js'],
  date: ['source.js', 'support.class.js'],
  regex: ['source.js', 'string.regexp.js'],
};

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`: anything else is ignored. */
export function isColor(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
}

/** `string` matches `string` and `string.quoted.double.json`, not `strings`. */
const matches = (part: string, scope: string) => scope === part || scope.startsWith(`${part}.`);

/**
 * How well a selector (`string`, `source.json constant.language`) matches a token's scopes, as
 * TextMate ranks it: the deeper the scope its last part matches, then the longer that part, then the
 * more parents it names. Undefined when it doesn't match; selectors with exclusions are skipped.
 */
export function selectorScore(selector: string, scopes: string[]): number[] | undefined {
  const parts = selector.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || /[()|&>:]/.test(selector) || parts.some((p) => p.startsWith('-'))) return undefined;
  const last = parts[parts.length - 1];
  for (let depth = scopes.length - 1; depth >= 0; depth--) {
    if (!matches(last, scopes[depth])) continue;
    // The parents, in order, among the scopes outside the matched one.
    let i = depth - 1;
    let ok = true;
    for (let p = parts.length - 2; p >= 0 && ok; p--) {
      while (i >= 0 && !matches(parts[p], scopes[i])) i--;
      if (i < 0) ok = false;
      else i--;
    }
    if (ok) return [depth, last.split('.').length, parts.length - 1];
  }
  return undefined;
}

const better = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true; // a later rule wins a tie
};

/** The foreground of each role with the given rules (included themes first, customizations last). */
export function resolveTokenColors(rules: TokenRule[]): TokenColors {
  const out: TokenColors = {};
  for (const role of Object.keys(ROLE_SCOPES) as TokenRole[]) {
    let best: number[] | undefined;
    for (const rule of rules) {
      const fg = rule.settings?.foreground;
      if (!isColor(fg) || rule.scope === undefined) continue;
      const selectors = (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).flatMap((s) => String(s).split(','));
      for (const sel of selectors) {
        const score = selectorScore(sel, ROLE_SCOPES[role]);
        if (score && (!best || better(score, best))) {
          best = score;
          out[role] = fg;
        }
      }
    }
  }
  return out;
}

/** The scopes VS Code gives to the shorthands of `editor.tokenColorCustomizations`. */
const SHORTHANDS: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/**
 * The rules of `editor.tokenColorCustomizations`: the general ones, then those for the theme
 * (`"[Dark Modern]": { … }`), each as shorthands then `textMateRules`.
 */
export function customizationRules(custom: unknown, theme: string): TokenRule[] {
  if (!custom || typeof custom !== 'object') return [];
  const c = custom as Record<string, unknown>;
  const rulesOf = (o: unknown): TokenRule[] => {
    if (!o || typeof o !== 'object') return [];
    const r = o as Record<string, unknown>;
    const out: TokenRule[] = [];
    for (const [name, scopes] of Object.entries(SHORTHANDS)) {
      const v = r[name];
      const fg = typeof v === 'string' ? v : (v as { foreground?: unknown } | undefined)?.foreground;
      if (isColor(fg)) out.push({ scope: scopes, settings: { foreground: fg } });
    }
    if (Array.isArray(r.textMateRules)) out.push(...(r.textMateRules as TokenRule[]));
    return out;
  };
  return [...rulesOf(c), ...rulesOf(c[`[${theme}]`])];
}
