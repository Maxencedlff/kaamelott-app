// Tests du code d'accès (api/_acces.js partagé avec middleware.js, api/acces.js) : faux req/res, aucun réseau.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import path from 'node:path';
import { APP } from './harness.mjs';

const require = createRequire(import.meta.url);
const A = require(path.join(APP, 'api', '_acces.js'));
const handler = require(path.join(APP, 'api', 'acces.js'));
const ENV = { KAAM_ACCES_CODE: 'culdechouette', KAAM_ACCES_SECRET: 'secret-de-test', KAAM_CREATION_CODE: 'codecreation' };
let ipN = 0;

// faux GitHub (dépôt des avis) : fichiers en mémoire, sha qui change à chaque écriture
const depot = new Map();
globalThis.fetch = async (url, opt = {}) => {
  const f = decodeURIComponent(url.split('/contents/')[1] || '');
  const e = depot.get(f);
  if ((opt.method || 'GET') === 'GET') return e ? { ok: true, status: 200, json: async () => ({ sha: e.sha, encoding: 'base64', content: Buffer.from(JSON.stringify(e.val)).toString('base64') }) } : { ok: false, status: 404 };
  const b = JSON.parse(opt.body);
  if ((b.sha || null) !== (e ? e.sha : null)) return { ok: false, status: 409 };
  depot.set(f, { val: JSON.parse(Buffer.from(b.content, 'base64').toString()), sha: `s${Math.random()}` });
  return { ok: true, status: 200 };
};
async function call({ method = 'POST', origin = 'https://kaamelott-app.vercel.app', body = { code: 'culdechouette' }, ip, env = ENV, cookie = '', h = handler, query } = {}) {
  for (const k of Object.keys(ENV)) if (env[k]) process.env[k] = env[k]; else delete process.env[k];
  process.env.KAAM_AVIS_TOKEN = 'factice';
  const res = { code: 0, headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; },
    json(j) { this.body = j; return this; }, end() { return this; } };
  await h({ method, body, query, headers: { origin, cookie, 'x-forwarded-for': ip || `10.2.0.${++ipN}` } }, res);
  return res;
}
const cookies = r => [].concat(r.headers['Set-Cookie'] || []).map(c => c.split(';')[0]).join('; ');

