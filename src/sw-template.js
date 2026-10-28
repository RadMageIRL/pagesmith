// PageSmith service worker (generated at build time from src/sw-template.js).
// Precaches the complete app so it works offline, serves it cache-first, and keeps each version
// consistent: a new version waits until the page asks it to take over (after the user clicks
// Reload), so an editing session is never switched mid-way. Documents never pass through here:
// PDFs are read from local files, not fetched.
const VERSION = '__VERSION__';
const CACHE = `pagesmith-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', event => {
  // Keep the previous version's cache too: another tab may still be running it and lazily load a
  // chunk. Anything older is removed. caches.keys() lists caches in the order they were created.
  event.waitUntil(caches.keys().then(keys => {
    const ours = keys.filter(k => k.startsWith('pagesmith-'));
    const keep = new Set([CACHE, ...ours.filter(k => k !== CACHE).slice(-1)]);
    return Promise.all(keys.filter(k => k.startsWith('pagesmith-') && !keep.has(k)).map(k => caches.delete(k)));
  }).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // Every navigation gets the app shell, except the plain-text files the About dialog links to
    // (license and third-party notices), which open as themselves.
    const textFile = url.pathname.endsWith('.txt');
    event.respondWith(caches.open(CACHE).then(cache => cache.match(textFile ? request : './index.html', { ignoreSearch: true })).then(hit => hit || fetch(request)));
    return;
  }
  // ignoreVary: servers often send "Vary: Origin", and module scripts carry an Origin header the
  // precache requests didn't, which would otherwise make every cached script miss offline.
  event.respondWith(caches.match(request, { ignoreSearch: true, ignoreVary: true }).then(hit => hit || fetch(request)));
});
