const V = 'legible-v4';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V).then(c => {
      const base = self.registration.scope;
      return c.addAll([
        base, base + 'index.html', base + 'manifest.json',
        base + 'tts-engines.js', base + 'tts-kokoro.js', base + 'tts-piper.js'
      ]);
    }).then(() => self.skipWaiting())
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
  // Cache-first for our own shell + fonts + CDN libs; network-only for article fetches
  const cacheable = url.origin === self.location.origin
    || url.hostname.includes('fonts.')
    || url.hostname.includes('cdn.jsdelivr.net')
    || url.hostname.includes('esm.sh');
  if (cacheable) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(V).then(c => c.put(e.request, clone));
        return res;
      }))
    );
  }
});
