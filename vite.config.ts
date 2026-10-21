import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

// The model's version written into exports (src/version.ts): the release tag and the commits since it, or the commit
// alone where the tags are not fetched (a shallow CI checkout).
const version = (() => { try { return execSync('git describe --tags --always --dirty', { encoding: 'utf8' }).trim() } catch { return 'unknown' } })()

// Hosts that cannot send these headers (GitHub Pages) get them from public/coi-serviceworker.js (src/isolation.ts).
// Cross-origin isolation, so the physics can share memory with its helper threads (SharedArrayBuffer; see
// src/core/threads.ts). Without these headers the page still works, with the physics on one thread.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

const PAGES = ['', 'simulator/', 'guide/', 'guide/meteo/', 'guide/start/', 'guide/recipes/', 'about/']

export default defineConfig({
  // The site's path: '/' locally, '/MeteoLAB/' on GitHub Pages (BASE_PATH, set by .github/workflows/pages.yml).
  base: process.env.BASE_PATH ?? '/',
  define: { __MODEL_VERSION__: JSON.stringify(version) },
  server: { headers: isolation },
  preview: { headers: isolation },
  // The physics worker starts the helper workers itself: module workers inside a module worker.
  worker: { format: 'es' },
  // The pages: the home page, the simulator, the guides (the interface, meteorology from zero, first steps, recipes)
  // and the article about the model — in Russian at the root and in English under en/ (src/i18n.ts).
  build: { rolldownOptions: { input: Object.fromEntries(['', 'en/'].flatMap(lang => PAGES.map(page => [`${lang}${page || 'index'}`.replace(/\/$/, ''), `${lang}${page}index.html`]))) } },
})
