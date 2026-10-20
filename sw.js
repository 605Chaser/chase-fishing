// Offline support: keeps the app itself available with no signal.
// Weather data is cached by the app (last forecast per spot), so this only handles the app shell.
const CACHE = 'fishing-v2';
const SHELL = [
  './', './index.html', './core.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png',
  'https://cdn.jsdelivr.net/npm/suncalc@1.9.0/suncalc.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css'
];
const SHELL_HOSTS = [self.location.host, 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!SHELL_HOSTS.includes(url.host)) return; // live data and map tiles go straight to the network
  // The app's own files: network first so updates show right away, cache when offline.
  if (url.host === self.location.host) {
    e.respondWith(caches.open(CACHE).then(cache => fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => cache.match(req).then(hit => hit || cache.match('./index.html')))));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req);
    const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
