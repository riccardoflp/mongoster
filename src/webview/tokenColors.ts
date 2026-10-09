import { ROLE_SCOPES, TokenColors, TokenRole, isColor } from '../shared/tokenColors';

/** Applies the theme's syntax colors sent by the extension as `--t-*` variables (see `themeColors.ts`). */
function apply(colors: TokenColors | undefined): void {
  const root = document.documentElement.style;
  for (const role of Object.keys(ROLE_SCOPES) as TokenRole[]) {
    const c = colors?.[role];
    if (isColor(c)) root.setProperty(`--t-${role}`, c);
    else root.removeProperty(`--t-${role}`);
  }
}

try {
  apply(JSON.parse(document.body.dataset.tokenColors ?? '{}') as TokenColors);
} catch {
  // Without them the stylesheets fall back to the debug token colors of the theme.
}

window.addEventListener('message', (e: MessageEvent<{ type?: string; colors?: TokenColors }>) => {
  if (e.data?.type === 'tokenColors') apply(e.data.colors);
});
