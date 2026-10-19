// Tests de api/avis.js avec de faux req/res : aucun réseau, aucun secret (fetch GitHub simulé).
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import path from 'node:path';
import { APP } from './harness.mjs';

const require = createRequire(import.meta.url);
const handler = require(path.join(APP, 'api', 'avis.js'));
const ORIGIN = 'https://kaamelott-app.vercel.app';
let ipN = 0;

// faux GitHub : avis/… rangés dans puts ; faits.json gardé dans `faits` (sha qui change à chaque écriture, `conflits`
// premières écritures refusées en 409 comme lors de deux envois simultanés)
function call({ method = 'POST', origin = ORIGIN, type = 'application/json', body = {}, ip, token = 'factice', github = 201, faits = null, conflits = 0 } = {}) {
  const puts = [], store = { faits, sha: faits ? 's0' : null, n: 0 };
  globalThis.fetch = async (url, opt = {}) => {
    if (github === 'down') throw new Error('réseau');
    if (url.endsWith('/faits.json')) {
      if ((opt.method || 'GET') === 'GET') return store.faits ? { ok: true, status: 200, json: async () => ({ sha: store.sha,
        content: Buffer.from(JSON.stringify(store.faits)).toString('base64') }) } : { ok: false, status: 404 };
      const b = JSON.parse(opt.body);
      if (conflits-- > 0 || (b.sha || null) !== store.sha) return { ok: false, status: 409 };
      store.faits = JSON.parse(Buffer.from(b.content, 'base64').toString()); store.sha = `s${++store.n}`;
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
  assert.deepEqual(res.body, { faits: { 5: 'abc' } });
  assert.match(res.headers['Cache-Control'], /s-maxage=60/);
  assert.deepEqual((await call({ method: 'GET' })).res.body, { faits: {} });          // pas encore de faits.json
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
