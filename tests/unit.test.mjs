// Tests unitaires des fonctions pures d'app.js : node --test tests/
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

const t = loadApp();
const all = t.all;
const NNBSP = ' ', NBSP = ' ';

test('titleCase : casse de phrase, chiffres romains, personnages', () => {
  assert.equal(t.titleCase('AU BONHEUR DES DAMES'), 'Au bonheur des dames');
  assert.equal(t.titleCase('LE MONDE D’ARTHUR'), 'Le monde d’Arthur');
  assert.equal(t.titleCase('VOX POPULI III'), 'Vox populi III');
  assert.equal(t.titleCase('Guenièvre Et L’Orage'), 'Guenièvre et l’Orage');
});
test('titleCase : lieux et noms propres', () => {
  assert.equal(t.titleCase('LOTH ET LE GRAAL'), 'Loth et le Graal');
  assert.equal(t.titleCase('SÉFRIANE D’AQUITAINE'), 'Séfriane d’Aquitaine');
  assert.equal(t.titleCase('LE CAMP ROMAIN'), 'Le camp romain');
  assert.equal(t.titleCase('LES CLOUS DE LA SAINTE-CROIX'), 'Les clous de la Sainte-Croix');
});
test('typo : apostrophe, espaces fines, échappement', () => {
  assert.equal(t.typo("C'est pas faux !"), `C’est pas faux${NNBSP}!`);
  assert.equal(t.typo('Bon : on y va'), `Bon${NBSP}: on y va`);
  assert.equal(t.typo('Tom & Jerry ; ok'), `Tom &amp; Jerry${NNBSP}; ok`);
  assert.equal(t.typo('<b>'), '&lt;b&gt;');
  assert.equal(t.typo('Quoi?'), `Quoi${NNBSP}?`);
});
test('highlight : mots surlignés, jamais de HTML injecté', () => {
  const h = t.highlight("Le roi d'Arthur, c'est le Roi !", 'roi');
  assert.equal((h.match(/<mark>/g) || []).length, 2);
  assert.ok(!t.highlight('Le héroïsme', 'roi').includes('<mark>'));
  assert.ok(!t.highlight('<img src=x onerror=1> roi', 'roi').includes('<img'));
});
test('recherche : accents et ponctuation facultatifs', () => {
  assert.ok(t.searchHits('c est pas faux').text.length > 0);
  assert.equal(t.searchHits('perceval').text.length, t.searchHits('Pérceval').text.length);
  assert.deepEqual([...t.searchHits('arthur').who.map(w => w[0])], ['ARTHUR']);
  assert.equal(t.searchHits('  '), null);
});
test('recherche : coeur = cœur, soeur = sœur', () => {
  assert.ok(t.searchHits('cœur').text.length > 0);
  assert.equal(t.searchHits('coeur').text.length, t.searchHits('cœur').text.length);
  assert.equal(t.searchHits('soeur').text.length, t.searchHits('sœur').text.length);
});
test('highlight : ligatures', () => {
  assert.equal(t.highlight('Mon cœur bat', 'coeur'), 'Mon <mark>cœur</mark> bat');
  assert.equal(t.highlight('Mon cœur bat', 'cœur'), 'Mon <mark>cœur</mark> bat');
  assert.equal(t.highlight('Ma sœur, mon cœur !', 'soeur'), `Ma <mark>sœur</mark>, mon cœur${NNBSP}!`);
});
test('pool : chaque filtre est respecté', () => {
  const cases = [['film', 'videoOnly', q => q.film && q.video], ['serie', 'audioOnly', q => !q.film && q.audio], ['all', 'videoOnly', q => q.video]];
  for (const [src, flag, ok] of cases) {
    t.set('source', src); t.set('videoOnly', flag === 'videoOnly'); t.set('audioOnly', flag === 'audioOnly'); t.set('verifyMode', false);
    const P = t.pool();
    assert.ok(P && P.length > 0, `${src}/${flag} : pool vide`);
    assert.ok(P.every(i => ok(all[i])), `${src}/${flag} : réplique hors filtre`);
  }
  t.set('source', 'all'); t.set('videoOnly', false); t.set('audioOnly', false);
  assert.equal(t.pool(), null);
  t.set('verifyMode', true); t.set('verifyIdx', []);
  assert.equal(t.pool(), null, 'jamais de liste vide');
  t.set('verifyMode', false);
});
test('stepQuote : filtre et bouclage', () => {
  t.set('source', 'film');
  t.set('quoteIdx', 0); t.stepQuote(1); assert.ok(all[t.get('quoteIdx')].film);
  const Q = t.pool(); t.set('quoteIdx', Q.at(-1)); t.stepQuote(1); assert.equal(t.get('quoteIdx'), Q[0]);
  t.stepQuote(-1); assert.equal(t.get('quoteIdx'), Q.at(-1));
  t.set('source', 'all');
});
test('URL des médias', () => {
  assert.equal(t.audioURL('sons/auto/ab12.m4a?v=3'), 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/s/ab/ab12.m4a?v=3');
  assert.equal(t.audioURL('sons/bnt.mp3'), 'sons/bnt.mp3');
  assert.equal(t.videoURL({ video: 'cd34', vv: 2 }), 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/v/cd/cd34.mp4?v=2');
});
test('question du jour : déterministe, 4 choix dont la bonne réponse', () => {
  const a = t.dailyQuestion(), b = t.dailyQuestion();
  assert.equal(a.q.i, b.q.i); assert.equal(new Set(a.choices).size, 4); assert.ok(a.choices.includes(a.q.name));
});
test('parseQuote : index i stable, noms corrigés à la lecture', () => {
  all.slice(0, 2000).forEach(q => assert.equal(t.raw[q.i].quote, q.quote));
  assert.ok(!all.some(q => q.name === 'LÉODAGANR' || q.name === 'PÈRE BIAISE'));
});
test('esc : tous les caractères dangereux', () => {
  assert.equal(t.esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});
test('favoris : kaam_fav relu sans être réécrit', () => {
  const favs = [{ quote: all[5].quote, name: all[5].name, i: all[5].i }];
  t.store.set('kaam_fav', JSON.stringify(favs));
  t.loadFavorites();
  assert.ok(t.isFav(all[5]));
  assert.equal(t.store.get('kaam_fav'), JSON.stringify(favs));
});
