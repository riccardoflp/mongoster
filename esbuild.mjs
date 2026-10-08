import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    // Optional native/peer deps of the mongodb driver: loaded lazily inside try/catch.
    external: [
      'vscode',
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
    ],
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
    entryPoints: ['src/webview/watch.ts'],
    outfile: 'dist/watch.js',
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
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
