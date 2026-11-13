// Builds the frontend into dist/frontend: bundles the TypeScript web components
// with esbuild and copies the static files.
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const src = fileURLToPath(new URL('../src/frontend/', import.meta.url));
const out = fileURLToPath(new URL('../dist/frontend/', import.meta.url));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [`${src}main.ts`],
  outfile: `${out}app.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});
for (const file of ['index.html', 'styles.css']) await cp(`${src}${file}`, `${out}${file}`);
