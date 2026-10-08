import { defineConfig } from 'vite'

// Cross-origin isolation, so the physics can share memory with its helper threads (SharedArrayBuffer; see
// src/core/threads.ts). Without these headers the page still works, with the physics on one thread.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  // The physics worker starts the helper workers itself: module workers inside a module worker.
  worker: { format: 'es' },
})
