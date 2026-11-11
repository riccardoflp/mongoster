// vscode.window.registerFileDecorationProvider: the colors of the names of tree nodes and of editor tabs.
// Badges aren't drawn: Mongoster only uses the color.
import { CancellationTokenSource, Disposable, EventEmitter, FileDecorationProvider, ThemeColor, Uri } from './base';

const providers = new Set<FileDecorationProvider>();
const changed = new EventEmitter<void>();
/** A provider was added or removed, or says its decorations changed. */
export const onDidChangeDecorations = changed.event;

export function registerFileDecorationProvider(provider: FileDecorationProvider): Disposable {
  providers.add(provider);
  const subscription = provider.onDidChangeFileDecorations?.(() => changed.fire());
  changed.fire();
  return new Disposable(() => {
    providers.delete(provider);
    subscription?.dispose();
    changed.fire();
  });
}

/** A theme color as a CSS color: the theme's variable, so it changes with the theme. */
export function cssColor(color: ThemeColor): string {
  return `var(--vscode-${color.id.replace(/\./g, '-')})`;
}

/** The color the decorations give `uri`'s name, as a CSS color. */
export async function decorationColor(uri: Uri | undefined): Promise<string | undefined> {
  if (!uri) return undefined;
  const token = new CancellationTokenSource().token;
  for (const provider of providers) {
    try {
      const decoration = await provider.provideFileDecoration(uri, token);
      if (decoration?.color) return cssColor(decoration.color);
    } catch {
      // A provider failing leaves the name as it is.
    }
  }
  return undefined;
}
