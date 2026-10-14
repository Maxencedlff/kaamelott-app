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
const PARTS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'film', 'in1', 'in2', 'in3', 'dies', 'pil'];
const PARTS_V1 = PARTS.slice(0, 10);   // avant l'ajout des pilotes et de Dies Iræ (14/10/2026)
const setSel = v => { t.set('sel', v); t.get('poolCache').clear(); t.set('quizSel', null); };
const setMedia = m => { t.set('media', m); t.set('videoOnly', m === 'video'); t.set('audioOnly', m === 'audio'); t.get('poolCache').clear(); };
test('pool : sélection et affichage respectés, [] si rien', () => {
  t.set('verifyMode', false);
  const cases = [[['film'], 'video'], [PARTS.filter(p => p !== 'film'), 'audio'], [['L4'], 'text'], [PARTS, 'video']];
  for (const [s, m] of cases) {
    setSel(s); setMedia(m);
    const P = t.pool();
    assert.ok(P && P.length > 0, `${s}/${m} : pool vide`);
    assert.ok(P.every(i => s.includes(all[i].part) && (m !== 'video' || all[i].video) && (m !== 'audio' || all[i].audio)), `${s}/${m} : réplique hors filtre`);
  }
  setSel(PARTS); setMedia('text'); assert.equal(t.pool(), null);
  setSel([]); assert.deepEqual([...t.pool()], []);
  setSel(['in3']); setMedia('video'); assert.deepEqual([...t.pool()], []); assert.ok(t.get('poolEmpty')());
  t.set('verifyMode', true); t.set('verifyIdx', []); setSel([]);
  assert.notDeepEqual(t.pool(), [], 'vérification : jamais de liste vide');
  t.set('verifyMode', false); setSel(PARTS); setMedia('text');
});
test('stepQuote : sélection et bouclage', () => {
  setSel(['film']);
  t.set('quoteIdx', 0); t.stepQuote(1); assert.ok(all[t.get('quoteIdx')].film);
  const Q = t.pool(); t.set('quoteIdx', Q.at(-1)); t.stepQuote(1); assert.equal(t.get('quoteIdx'), Q[0]);
  t.stepQuote(-1); assert.equal(t.get('quoteIdx'), Q.at(-1));
  setSel(PARTS);
});
test('scopeLabel : résumé de la sélection', () => {
  const L = s => t.get('scopeLabel')(s);
  assert.equal(L(PARTS), 'Tout Kaamelott');
  assert.equal(L(['L1', 'L2', 'film']), 'Livres I et II · Film');
  assert.equal(L(['L1', 'L2', 'L3']), 'Livres I à III');
  assert.equal(L(['L1', 'L3', 'L5']), 'Livres I, III et V');
  assert.equal(L(['L1', 'L2', 'L4', 'L5', 'L6']), 'Livres I, II et IV à VI');
  assert.equal(L(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']), 'Toute la série');
  assert.equal(L(PARTS.filter(p => p !== 'film')), 'Toute la série · Inédits · Dies Iræ · Pilotes');
  assert.equal(L(PARTS_V1.filter(p => p !== 'film')), 'Toute la série · Inédits');
  assert.equal(L(['L1', 'pil']), 'Livre I · Pilotes');
  assert.equal(L(['in1', 'in2']), 'Inédits 1 et 2');
  assert.equal(L(['L6', 'film', 'in3']), 'Livre VI · Film · Inédit 3');
  assert.equal(L([]), 'Aucune sélection');
});
test('parties : chaque réplique en a une, compteurs cohérents', () => {
  assert.ok(all.every(q => PARTS.includes(q.part)), 'réplique sans partie');
  const c = t.get('partCounts')();
  const sum = k => PARTS.reduce((n, id) => n + c[id][k], 0);
  assert.equal(sum('t'), all.length);
  assert.equal(sum('v'), all.filter(q => q.video).length);
  assert.equal(c.in3.v, 0);
});
test('migration kaam_source / kaam_video_only / kaam_audio_only → kaam_sel / kaam_media, sans écriture', () => {
  const cases = [
    [{}, PARTS, 'video'],
    [{ kaam_source: 'film' }, ['film'], 'video'],
    [{ kaam_source: 'serie' }, PARTS.filter(p => p !== 'film'), 'video'],
    [{ kaam_video_only: '0', kaam_audio_only: '0' }, PARTS, 'text'],
    [{ kaam_audio_only: '1' }, PARTS, 'audio'],
    [{ kaam_media: 'text', kaam_video_only: '1' }, PARTS, 'text'],
    [{ kaam_sel: '["L9","L2"]' }, ['L2'], 'video'],
    [{ kaam_sel: 'pas du json', kaam_source: 'film' }, ['film'], 'video'],
    // sélection enregistrée avant les pilotes, tout coché : « Tout Kaamelott » le reste
    [{ kaam_sel: JSON.stringify(PARTS_V1) }, PARTS, 'video'],
    // choix fait depuis (kaam_sel_v2) : pilotes et Dies Iræ décochés, respecté
    [{ kaam_sel: JSON.stringify(PARTS_V1), kaam_sel_v2: '1' }, PARTS_V1, 'video'],
    [{ kaam_sel: '["L1","L2"]' }, ['L1', 'L2'], 'video'],
  ];
  for (const [ls, s, m] of cases) {
    t.store.clear(); for (const k in ls) t.store.set(k, ls[k]);
    const before = JSON.stringify([...t.store]);
    assert.deepEqual([...t.get('loadSel')()], s, JSON.stringify(ls));
    assert.equal(t.get('loadMedia')(), m, JSON.stringify(ls));
    assert.equal(JSON.stringify([...t.store]), before, 'écriture pendant la lecture');
  }
  t.store.clear();
});
test('quiz : suit la sélection, repli annoncé, question du jour inchangée', () => {
  setSel(['L4']);
  for (let k = 0; k < 30; k++) assert.equal(t.get('quizPick')().part, 'L4');
  assert.equal(t.get('quizSelPool')().fallback, false);
  setSel(['in3']);
  assert.equal(t.get('quizSelPool')().fallback, true);
  assert.ok(t.get('quizPick')());
  setSel(['L1']); const a = t.dailyQuestion(); setSel(PARTS); const b = t.dailyQuestion();
  assert.equal(a.q.i, b.q.i);
});
test('recherche : portée de la sélection', () => {
  const hits = t.searchHits('compote').text;
  setSel(['L2']);
  const inS = hits.filter(q => t.get('inSel')(q));
  assert.ok(inS.length > 0 && inS.length < hits.length, `${inS.length} / ${hits.length}`);
  assert.ok(inS.every(q => q.part === 'L2'));
  setSel(PARTS);
});
test('titre d’inédit en casse de titre : « Le Spectre d’Uther »', () => {
  const q = all.find(x => x.part === 'in2');
  assert.ok(q && /Le Spectre d['’]Uther$/.test(q.inedit), q && q.inedit);
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
  all.slice(0, 2000).forEach(q => assert.equal(t.stripDid(t.raw[q.i].quote), q.quote));
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

test('didascalies : jamais affichées, favoris anciens toujours reconnus', () => {
  assert.equal(t.stripDid('Sire ? (de nouveau) Sire !'), 'Sire ? Sire !');
  assert.equal(t.stripDid('Mais non. (il lui embrasse la main) Je gueule mais…'), 'Mais non. Je gueule mais…');
  assert.equal(t.stripDid('On a rien à dire (à la cantonade) quand on est con !'), 'On a rien à dire quand on est con !');
  assert.equal(t.stripDid('Sans didascalie.'), 'Sans didascalie.');
  assert.ok(!all.some(q => /\([^)]*\)/.test(q.quote)), 'une réplique affichée contient encore une didascalie');
  const avec = all.find(q => t.raw[q.i].quote.includes('('));
  assert.ok(t.sameQuote({ quote: t.raw[avec.i].quote, name: avec.name }, avec), 'favori enregistré avec didascalie non reconnu');
});
test('portraits : image si listée dans perso.json, sinon silhouette grise (jamais une couleur inventée)', () => {
  t.set('PERSO', { ARTHUR: 'arthur.0123abcd' });
  assert.equal(t.get('persoURL')('ARTHUR', 'p'), 'img/perso/arthur.0123abcd-p.jpg');
  assert.equal(t.get('persoURL')('PERCEVAL', 's'), null);
  const a = t.get('faceHTML')('ARTHUR', 's', 'av sq'), p = t.get('faceHTML')('LA DAME DU LAC');
  assert.ok(a.includes('class="av sq mono img"') && a.includes('src="img/perso/arthur.0123abcd-s.jpg"') && a.includes('#i-person'));
  assert.ok(!p.includes('<img') && p.includes('#i-person') && !p.includes('style='));
  t.set('PERSO', {});
});
test('aucun aplat de couleur arbitraire : ni palette, ni couleur par personnage ou par Livre', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  for (const k of ['const PAL', 'colorOf', 'LCOL', 'FIXED', '--c:']) assert.ok(!src.includes(k), `app.js contient encore ${k}`);
  assert.ok(!/var\(--c[,)]/.test(css), 'style.css utilise encore la couleur par personnage');
  assert.ok(!/#[0-9a-f]{6}/i.test(src.replace(/\/\/.*$/gm, '')), 'couleur codée en dur dans app.js');
});
test('inédits : « jamais tourné » seulement pour ceux qui n’ont pas été tournés', () => {
  const tourne = all.find(q => q.inedit && q.tourne), jamais = all.find(q => q.inedit && !q.tourne);
  if (tourne) assert.equal(t.fmtEp(tourne), tourne.inedit, 'inédit tourné affiché « Inédit N : Titre »');
  assert.ok(jamais && /· jamais tourné$/.test(t.fmtEp(jamais)), 'inédit jamais tourné sans sa mention');
  assert.ok(!all.some(q => q.inedit && !q.tourne && (q.audio || q.video)), 'inédit jamais tourné avec média');
});

test('pilotes et Dies Iræ : partie, source, transcription, interprète', () => {
  const p = t.parseQuote({ character: 'GUENIÈVRE, pilote, épisode 1: Le Duel', quote: 'Vous mangez pas ?', transcription: 1, acteur: 'Vanessa Guedj' }, 99001);
  assert.equal(p.part, 'pil'); assert.equal(p.episode, '1'); assert.equal(p.livre, '');
  assert.ok(p.tr); assert.equal(p.acteur, 'Vanessa Guedj');
  assert.equal(t.fmtEp(p), 'Pilote 1 : Le Duel');
  assert.match(t.get('epHTML')(p), /Transcription/);
  assert.equal(t.get('byLine')(p), 'Interprété par Vanessa Guedj');
  assert.equal(t.get('faceName')(p), '', 'photo de la série sur un autre interprète');
  assert.ok(!t.get('quizAccepts')(p), 'transcription dans le quiz');
  const d = t.parseQuote({ character: 'ARTHUR, Dies Iræ (court métrage, 2003)', quote: 'Bon.', transcription: 1 }, 99002);
  assert.equal(d.part, 'dies'); assert.equal(t.fmtEp(d), 'Dies Iræ · court métrage, 2003');
  assert.equal(t.get('byLine')(d), ''); assert.equal(t.get('faceName')(d), 'ARTHUR');
  // l'épisode 9 du Livre VI (même nom) reste au Livre VI
  const l6 = t.parseQuote({ character: 'ARTHUR, livre VI, épisode 9: Dies Irae', quote: 'Bon.' }, 99003);
  assert.equal(l6.part, 'L6'); assert.ok(!l6.tr);
  // réplique de la série : rien de changé
  const s1 = t.parseQuote({ character: 'PERCEVAL, livre I, tome 1, épisode 1: Heat', quote: 'C’est pas faux.' }, 99004);
  assert.equal(s1.part, 'L1'); assert.equal(t.get('epHTML')(s1).includes('Transcription'), false);
});
