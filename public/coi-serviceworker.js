// Cross-origin isolation where the host cannot set headers (GitHub Pages): this service worker adds COOP/COEP to every
// response of the site, so the page becomes crossOriginIsolated and the physics can share memory with its helper threads
// (SharedArrayBuffer, src/core/threads.ts). The same idea as gzuidhof/coi-serviceworker, written here in a few lines.
// Registered by src/isolation.ts; on hosts that send the headers themselves (the dev server, vite preview) it is not used.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const request = event.request
  // A Chrome quirk: such requests fail when a service worker answers them.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  event.respondWith(fetch(request).then(response => {
    // Opaque cross-origin responses (status 0) cannot be rebuilt; the browser handles them as before.
    if (response.status === 0) return response
    const headers = new Headers(response.headers)
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }))
})
