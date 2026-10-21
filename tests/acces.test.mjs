// Tests du code d'accès (api/_acces.js partagé avec middleware.js, api/acces.js) : faux req/res, aucun réseau.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import path from 'node:path';
import { APP } from './harness.mjs';

const require = createRequire(import.meta.url);
const A = require(path.join(APP, 'api', '_acces.js'));
const handler = require(path.join(APP, 'api', 'acces.js'));
const ENV = { KAAM_ACCES_CODE: 'culdechouette', KAAM_ACCES_SECRET: 'secret-de-test' };
let ipN = 0;

async function call({ method = 'POST', origin = 'https://kaamelott-app.vercel.app', body = { code: 'culdechouette' }, ip, env = ENV } = {}) {
  for (const k of Object.keys(ENV)) if (env[k]) process.env[k] = env[k]; else delete process.env[k];
  const res = { code: 0, headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; },
    json(j) { this.body = j; return this; }, end() { return this; } };
  await handler({ method, body, headers: { origin, 'x-forwarded-for': ip || `10.2.0.${++ipN}` } }, res);
  return res;
}

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
test('POST : mauvais code 401, vide 401, autre origine 403, GET 405, non configuré 500', async () => {
  assert.equal((await call({ body: { code: 'perceval' } })).code, 401);
  assert.equal((await call({ body: {} })).code, 401);
  assert.equal((await call({ origin: 'https://ailleurs.example' })).code, 403);
  assert.equal((await call({ method: 'GET' })).code, 405);
  assert.equal((await call({ env: {} })).code, 500);
});
test('POST : 10 essais par heure et par adresse', async () => {
  let r;
  for (let n = 0; n < 11; n++) r = await call({ ip: '10.9.9.8', body: { code: 'faux' } });
  assert.equal(r.code, 429);
});
