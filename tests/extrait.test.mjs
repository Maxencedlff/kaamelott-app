// Tests de api/extrait.js avec de faux req/res : aucun réseau (fetch simulé), aucun ffmpeg (couper remplacé).
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import path from 'node:path';
import { APP } from './harness.mjs';

const require = createRequire(import.meta.url);
const handler = require(path.join(APP, 'api', 'extrait.js'));
let ipN = 0;

async function call({ method = 'GET', query = { k: 'a1b2c3d4e5f6', v: '2', a: '3.38', b: '4.36' }, hf = 200, ip } = {}) {
  const vus = [], coupes = [];
  globalThis.fetch = async url => { vus.push(url); return { ok: hf < 300, status: hf, arrayBuffer: async () => new ArrayBuffer(8) }; };
  handler.couper = async (src, dst, d) => { coupes.push(d); await (await import('node:fs/promises')).writeFile(dst, 'mp4'); };
  const res = { code: 0, headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.body = b; return this; }, json(j) { this.body = j; return this; } };
  await handler({ method, query, headers: { 'x-forwarded-for': ip || `10.1.0.${++ipN}` } }, res);
  return { res, vus, coupes };
}

test('extrait : découpé dans la vidéo élargie de cette version, gardé en cache', async () => {
  const { res, vus, coupes } = await call();
  assert.equal(res.code, 200);
  assert.deepEqual(vus, ['https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/cx/a1/a1b2c3d4e5f6.mp4?v=2']);
  assert.deepEqual(coupes, [{ k: 'a1b2c3d4e5f6', v: 2, a: 3.38, b: 4.36 }]);
  assert.equal(res.headers['Content-Type'], 'video/mp4');
  assert.match(res.headers['Cache-Control'], /immutable/);
  assert.equal(String(res.body), 'mp4');
});
test('extrait : paramètres refusés (clé, version, fenêtre trop courte, trop loin, négative)', async () => {
  for (const q of [{ k: '../etc/passwd', a: '1', b: '2' }, { k: 'a1b2c3d4e5f6', v: '0', a: '1', b: '2' }, { k: 'a1b2c3d4e5f6', v: '1.5', a: '1', b: '2' },
    { k: 'a1b2c3d4e5f6', a: '1', b: '1.1' }, { k: 'a1b2c3d4e5f6', a: '1', b: '160' }, { k: 'a1b2c3d4e5f6', a: '-1', b: '2' }, { k: 'a1b2c3d4e5f6', a: 'x', b: '2' }]) {
    const { res, vus } = await call({ query: q });
    assert.equal(res.code, 400, JSON.stringify(q)); assert.equal(vus.length, 0);
  }
});
test('extrait : GET seulement ; vidéo élargie absente → 404 ; Hugging Face en panne → 502', async () => {
  assert.equal((await call({ method: 'POST' })).res.code, 405);
  assert.equal((await call({ hf: 404 })).res.code, 404);
  assert.equal((await call({ hf: 503 })).res.code, 502);
});
test('extrait : débit limité par adresse', async () => {
  let last;
  for (let n = 0; n < 61; n++) last = await call({ ip: '10.9.9.9' });
  assert.equal(last.res.code, 429);
});
