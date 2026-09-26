const CACHE = 'xsayatrade-static-v8';
const CORE = ['/', '/index.html', '/styles.css', '/exchange.css', '/extra.css', '/backend-ui.css', '/i18n.css', '/app.js', '/i18n.js', '/manifest.webmanifest', '/icon.svg', '/xsayatrade-logo-192.png', '/xsayatrade-logo-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match('/index.html'))));
});
