// Bundles the functions and the shared package into lib/index.js so Firebase deploy
// does not need the monorepo workspace. firebase-admin / firebase-functions stay external.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./lib/index.js', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Heavy parsers stay external and are installed as function dependencies.
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*', 'pdfjs-dist', 'pdfjs-dist/*', 'exceljs'],
  alias: {
    '@asm/shared/pdf': fileURLToPath(new URL('../packages/shared/src/pdfText.ts', import.meta.url)),
    '@asm/shared/excel': fileURLToPath(new URL('../packages/shared/src/excelRead.ts', import.meta.url)),
    '@asm/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
  },
  logLevel: 'info',
});
