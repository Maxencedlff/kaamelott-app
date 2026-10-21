// Tests de api/avis.js avec de faux req/res : aucun réseau, aucun secret (fetch GitHub simulé).
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import path from 'node:path';
import { APP } from './harness.mjs';

const require = createRequire(import.meta.url);
const handler = require(path.join(APP, 'api', 'avis.js'));
const ORIGIN = 'https://kaamelott-app.vercel.app';
let ipN = 0;

// faux GitHub : avis/… rangés dans puts ; faits.json et coupes.json gardés dans store (sha qui change à chaque écriture,
// `conflits` premières écritures refusées en 409 comme lors de deux envois simultanés)
function call({ method = 'POST', origin = ORIGIN, type = 'application/json', body = {}, ip, token = 'factice', github = 201, faits = null, coupes = null, conflits = 0, gros = false } = {}) {
  const puts = [], n = { v: 0 };
  const store = { 'faits.json': { val: faits, sha: faits ? 's0' : null }, 'coupes.json': { val: coupes, sha: coupes ? 's0' : null },
    get faits() { return this['faits.json'].val; }, get coupes() { return this['coupes.json'].val; } };
  globalThis.fetch = async (url, opt = {}) => {
    if (github === 'down') throw new Error('réseau');
    const f = store[url.split('/').pop()];
    if (f && url.includes('/contents/') && !url.includes('/avis/')) {
      // gros : fichier de plus de 1 Mo, GitHub ne renvoie que le sha (encoding « none ») et le contenu brut à part
      if ((opt.method || 'GET') === 'GET') return !f.val ? { ok: false, status: 404 }
        : /raw/.test(opt.headers?.Accept || '') ? { ok: true, status: 200, text: async () => JSON.stringify(f.val) }
        : { ok: true, status: 200, json: async () => gros ? { sha: f.sha, encoding: 'none', content: '', size: 2e6 }
          : { sha: f.sha, encoding: 'base64', content: Buffer.from(JSON.stringify(f.val)).toString('base64') } };
      const b = JSON.parse(opt.body);
      if (conflits-- > 0 || (b.sha || null) !== f.sha) return { ok: false, status: 409 };
      f.val = JSON.parse(Buffer.from(b.content, 'base64').toString()); f.sha = `s${++n.v}`;
      return { ok: true, status: 200 };
    }
    puts.push({ url, body: JSON.parse(opt.body) }); return { ok: github < 300, status: github };
  };
  if (token) process.env.KAAM_AVIS_TOKEN = token; else delete process.env.KAAM_AVIS_TOKEN;
  const res = { code: 0, json: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } };
  const req = { method, headers: { origin, 'content-type': type, 'x-forwarded-for': ip || `10.0.0.${++ipN % 250}` }, body };
  return Promise.resolve(handler(req, res)).then(() => ({ res, puts, store, lot: puts[0] ? JSON.parse(Buffer.from(puts[0].body.content, 'base64').toString()) : null }));
}
const avis = (o = {}) => ({ i: 5, quote: 'Q', name: 'ARTHUR', ok: true, problemes: [], note: '', ts: 1700000000000, ...o });

