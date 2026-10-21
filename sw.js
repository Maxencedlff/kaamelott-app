const CACHE = 'kaamelott-v70';
const DATA_CACHE = 'kaamelott-data';
// Portraits des personnages (img/perso/, ~200 × 3 petits JPEG) : noms à empreinte, donc immuables. Cache à part, jamais
// vidé par une mise à jour ; servis depuis le cache dès la première vue, plafonné à IMG_MAX fichiers (les plus anciens sortent).
const IMG_CACHE = 'kaamelott-img';
const IMG_MAX = 700;   // jamais versionné : le vider forcerait 7 Mo de téléchargement à chaque mise à jour
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/compat.js',
  '/app.js',
  '/manifest.json',
  '/perso.json',
  '/fonts/inter-400.woff2',
  '/fonts/inter-500.woff2',
  '/fonts/inter-600.woff2',
  '/fonts/inter-700.woff2',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png'
];
const SHELL = new Set(ASSETS.filter(u => !u.startsWith('/fonts/') && u !== '/perso.json'));
// Au-delà de ce délai, la copie en cache est servie ; le réseau continue et met le cache à jour pour la fois suivante
const SHELL_WAIT = 2500;
// Après un dépassement, le réseau est jugé lent pendant 15 s : les fichiers suivants (app.js, style.css…) sortent aussitôt
// du cache, sans attendre chacun 2,5 s (le réseau les met à jour en arrière-plan)
let slowUntil = 0;

