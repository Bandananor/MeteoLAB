// Runs before the app (index.html loads it first): if the page is not cross-origin isolated (a host without COOP/COEP
// headers, such as GitHub Pages), registers public/coi-serviceworker.js, which adds them, and reloads once it controls
// the page. Without a service worker (an old browser, a private window that blocks it) the app still runs, with the
// physics on one thread. A flag in sessionStorage stops a reload loop if isolation does not take hold.
const RELOADED = 'meteolab-isolation-reload'

if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-serviceworker.js`).then(registration => {
    const reload = () => { if (sessionStorage.getItem(RELOADED)) return; sessionStorage.setItem(RELOADED, '1'); location.reload() }
    if (registration.active && !navigator.serviceWorker.controller) reload()
    navigator.serviceWorker.addEventListener('controllerchange', reload)
  }, error => console.warn('MeteoLab: no service worker, the physics runs on one thread', error))
} else if (window.crossOriginIsolated) sessionStorage.removeItem(RELOADED)