test('méthode, origine, type', async () => {
  assert.equal((await call({ method: 'PUT' })).res.code, 405);
  assert.equal((await call({ origin: 'https://evil.example' })).res.code, 403);
  assert.equal((await call({ type: 'text/plain' })).res.code, 415);
  assert.equal((await call({ token: null, body: { avis: [avis()] } })).res.code, 500);
  assert.equal((await call({ body: { avis: [] } })).res.code, 400);
});
test('lot accepté et rangé', async () => {
  const { res, lot } = await call({ body: { avis: [avis(), avis({ i: 6, ok: false, problemes: ['son_faux', 'inconnu'] })] } });
  assert.equal(res.code, 200);
  assert.equal(lot.length, 2);
  assert.deepEqual(lot[1].problemes, ['son_faux']);
});
test('index hors bornes refusé', async () => {
  const { lot } = await call({ body: { avis: [avis({ i: -1 }), avis({ i: 1.5 }), avis({ i: '3' }), avis({ i: 7 })] } });
  assert.deepEqual(lot.map(a => a.i), [7]);
});
test('index au-delà de data.json refusé (< 40 000)', async () => {
  const { lot } = await call({ body: { avis: [avis({ i: 99999 }), avis({ i: 39999 })] } });
  assert.deepEqual(lot.map(a => a.i), [39999]);
});
test('horodatage : celui du serveur fait foi', async () => {
  const t0 = Date.now();
  const { lot } = await call({ body: { avis: [avis({ ts: 9e15 })] } });
  assert.ok(lot[0].ts >= t0 && lot[0].ts <= Date.now());
  assert.equal(lot[0].tc, 9e15);
});
test('caractères de contrôle retirés, lot plafonné à 100', async () => {
  const { lot } = await call({ body: { avis: Array.from({ length: 150 }, () => avis({ note: '\x1b[2Jhi\x07' })) } });
  assert.equal(lot.length, 100);
  assert.equal(lot[0].note, '[2Jhi');
});
test('GitHub injoignable : 502 maîtrisé', async () => {
  assert.equal((await call({ github: 'down', body: { avis: [avis()] } })).res.code, 502);
});
test('GET : déjà vérifiées par tous, en cache 1 min', async () => {
  const { res } = await call({ method: 'GET', origin: '', type: '', faits: { 5: 'abc' } });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { faits: { 5: 'abc' }, coupes: {}, demandes: {} });
  assert.match(res.headers['Cache-Control'], /s-maxage=60/);
  assert.deepEqual((await call({ method: 'GET' })).res.body, { faits: {}, coupes: {}, demandes: {} });          // pas encore de faits.json
  assert.equal((await call({ method: 'GET', github: 'down' })).res.code, 502);
});
test('POST : faits.json complété avec les empreintes valides seulement', async () => {
  const { res, store } = await call({ faits: { 1: 'old' }, body: { avis: [avis({ fp: 'k3x9' }), avis({ i: 6, fp: 'PAS<OK>' }), avis({ i: 1, fp: 'neuf' })] } });
  assert.equal(res.code, 200);
  assert.deepEqual(store.faits, { 1: 'neuf', 5: 'k3x9' });
});
test('POST : deux envois en même temps (409), relu puis réécrit', async () => {
  const { res, store } = await call({ conflits: 2, body: { avis: [avis({ fp: 'k3x9' })] } });
  assert.equal(res.code, 200);
  assert.deepEqual(store.faits, { 5: 'k3x9' });
});
test('POST : partage en panne, les avis restent acceptés', async () => {
  const { res, lot } = await call({ conflits: 99, body: { avis: [avis({ fp: 'k3x9' })] } });
  assert.equal(res.code, 200);
  assert.equal(lot.length, 1);
});
test('GET : coupes et demandes partagées', async () => {
  const { res } = await call({ method: 'GET', origin: '', type: '', coupes: { coupes: { 5: { fp: 'a', ds: -0.5, de: 0.2 } }, demandes: { 9: 1 } } });
  assert.deepEqual(res.body, { faits: {}, coupes: { 5: { fp: 'a', ds: -0.5, de: 0.2 } }, demandes: { 9: 1 } });
});
test('POST : coupe enregistrée (arrondie), vaut vérification ; la première fait foi', async () => {
  const { res, store, lot } = await call({ coupes: { coupes: { 7: { fp: 'z', ds: 0, de: 0 } }, demandes: {} },
    body: { avis: [avis({ fp: 'k3x9', coupe: [-0.4567, 1.2] }), avis({ i: 7, fp: 'k3', coupe: [1, 1] })] } });
  assert.equal(res.code, 200);
  assert.deepEqual(lot[0].coupe, [-0.46, 1.2]);
  assert.deepEqual(store.coupes.coupes, { 5: { fp: 'k3x9', ds: -0.46, de: 1.2 }, 7: { fp: 'z', ds: 0, de: 0 } });
  assert.equal(store.faits[5], 'k3x9');
});
test('POST : coupe invalide ignorée (hors marge, pas un nombre, sans empreinte)', async () => {
  const { store, lot } = await call({ body: { avis: [avis({ fp: 'a', coupe: [-4, 0] }), avis({ i: 6, fp: 'b', coupe: ['1', 0] }),
    avis({ i: 8, coupe: [0.5, 0] }), avis({ i: 9, fp: 'c', coupe: [0.5] })] } });
  assert.deepEqual(lot.map(a => a.coupe), [null, null, [0.5, 0], null]);
  assert.equal(store.coupes, null);                                            // rien de valable : fichier jamais écrit
});
test('POST : demande de recoupe enregistrée, ne vaut pas vérification ; bloque une nouvelle coupe', async () => {
  const { res, store } = await call({ body: { avis: [avis({ fp: 'k3x9', demande: 'recoupe', ok: false })] } });
  assert.equal(res.code, 200);
  assert.deepEqual(store.coupes, { coupes: {}, demandes: { 5: 1 } });
  assert.equal(store.faits, null);
  const r2 = await call({ coupes: { coupes: {}, demandes: { 5: 1 } }, body: { avis: [avis({ fp: 'k3x9', coupe: [0.1, 0] })] } });
  assert.deepEqual(r2.store.coupes.coupes, {});
});
test('POST : coupes en panne → 502 (le client réessaie)', async () => {
  const { res } = await call({ conflits: 99, body: { avis: [avis({ fp: 'k3x9', coupe: [0, 0.3] })] } });
  assert.equal(res.code, 502);
});
test('POST : coupe avec sa vidéo élargie → fenêtre gardée pour api/extrait.js ; cx invalide → coupe seule', async () => {
  const { store, lot } = await call({ body: { avis: [avis({ fp: 'k3x9', video: 'a1b2c3d4e5f6', vv: 2, cx: [3, 1.45, 3], coupe: [0.38, -0.09] }),
    avis({ i: 6, fp: 'b', video: 'a1b2c3d4e5f6', cx: [3, 999, 3], coupe: [0.1, 0] })] } });
  assert.deepEqual(lot[0].cx, [3, 1.45, 3]);
  assert.deepEqual(store.coupes.coupes[5], { fp: 'k3x9', ds: 0.38, de: -0.09, k: 'a1b2c3d4e5f6', vv: 2, w: [3.38, 4.36] });
  assert.deepEqual(store.coupes.coupes[6], { fp: 'b', ds: 0.1, de: 0 });
});
test('GET / POST : fichier de plus de 1 Mo lu en brut, jamais pris pour vide (rien d\'effacé)', async () => {
  const coupes = { coupes: { 9: { fp: 'z', ds: 0, de: 0, fini: 1 } }, demandes: {} };
  const { res, store } = await call({ gros: true, coupes, body: { avis: [avis({ fp: 'k3x9', coupe: [0.1, 0] })] } });
  assert.equal(res.code, 200);
  assert.deepEqual(Object.keys(store.coupes.coupes).sort(), ['5', '9']);
});
