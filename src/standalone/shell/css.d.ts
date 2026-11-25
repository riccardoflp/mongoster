// The style sheets the window imports for esbuild to bundle: they export nothing, and TypeScript asks for a
// declaration of every module imported for its effect alone.
declare module '*.css';