test('normalise : casse, accents, espaces et tirets ignorés', () => {
  assert.equal(A.normalise(' Cul-de-Chouette '), 'culdechouette');
  assert.equal(A.normalise('CUL DE CHOUÉTTE'), 'culdechouette');
  assert.equal(A.normalise(null), '');
});
test('autorise : cookie du bon code accepté ; absent, faux, ancien code refusés ; non configuré → ouvert', async () => {
  const j = await A.jeton('culdechouette', ENV.KAAM_ACCES_SECRET);
  assert.equal(j.length, 64);
  assert.equal(await A.autorise(`a=1; kaam_acces=${j}; b=2`, ENV), true);
  assert.equal(await A.autorise('', ENV), false);
  assert.equal(await A.autorise(`kaam_acces=${'0'.repeat(64)}`, ENV), false);
  assert.equal(await A.autorise(`kaam_acces=${await A.jeton('ancien', ENV.KAAM_ACCES_SECRET)}`, ENV), false);
  assert.equal(await A.autorise('', {}), true);
});
test('POST bon code (saisie tolérante) → cookie HttpOnly Secure de 400 jours, égal au jeton attendu', async () => {
  const r = await call({ body: { code: 'Cul-de-Chouette' } });
  assert.equal(r.code, 204);
  const c = r.headers['Set-Cookie'];
  assert.match(c, /^kaam_acces=[0-9a-f]{64}; Path=\/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(await A.autorise(c.split(';')[0], ENV), true);
});
test('POST : mauvais code 401, vide 401, autre origine 403, PUT 405, non configuré 500', async () => {
  assert.equal((await call({ body: { code: 'perceval' } })).code, 401);
  assert.equal((await call({ body: {} })).code, 401);
  assert.equal((await call({ origin: 'https://ailleurs.example' })).code, 403);
  assert.equal((await call({ method: 'PUT' })).code, 405);
  assert.equal((await call({ env: {} })).code, 500);
});
test('POST : 10 essais par heure et par adresse', async () => {
  let r;
  for (let n = 0; n < 11; n++) r = await call({ ip: '10.9.9.8', body: { code: 'faux' } });
  assert.equal(r.code, 429);
});

test('comptes : liste des 4, prénom pris grisé pour les autres, gardé par son téléphone ; inconnu refusé', async () => {
  depot.clear();
  let r = await call({ method: 'GET' });
  assert.deepEqual(r.body.comptes.map(c => c.nom), ['Anselme', 'Maxence', 'Timothée', 'Wandrille']);
  assert.ok(r.body.comptes.every(c => !c.pris)); assert.equal(r.body.moi, null);
  const a = await call({ body: { code: 'Cul-de-Chouette', compte: 'timothee' } });
  assert.equal(a.code, 200); assert.equal(a.body.compte, 'Timothée');
  const ck = cookies(a);
  assert.match(ck, /kaam_acces=[0-9a-f]{64}; kaam_compte=timothee\.[0-9a-f]{64}/);
  r = await call({ method: 'GET' });                                       // un autre téléphone : Timothée grisé
  assert.deepEqual(r.body.comptes.filter(c => c.pris).map(c => c.nom), ['Timothée']);
  r = await call({ method: 'GET', cookie: ck });                           // le sien : pas grisé, reconnu
  assert.equal(r.body.moi, 'Timothée'); assert.ok(r.body.comptes.every(c => !c.pris));
  assert.equal((await call({ body: { code: 'culdechouette', compte: 'Timothée' } })).code, 409);   // pris par un autre
  assert.equal((await call({ body: { code: 'culdechouette', compte: 'Timothée' }, cookie: ck })).code, 200);   // le même
  assert.equal((await call({ body: { code: 'culdechouette', compte: 'Perceval' } })).code, 400);
  assert.equal((await call({ body: { code: 'faux', compte: 'Anselme' } })).code, 401);
});
test('comptes : un cookie de compte fabriqué sans le secret est ignoré', async () => {
  const faux = `kaam_compte=anselme.${'0'.repeat(64)}`;
  assert.equal(await A.compteDe(faux, ENV), null);
  assert.equal(await A.compteDe(`kaam_compte=anselme.${await A.jetonCompte('anselme', ENV.KAAM_ACCES_SECRET)}`, ENV), 'Anselme');
});
test('prénom de profil : lettres, accents, tiret, apostrophe ; 2 à 20 lettres ; rien d’autre', () => {
  assert.equal(A.prenomValide('  Jean-Éric  '), 'Jean-Éric');
  assert.equal(A.prenomValide('Bohort’ de Gaunes'), "Bohort' de Gaunes");
  for (const x of ['', 'A', '<b>Léo</b>', 'Léo2', 'x'.repeat(21), '-Léo', null]) assert.equal(A.prenomValide(x), null, x);
});
test('nouveau profil : code de création (pas le code d’accès), prénom libre, entre aussitôt ; listé ensuite et pris', async () => {
  depot.clear();
  const mk = (code, creation, cookie) => call({ body: { code, creation }, cookie });
  assert.equal((await mk('culdechouette', 'Léodagan')).code, 401);          // le code d'accès ne crée rien
  assert.equal((await mk('faux', 'Léodagan')).code, 401);
  assert.equal((await mk('Code-Création', 'Léo2')).code, 400);
  assert.equal((await mk('codecreation', 'maxence')).code, 409);            // un des 4 premiers
  const a = await mk('codecreation', ' Léodagan ');
  assert.equal(a.code, 200); assert.equal(a.body.compte, 'Léodagan');
  const ck = cookies(a);
  assert.match(ck, /kaam_acces=[0-9a-f]{64}; kaam_compte=leodagan\.[0-9a-f]{64}/);
  assert.equal(await A.autorise(ck, ENV), true);                            // accès aux répliques aussi
  assert.equal(depot.get('comptes.json').val.leodagan.nom, 'Léodagan');
  assert.equal((await mk('codecreation', 'LEODAGAN')).code, 409);           // même prénom une fois normalisé
  let r = await call({ method: 'GET' });
  assert.deepEqual(r.body.comptes.map(c => c.nom), ['Anselme', 'Maxence', 'Timothée', 'Wandrille', 'Léodagan']);
  assert.deepEqual(r.body.comptes.filter(c => c.pris).map(c => c.nom), ['Léodagan']);
  r = await call({ method: 'GET', cookie: ck });
  assert.equal(r.body.moi, 'Léodagan');
  assert.equal((await call({ body: { code: 'culdechouette', compte: 'Léodagan' } })).code, 409);              // autre téléphone
  assert.equal((await call({ body: { code: 'culdechouette', compte: 'Léodagan' }, cookie: ck })).code, 200);   // le sien
  delete depot.get('comptes.json').val.leodagan;                            // retiré à la main : plus reconnu
  assert.equal((await call({ method: 'GET', cookie: ck })).body.moi, null);
});
test('nouveau profil : non configuré → 500 ; 50 profils au plus', async () => {
  depot.clear();
  assert.equal((await call({ body: { code: 'codecreation', creation: 'Léo' }, env: { ...ENV, KAAM_CREATION_CODE: '' } })).code, 500);
  const plein = {};
  for (let n = 0; n < 50; n++) plein[`p${'abcdefghij'[n % 10]}${'abcdefghij'[Math.floor(n / 10)]}`] = { pris: n, nom: 'x' };
  depot.set('comptes.json', { val: plein, sha: 's0' });
  assert.equal((await call({ body: { code: 'codecreation', creation: 'Léo' } })).code, 403);
});
test('question du jour : une réponse par compte et par jour ; résultats sans la réponse choisie ; compte exigé', async () => {
  depot.clear();
  const qdj = require(path.join(APP, 'api', 'qdj.js'));
  const d = new Date().toISOString().slice(0, 10);
  const ck = id => `kaam_compte=${id}.${'x'}`;
  const vrai = async id => `kaam_compte=${id}.${await A.jetonCompte(id, ENV.KAAM_ACCES_SECRET)}`;
  assert.equal((await call({ h: qdj, body: { d, i: 3, pick: 'ARTHUR', ok: true }, cookie: ck('maxence') })).code, 401);
  let r = await call({ h: qdj, body: { d, i: 3, pick: 'ARTHUR', ok: true }, cookie: await vrai('maxence') });
  assert.equal(r.code, 200); assert.deepEqual(r.body.resultats, { Maxence: { ok: true } });
  r = await call({ h: qdj, body: { d, i: 3, pick: 'PERCEVAL', ok: false }, cookie: await vrai('maxence') });
  assert.equal(r.code, 409); assert.deepEqual(r.body.resultats, { Maxence: { ok: true } });   // la première fait foi
  await call({ h: qdj, body: { d, i: 3, pick: 'KARADOC', ok: false }, cookie: await vrai('wandrille') });
  r = await call({ h: qdj, method: 'GET', query: { d } });
  assert.deepEqual(r.body.resultats, { Maxence: { ok: true }, Wandrille: { ok: false } });
  assert.deepEqual(r.body.comptes, ['Anselme', 'Maxence', 'Timothée', 'Wandrille']);
  assert.equal(JSON.stringify(r.body).includes('KARADOC'), false);                              // jamais la réponse
  assert.equal((await call({ h: qdj, method: 'GET', query: { d: '2001-01-01' } })).code, 400);
  depot.set('comptes.json', { val: { leodagan: { pris: 1, nom: 'Léodagan' } }, sha: 's1' });   // profil créé : répond aussi
  r = await call({ h: qdj, body: { d, i: 3, pick: 'ARTHUR', ok: true }, cookie: await vrai('leodagan') });
  assert.equal(r.code, 200); assert.equal(r.body.resultats['Léodagan'].ok, true);
  assert.deepEqual(r.body.comptes, ['Anselme', 'Maxence', 'Timothée', 'Wandrille', 'Léodagan']);
});
