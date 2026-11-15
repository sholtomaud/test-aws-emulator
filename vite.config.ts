// Vite builds the frontend (src/frontend, a Boba app) into dist/frontend:
//
//   index.html             references the assets below by absolute path
//   assets/<name>-<hash>   the entry script, the lazily loaded page components
//                          and the stylesheet (+ source maps)
//
// The asset names carry a hash of their content, so a new release never
// overwrites a file an open page may still load: deploys cache the assets for
// a year and never delete old ones, and only index.html (and config.json) are
// replaced and uncached. See "Releases" in the README.
import { defineConfig } from 'vite';

// `npm run dev` serves the working tree with hot reload and takes the backend
// from the local gateway (`make serve`), which fronts the emulator.
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  root: 'src/frontend',
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
    sourcemap: true,
    // The entry awaits config.json at the top level.
    target: 'es2022',
  },
  server: {
    proxy: { '/api': gateway, '/cognito': gateway, '/config.json': gateway },
  },
});
