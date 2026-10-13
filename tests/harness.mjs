// Charge app.js tel quel dans node:vm avec un DOM factice (aucune étape de build, aucune dépendance).
// Les fonctions et variables de haut niveau sont lues par t.get('nom') / écrites par t.set('nom', valeur).
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

export const APP = process.env.QA_APP || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const any = () => new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : any(),
  apply: () => any(), construct: () => any(), set: () => true,
});

export function loadApp({ data = true } = {}) {
  const store = new Map();
  const ctx = {
    console, URL, TextDecoder, Intl, setTimeout, clearTimeout, Promise,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: any(), navigator: any(), Audio: function () { return any(); }, fetch: () => Promise.reject(new Error('hors ligne')),
    innerWidth: 390, innerHeight: 844, getComputedStyle: () => ({ fontSize: '17px' }), addEventListener() {}, requestAnimationFrame: () => 0,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  const EPI = '\n;globalThis.__t = { get: k => eval(k), set: (k, v) => eval(k + " = v"), run: s => eval(s) };';
  vm.runInContext(fs.readFileSync(path.join(APP, 'app.js'), 'utf8') + EPI, ctx, { filename: 'app.js' });
  const t = ctx.__t;
  t.store = store;
  const fn = name => (...a) => t.get(name)(...a);
  for (const n of ['stripDid', 'sameQuote', 'titleCase', 'typo', 'highlight', 'searchHits', 'pool', 'stepQuote', 'nameCase', 'parseQuote', 'audioURL', 'videoURL',
                   'dailyQuestion', 'esc', 'fmtEp', 'loadFavorites', 'readJSON', 'writeJSON', 'isFav', 'toggleFav']) t[n] = fn(n);
  if (data) {
    const raw = JSON.parse(fs.readFileSync(path.join(APP, 'data.json'), 'utf8'));
    const all = raw.map((it, i) => t.parseQuote(it, i)).filter(q => q.quote && q.name && !q.hide);
    t.raw = raw; t.all = all;
    t.set('allQuotes', all);
    t.set('audioIdx', all.reduce((a, q, i) => (q.audio && a.push(i), a), []));
    t.set('videoIdx', all.reduce((a, q, i) => (q.video && a.push(i), a), []));
    t.set('renderCitations', () => {});
  }
  return t;
}
