const CACHE = 'kaamelott-v24';
const DATA_CACHE = 'kaamelott-data';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== DATA_CACHE).map(k => caches.delete(k))))
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

  // Envois (avis de vérification) : jamais mis en cache
  if (e.request.method !== 'GET') return;

  // Requêtes externes (vidéos Hugging Face…) : laissées au navigateur (requêtes Range des lecteurs vidéo)
  if (url.origin !== self.location.origin) return;

  // Sons : laissés au navigateur (requêtes Range / réponses 206 non stockables dans le cache)
  if (url.pathname.startsWith('/sons/')) return;

  // Répliques (data.json, ~7 Mo) : servies tout de suite depuis le cache, mises à jour en arrière-plan
  // pour la prochaine ouverture (évite d'attendre le téléchargement à chaque lancement)
  if (url.pathname === '/data.json') {
    e.respondWith(caches.open(DATA_CACHE).then(async c => {
      const hit = await c.match('/data.json');
      const reseau = fetch(e.request).then(r => { if (r.ok) c.put('/data.json', r.clone()); return r; });
      if (hit) { e.waitUntil(reseau.catch(() => {})); return hit; }
      return reseau.catch(() => caches.match(e.request));
    }));
    return;
  }

  // Network-first : essaie le réseau, met à jour le cache, fallback sur cache si offline
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return response;
        }
        // réponse refusée (ex. page de contrôle anti-robot de Vercel, 403) : la dernière version en cache plutôt qu'une erreur
        return caches.match(e.request).then(hit => hit || response);
      })
      .catch(() => caches.match(e.request))
  );
});