// Install : met les fichiers de l'app en cache (jamais une copie périmée du cache HTTP), prend le contrôle immédiatement.
// Les répliques (data.json, ~7 Mo) sont rangées dans DATA_CACHE par la page dès le premier téléchargement (app.js, loadData) :
// pas de second téléchargement au premier lancement.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// Activate : supprime les anciens caches, prend le contrôle des onglets.
// Le message « nouvelle version » n'est envoyé que s'il existait une version précédente (jamais au tout premier lancement).
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => {
        const old = keys.filter(k => k !== CACHE && k !== DATA_CACHE && k !== IMG_CACHE);
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

// GIF transparent de 1 px (portrait indisponible hors ligne) : ni erreur, ni image cassée
const BLANK = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
const blankImage = () => new Response(BLANK, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' } });
const isJSON = r => /json/.test(r.headers.get('content-type') || '');

// Copie en cache d'une requête ; une navigation (/, /?utm_source=…, /index.html) retombe toujours sur la page de l'app
function fromCache(req) {
  const nav = req.mode === 'navigate';
  return caches.match(req, { ignoreSearch: nav })
    .then(hit => hit || (nav ? caches.match('/index.html') : undefined));
}

// Réseau d'abord, mais jamais plus de SHELL_WAIT : au-delà, la copie en cache (le réseau la met à jour en arrière-plan).
// Pas de copie : on attend le réseau. Réponse refusée (403 anti-robot…) : la copie plutôt qu'une erreur.
function networkFirst(e) {
  const req = e.request;
  const net = fetch(req).then(r => {
    if (r.ok) { const c = r.clone(); e.waitUntil(caches.open(CACHE).then(k => k.put(req, c)).catch(() => {})); }
    return r;
  });
  e.waitUntil(net.then(() => {}, () => {}));
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const wait = Date.now() < slowUntil ? 0 : SHELL_WAIT;
    const timer = setTimeout(() => { slowUntil = Date.now() + 15000; fromCache(req).then(finish); }, wait);
    net.then(r => {
      clearTimeout(timer);
      if (r.ok) finish(r); else fromCache(req).then(hit => finish(hit || r));
    }, () => {
      clearTimeout(timer);
      fromCache(req).then(hit => finish(hit || Response.error()));
    });
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Envois (avis de vérification) : jamais mis en cache
  if (e.request.method !== 'GET') return;

  // Requêtes externes (sons et scènes sur Hugging Face) : laissées au navigateur (requêtes Range, URL signées)
  if (url.origin !== self.location.origin) return;

  // API (répliques déjà vérifiées par tous) : toujours le réseau, jamais le cache
  if (url.pathname.startsWith('/api/')) return;

  // Sons manuels : laissés au navigateur (requêtes Range / réponses 206 non stockables dans le cache)
  if (url.pathname.startsWith('/sons/')) return;

  // Polices : immuables, servies depuis le cache
  if (url.pathname.startsWith('/fonts/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) { const c = r.clone(); e.waitUntil(caches.open(CACHE).then(k => k.put(e.request, c))); }
      return r;
    })));
    return;
  }

  // Portraits : cache d'abord (immuables) ; sinon le réseau, rangé pour la fois suivante
  if (url.pathname.startsWith('/img/perso/')) {
    e.respondWith(caches.open(IMG_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) {
        const copy = r.clone();
        e.waitUntil(c.put(e.request, copy).then(() => c.keys()).then(keys => Promise.all(keys.slice(0, Math.max(0, keys.length - IMG_MAX)).map(k => c.delete(k)))).catch(() => {}));
      }
      return r;
    }, () => blankImage()))));   // hors ligne et pas encore en cache : image vide, l'initiale du personnage reste visible dessous
    return;
  }

  // Liste des portraits : la copie en cache tout de suite (jamais d'attente au lancement), mise à jour en arrière-plan
  if (url.pathname === '/perso.json') {
    e.respondWith(caches.open(CACHE).then(c => c.match('/perso.json').then(hit => {
      const net = fetch(e.request).then(r => { if (r.ok && isJSON(r)) return c.put('/perso.json', r.clone()).then(() => r, () => r); return r; });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net.catch(() => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    })));
    return;
  }

  // Répliques (data.json, ~7 Mo) : servies tout de suite depuis le cache, revalidées en arrière-plan (ETag : 304 si rien
  // n'a changé, sans rien réécrire) ; seule une vraie réponse JSON remplace la copie (jamais un portail Wi-Fi en HTML)
  if (url.pathname === '/data.json') {
    e.respondWith(caches.open(DATA_CACHE).then(async c => {
      const hit = await c.match('/data.json');
      const etag = hit && hit.headers.get('etag');
      const reseau = (etag ? fetch('/data.json', { cache: 'no-store', headers: { 'If-None-Match': etag } }) : fetch(e.request)).then(r => {
        if (r.status === 200 && isJSON(r)) return c.put('/data.json', r.clone()).then(() => r, () => r);
        // code d'accès refusé (middleware.js) : la copie en cache ne doit pas ouvrir l'app sans code ; la page recharge
        if (r.status === 401) return c.delete('/data.json').then(() => self.clients.matchAll()).then(cl => { cl.forEach(x => x.postMessage({ type: 'ACCES' })); return r; });
        return r;
      });
      if (hit) { e.waitUntil(reseau.catch(() => {})); return hit; }
      return reseau.then(r => r.ok ? r : c.match('/data.json').then(h => h || r)).catch(() => c.match('/data.json').then(h => h || Response.error()));
    }));
    return;
  }

  // Coquille de l'app (page, app.js, style.css, compat.js, manifeste, icônes) : servie TOUT DE SUITE depuis le cache de
  // cette version (jamais d'attente réseau : la page noire au K s'affiche aussitôt). Le jeu de fichiers est cohérent, car
  // rangé d'un bloc à l'installation ; une nouvelle version arrive par un nouveau sw.js (message SW_UPDATED, rechargement
  // à un moment neutre). Fichier absent du cache : réseau d'abord, limité dans le temps.
  if (e.request.mode === 'navigate' || SHELL.has(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })
      .then(hit => hit || (e.request.mode === 'navigate' ? c.match('/index.html') : undefined)))
      .then(hit => hit || networkFirst(e), () => networkFirst(e)));
    return;
  }
  e.respondWith(networkFirst(e));
});
