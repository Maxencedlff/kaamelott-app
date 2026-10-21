// Contrôle à l'entrée (Vercel Routing Middleware, avant le cache) : les répliques et les fonctions en ligne demandent le
// code d'accès (cookie posé par api/acces.js). La coquille de l'appli (page, scripts, sw.js, polices, icônes) reste
// libre : l'appli s'ouvre, demande le code, et un service worker ancien peut toujours se mettre à jour.
import { next } from '@vercel/functions';
import { autorise } from './api/_acces.js';

export const config = { matcher: ['/data.json', '/api/avis', '/api/extrait', '/api/qdj'] };

export default async function middleware(request) {
  if (await autorise(request.headers.get('cookie'), process.env)) return next();
  return new Response(JSON.stringify({ erreur: 'code d’accès requis' }), {
    status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
