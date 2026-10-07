const CACHE = 'kaamelott-v6';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/data.json',
  '/manifest.json',
  '/icon.svg'
];

// Install : met tous les assets en cache, prend le contrôle immédiatement
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate : supprime les anciens caches, prend le contrôle de tous les onglets
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Notifie tous les onglets qu'une nouvelle version est active
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

// Fetch : network-first pour HTML/JS/CSS/data (toujours à jour), cache fallback offline
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Ignorer les requêtes externes (Wikipedia images, etc.)
  if (url.origin !== self.location.origin) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Sons : laissés au navigateur (requêtes Range / réponses 206 non stockables dans le cache)
  if (url.pathname.startsWith('/sons/')) return;

  // Network-first : essaie le réseau, met à jour le cache, fallback sur cache si offline
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
