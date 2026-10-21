// Tests de api/extrait.js avec de faux req/res : aucun réseau (fetch GitHub et Hugging Face simulés), aucun ffmpeg (couper remplacé).
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import path from 'node:path';
import { APP } from './harness.mjs';

const require = createRequire(import.meta.url);
const handler = require(path.join(APP, 'api', 'extrait.js'));
let ipN = 0;
const COUPE = { fp: 'ab3', ds: 0.38, de: -0.09, k: 'a1b2c3d4e5f6', vv: 2, w: [3.38, 4.36] };

async function call({ method = 'GET', url = '/api/extrait?i=7&fp=ab3', coupes = { 7: COUPE }, hf = 200, taille = 5000, ip, token = 'factice' } = {}) {
  const hfVus = [], decoupes = [], gh = { n: 0 };
  globalThis.fetch = async (u) => {
    if (u.includes('api.github.com')) { gh.n++; return { ok: true, status: 200, json: async () => ({ sha: 's', encoding: 'base64', content: Buffer.from(JSON.stringify({ coupes, demandes: {} })).toString('base64') }) }; }
    hfVus.push(u); return { ok: hf < 300, status: hf, headers: { get: () => '1000' }, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  handler.couper = async (src, dst, w) => { decoupes.push(w); await (await import('node:fs/promises')).writeFile(dst, Buffer.alloc(taille)); };
  handler.oublie();
  if (token) process.env.KAAM_AVIS_TOKEN = token; else delete process.env.KAAM_AVIS_TOKEN;
  const res = { code: 0, headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.body = b; return this; }, json(j) { this.body = j; return this; } };
  await handler({ method, url, headers: { 'x-forwarded-for': ip || `10.1.0.${++ipN}` } }, res);
  return { res, hfVus, decoupes, gh };
}

test('extrait : coupe enregistrée découpée dans sa vidéo élargie, gardée en cache', async () => {
  const { res, hfVus, decoupes } = await call();
  assert.equal(res.code, 200);
  assert.deepEqual(hfVus, ['https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/cx/a1/a1b2c3d4e5f6.mp4?v=2']);
  assert.deepEqual(decoupes, [[3.38, 4.36]]);
  assert.equal(res.headers['Content-Type'], 'video/mp4');
  assert.match(res.headers['Cache-Control'], /immutable/);
});
test('extrait : adresse non canonique refusée (paramètre en plus, zéro devant, ordre, notation)', async () => {
  for (const url of ['/api/extrait?i=7&fp=ab3&x=1', '/api/extrait?i=07&fp=ab3', '/api/extrait?fp=ab3&i=7', '/api/extrait?i=7e0&fp=ab3',
    '/api/extrait?i=7&fp=AB3', '/api/extrait?i=7', '/api/extrait', '/api/extrait?k=a1b2c3d4e5f6&a=1&b=2']) {
    const { res, hfVus } = await call({ url });
    assert.equal(res.code, 400, url); assert.equal(hfVus.length, 0);
  }
});
test('extrait : rien à découper sans coupe en attente (absente, autre version, finie, sans fenêtre) → 404', async () => {
  for (const coupes of [{}, { 7: { ...COUPE, fp: 'zz' } }, { 7: { ...COUPE, fini: 1 } }, { 7: { fp: 'ab3', ds: 0, de: 0 } }, { 7: { ...COUPE, w: [3, 3.1] } }]) {
    const { res, hfVus } = await call({ coupes });
    assert.equal(res.code, 404, JSON.stringify(coupes)); assert.equal(hfVus.length, 0);
  }
});
test('extrait : fenêtre en centièmes entiers (0,2 s exactement acceptée)', () => {
  assert.equal(handler.fenetreValide([3.1, 3.3]), true);
  assert.equal(handler.fenetreValide([1, 1.2]), true);
  assert.equal(handler.fenetreValide([1, 1.19]), false);
  assert.equal(handler.fenetreValide([-0.1, 2]), false);
  assert.equal(handler.fenetreValide([1, 151]), false);
});
test('extrait : GET seulement ; jeton absent → 500 ; HF absent → 404, en panne → 502 ; découpe vide → 502 sans cache', async () => {
  assert.equal((await call({ method: 'POST' })).res.code, 405);
  assert.equal((await call({ token: null })).res.code, 500);
  assert.equal((await call({ hf: 404 })).res.code, 404);
  assert.equal((await call({ hf: 503 })).res.code, 502);
  const vide = await call({ taille: 261 });
  assert.equal(vide.res.code, 502); assert.equal(vide.res.headers['Cache-Control'], undefined);
});
test('extrait : débit limité par adresse', async () => {
  let last;
  for (let n = 0; n < 61; n++) last = await call({ ip: '10.9.9.9' });
  assert.equal(last.res.code, 429);
});
