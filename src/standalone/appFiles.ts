// Which file of the app a URL of the app's protocol names, or why it names none. No electron dependency:
// the path rules are given as an argument so the tests can check Windows' ones on any system.
import * as path from 'path';

export type AppFile = { file: string } | { status: 400 | 403 };

/**
 * The file `pathname` (as in the URL, still percent-encoded) names under `root`; with `folders`, only inside
 * one of those folders of the root. The restriction is checked on the resolved path, not on the text of the
 * URL: what is compared is then what is read, however the path was written.
 */
export function appFile(root: string, pathname: string, folders?: readonly string[], rules: path.PlatformPath = path): AppFile {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    // A malformed escape (`%E0%A4%A`, `%zz`).
    return { status: 400 };
  }
  // No file the app ships has a backslash or a NUL in its name. On Windows a backslash is a separator the
  // URL's normalization doesn't know (`dist/..%5Cpackage.json`), and a NUL ends the name for some system calls.
  if (/[\\\0]/.test(relative)) return { status: 403 };
  const file = rules.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  const within = (folder: string) => file.startsWith(folder.endsWith(rules.sep) ? folder : folder + rules.sep);
  if (folders ? !folders.some((f) => within(rules.join(root, f))) : file !== root && !within(root)) return { status: 403 };
  return { file };
}
