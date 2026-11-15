// Builds the frontend into dist/frontend:
//
//   index.html                  references the assets below by absolute path
//   assets/app-<hash>.js        the web components, bundled with esbuild (+ .map)
//   assets/styles-<hash>.css
//
// The asset names carry a hash of their content, so a new release never
// overwrites a file an open page may still load: deploys cache the assets for
// a year and never delete old ones, and only index.html (and config.json) are
// replaced and uncached. See "Releases" in the README.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const src = fileURLToPath(new URL('../src/frontend/', import.meta.url));
const out = fileURLToPath(new URL('../dist/frontend/', import.meta.url));

await rm(out, { recursive: true, force: true });
await mkdir(`${out}assets`, { recursive: true });

const result = await build({
  entryPoints: { app: `${src}main.ts` },
  outdir: `${out}assets`,
  entryNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
});
const script = `/assets/${basename(Object.keys(result.metafile.outputs).find((file) => file.endsWith('.js'))!)}`;

const css = await readFile(`${src}styles.css`);
const styles = `styles-${createHash('sha256').update(css).digest('hex').slice(0, 8).toUpperCase()}.css`;
await writeFile(`${out}assets/${styles}`, css);

const html = (await readFile(`${src}index.html`, 'utf8'))
  .replace('href="styles.css"', `href="/assets/${styles}"`)
  .replace('src="app.js"', `src="${script}"`);
if (html.includes('"styles.css"') || html.includes('"app.js"')) throw new Error('index.html: asset reference not rewritten');
await writeFile(`${out}index.html`, html);
console.log(`  index.html -> ${script}, /assets/${styles}`);
