import { defineConfig } from 'vite'

// Hosts that cannot send these headers (GitHub Pages) get them from public/coi-serviceworker.js (src/isolation.ts).
// Cross-origin isolation, so the physics can share memory with its helper threads (SharedArrayBuffer; see
// src/core/threads.ts). Without these headers the page still works, with the physics on one thread.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

export default defineConfig({
  // The site's path: '/' locally, '/MeteoLAB/' on GitHub Pages (BASE_PATH, set by .github/workflows/pages.yml).
  base: process.env.BASE_PATH ?? '/',
  server: { headers: isolation },
  preview: { headers: isolation },
  // The physics worker starts the helper workers itself: module workers inside a module worker.
  worker: { format: 'es' },
  // The pages: the home page, the simulator, the guides (the interface, meteorology from zero, first steps, recipes)
  // and the article about the model.
  build: { rolldownOptions: { input: { home: 'index.html', simulator: 'simulator/index.html', guide: 'guide/index.html', guideMeteo: 'guide/meteo/index.html', guideStart: 'guide/start/index.html', guideRecipes: 'guide/recipes/index.html', about: 'about/index.html' } } },
})
