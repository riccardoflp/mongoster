import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
// The standalone app (Electron) is built on top of the extension's bundles, in dist/app.
const app = process.argv.includes('--app');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

// Optional native/peer deps of the mongodb driver: loaded lazily inside try/catch.
const optional = [
  'kerberos',
  'snappy',
  'socks',
  'aws4',
  'gcp-metadata',
  'mongodb-client-encryption',
  '@mongodb-js/zstd',
  '@aws-sdk/credential-providers',
  // Optional native speedups of ssh2, also loaded inside try/catch.
  'cpu-features',
  '*.node',
];

const monaco = 'node_modules/monaco-editor/esm/vs';

/** Copies the app's static files beside its bundles, again after each rebuild. */
const copyStatic = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(() => {
      fs.mkdirSync('dist/app', { recursive: true });
      for (const file of ['shell.html', 'webview-default.css']) fs.copyFileSync(path.join('src/standalone/shell', file), path.join('dist/app', file));
    });
  },
};

const appContexts = () => [
  // The main process: the extension's code, with the vscode module replaced by the app's.
  esbuild.context({
    ...common,
    entryPoints: ['src/standalone/main.ts'],
    outfile: 'dist/app/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    alias: { vscode: path.resolve('src/standalone/vscode/index.ts') },
    external: ['electron', ...optional],
    plugins: [copyStatic],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/standalone/preload.ts'],
    outfile: 'dist/app/preload.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  // The window, with the editor (Monaco) and its workers.
  esbuild.context({
    ...common,
    entryPoints: ['src/standalone/shell/main.ts'],
    outfile: 'dist/app/shell.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.ttf': 'file' },
    // Monaco and the codicons package each bring a codicon.ttf.
    assetNames: '[name]-[hash]',
  }),
  esbuild.context({
    ...common,
    entryPoints: {
      'editor.worker': monaco + '/editor/editor.worker.js',
      'json.worker': monaco + '/language/json/json.worker.js',
      'ts.worker': monaco + '/language/typescript/ts.worker.js',
    },
    outdir: 'dist/app',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
];

const contexts = await Promise.all([
  ...(app ? appContexts() : []),
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', ...optional],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/playground.ts'],
    outfile: 'dist/playground.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/monitor.ts'],
    outfile: 'dist/monitor.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/compare.ts'],
    outfile: 'dist/compare.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/users.ts'],
    outfile: 'dist/users.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/gridfs.ts'],
    outfile: 'dist/gridfs.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/undoHistory.ts'],
    outfile: 'dist/undoHistory.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/watch.ts'],
    outfile: 'dist/watch.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/search.ts'],
    outfile: 'dist/search.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/advisor.ts'],
    outfile: 'dist/advisor.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/diagram.ts'],
    outfile: 'dist/diagram.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/connectionEditor.ts'],
    outfile: 'dist/connectionEditor.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/chartjs.ts'],
    outfile: 'dist/chartjs.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
