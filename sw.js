// Service worker SONORA : met l'application en cache pour fonctionner sans Internet.
// Les musiques elles-mêmes sont dans IndexedDB (pas ici).
const VERSION = 'sonora-v1.4.3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/tags.js',
  './js/player.js',
  './js/store.js',
  './js/importer.js',
  './js/ui.js',
  './js/icons.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'sonora-shared').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Android : fichiers audio reçus via « Partager → SONORA ». On les garde le temps que l'app les importe.
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('audio').filter((f) => f && typeof f !== 'string');
    const cache = await caches.open('sonora-shared');
    let i = 0;
    for (const f of files) {
      await cache.put(
        new Request(`./shared/${Date.now()}-${i++}`),
        new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'musique.mp3') } }),
      );
    }
  } catch (err) {
    console.warn('partage', err);
  }
  return Response.redirect(new URL('./?shared=1#/library', self.registration.scope).href, 303);
}

// Cache d'abord (hors ligne), puis mise à jour en arrière-plan.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
