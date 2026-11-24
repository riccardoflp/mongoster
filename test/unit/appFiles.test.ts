// Which file a URL of the desktop app's protocol may read, with the path rules of both kinds of system.
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { appFile } from '../../src/standalone/appFiles';

const FOLDERS = ['dist', 'media'];

describe.each([
  { name: 'POSIX', rules: path.posix, root: '/opt/Mongoster/resources/app', file: (...p: string[]) => `/opt/Mongoster/resources/app/${p.join('/')}` },
  { name: 'Windows', rules: path.win32, root: 'C:\\Mongoster\\resources\\app', file: (...p: string[]) => `C:\\Mongoster\\resources\\app\\${p.join('\\')}` },
])('appFile with $name paths', ({ rules, root, file }) => {
  const resource = (pathname: string) => appFile(root, pathname, FOLDERS, rules);

  it('finds the files of the allowed folders', () => {
    expect(resource('/dist/webview.js')).toEqual({ file: file('dist', 'webview.js') });
    expect(resource('/media/fonts/codicon.ttf')).toEqual({ file: file('media', 'fonts', 'codicon.ttf') });
    expect(resource('/media/a%20b.css')).toEqual({ file: file('media', 'a b.css') });
    expect(resource('/dist/app/../webview.js')).toEqual({ file: file('dist', 'webview.js') });
  });

  it('refuses what is outside them', () => {
    for (const pathname of ['/package.json', '/dist', '/dist/../package.json', '/dist/%2E%2E/package.json', '/dist%2F..%2Fpackage.json', '/node_modules/x.js', '/distant/x.js', '/'])
      expect(resource(pathname), pathname).toEqual({ status: 403 });
  });

  it('refuses a backslash, which Windows takes for a separator, and a NUL', () => {
    for (const pathname of ['/dist/..%5Cpackage.json', '/dist/..%5c..%5Csecrets.json', '/dist/..\\package.json', '/dist/%5C%5Cserver%5Cshare%5Cx', '/dist/webview.js%00.png'])
      expect(resource(pathname), pathname).toEqual({ status: 403 });
  });

  it('answers 400 to a malformed escape', () => {
    expect(resource('/dist/%E0%A4%A')).toEqual({ status: 400 });
    expect(resource('/dist/%zz')).toEqual({ status: 400 });
  });

  it('keeps the shell inside its folder', () => {
    const shell = rules.join(root, 'dist', 'app');
    expect(appFile(shell, '/index.html', undefined, rules)).toEqual({ file: rules.join(shell, 'index.html') });
    expect(appFile(shell, '/../../package.json', undefined, rules)).toEqual({ file: rules.join(shell, 'package.json') });
    expect(appFile(shell, '/..%5C..%5Cpackage.json', undefined, rules)).toEqual({ status: 403 });
  });
});
