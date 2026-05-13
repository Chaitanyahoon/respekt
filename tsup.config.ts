import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library — dual ESM/CJS with declarations
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    external: ['zod', 'micromatch'],
    outDir: 'dist',
  },
  // CLI — ESM with shebang, commander bundled in
  {
    entry: ['src/cli/index.ts'],
    format: ['esm'],
    dts: false,
    sourcemap: false,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['zod', 'micromatch'],
    outDir: 'dist/cli',
    noExternal: ['commander'],
  },
]);
