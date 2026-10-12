const CACHE = 'kaamelott-v28';
const DATA_CACHE = 'kaamelott-data';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/fonts/archivo-var.woff2',
  '/fonts/ebgaramond-400.woff2',
  '/fonts/plexmono-400.woff2',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png'
];

// Install : met les fichiers de l'app en cache, prend le contrôle immédiatement.
// Les répliques (data.json, ~7 Mo) sont rangées dans DATA_CACHE par la page dès le premier téléchargement (app.js, loadData) :
// pas de second téléchargement au premier lancement.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate : supprime les anciens caches, prend le contrôle des onglets.
// Le message « nouvelle version » n'est envoyé que s'il existait une version précédente (jamais au tout premier lancement).
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => {
        const old = keys.filter(k => k !== CACHE && k !== DATA_CACHE);
        self.__wasUpdate = old.length > 0;
        return Promise.all(old.map(k => caches.delete(k)));
      })
      .then(() => self.clients.claim())
      .then(() => {
        if (!self.__wasUpdate) return;
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

// Fetch : network-first pour HTML/JS/CSS (toujours à jour), cache fallback offline
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Envois (avis de vérification) : jamais mis en cache
  if (e.request.method !== 'GET') return;

  // Requêtes externes (vidéos Hugging Face…) : laissées au navigateur (requêtes Range des lecteurs vidéo)
  if (url.origin !== self.location.origin) return;

  // Sons : laissés au navigateur (requêtes Range / réponses 206 non stockables dans le cache)
  if (url.pathname.startsWith('/sons/')) return;

  // Polices : immuables, servies depuis le cache
  if (url.pathname.startsWith('/fonts/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); }
      return r;
    })));
    return;
  }

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
