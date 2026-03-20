const V = 'legible-v1';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Cache-first for our own shell; network-only for external (article fetches)
  if (url.origin === self.location.origin || url.hostname.includes('fonts.')) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(V).then(c => c.put(e.request, clone));
        return res;
      }))
    );
  }
});
