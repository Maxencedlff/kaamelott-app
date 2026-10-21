'use strict';
window.__kaamOK = 1;   // app.js s'exécute : compat.js n'affichera pas « appareil trop ancien »

// ===== ÉTAT =====
// Deux index à ne jamais confondre : q.i = index de la réplique dans data.json, immuable (les avis et les favoris
// le référencent) ; quoteIdx, randHistory, audioIdx… = positions dans allQuotes (répliques visibles, filtrées).
// Données
let allQuotes = [];       // répliques lues (parseQuote), sans les doublons masqués
let audioIdx = [];        // positions des répliques avec son
let videoIdx = [];        // positions des répliques avec scène
let favorites = [];       // favoris enregistrés (kaam_fav), tels qu'enregistrés
// Préférences
// Sélection : parties cochées (kaam_sel), dans l'ordre canonique ; [] possible (écran « Aucune sélection »).
// Affichage (kaam_media) : video (défaut de qui n'a jamais choisi), audio ou text.
// Les anciennes clés (kaam_source, kaam_video_only, kaam_audio_only) sont lues pour la migration, jamais réécrites ni effacées.
// Ajoutés le 14/10/2026 : 'dies' (court métrage Dies Iræ, 2003) et 'pil' (épisodes pilotes), répliques transcrites.
const PART_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'film', 'in1', 'in2', 'in3', 'dies', 'pil'];
const PART_IDS_V1 = PART_IDS.slice(0, 10);   // parties connues avant l'ajout des pilotes
const ROM = ['I', 'II', 'III', 'IV', 'V', 'VI'];
let sel = loadSel();
let media = loadMedia();
let videoOnly = media === 'video';   // mode vidéo : seulement les répliques avec scène, scène jouée dans la carte
let audioOnly = media === 'audio';   // n'afficher que les répliques avec son
let autoPlay  = readPref('kaam_autoplay');     // jouer le son dès qu'on tombe sur la réplique
let shareMode = ['extrait', 'texte', 'deux'].includes(readStr('kaam_share', '')) ? readStr('kaam_share', '') : 'extrait';   // Partager : extrait, texte ou les deux
let inOrder   = readPref('kaam_in_order');     // toucher / glisser : réplique suivante dans l'ordre au lieu d'aléatoire
let verifyMode = readPref('kaam_verify');      // ne montrer que les répliques avec son/vidéo pas encore vérifiées
// Navigation
let currentView = 'citations';
let quoteIdx = 0;         // réplique affichée (position dans allQuotes)
let randHistory = [];     // répliques vues en aléatoire (positions)
let randPos = -1;         // position courante dans randHistory
let nextRand = null;      // prochaine réplique aléatoire, tirée à l'avance pour être préchargée
let quizState = null;     // score du quiz libre (session)
// Vérification (avis son / vidéo envoyés à /api/avis)
let verifyIdx = [];                                 // positions encore à vérifier dans la sélection
let verifyTodo = { approx: 0, others: 0, texte: 0 };
let avisFaits = readJSON('kaam_avis_faits', {});   // q.i → 1 validée, 2 signalée (sur cet appareil)
let avisFile  = readJSON('kaam_avis_file', []);    // avis pas encore envoyés
let avisTous  = readJSON('kaam_avis_tous', {});    // q.i → empreinte : déjà vérifiées par quelqu'un, tous appareils (GET /api/avis)
// Coupes refaites dans l'appli (écran « Ajuster la coupe ») : celles de tous (GET /api/avis) et celles de ce téléphone pas
// encore vues dans la liste commune. q.i → { fp, ds, de [, fini] } (décalages du début et de la fin, en secondes).
let avisCoupes   = readJSON('kaam_avis_coupes', {});
let avisDemandes = readJSON('kaam_avis_demandes', {});   // q.i → 1 : « coupe ratée, la refaire », pas encore traitée
let mesCoupes    = readJSON('kaam_coupes', {});          // q.i → { fp, ds, de, ts } faites ici
let mesDemandes  = readJSON('kaam_demandes', {});        // q.i → { fp, ts } demandées ici
// Lecture
let playingBtn = null;    // bouton dont le son est en cours (chargement ou lecture)
let announceNext = false; // VoiceOver : annoncer la réplique au prochain rendu (pas au premier affichage)

// ===== MÉDIAS (sons et scènes hébergés sur Hugging Face) =====
const VIDEO_BASE = 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/v/';   // v/<2 premiers caractères>/<clé>.mp4
// Sons automatiques (sons/auto/<clé>.m4a) : hébergés sur Hugging Face, dans s/<2 premiers caractères>/ ;
// les quelques sons manuels (sons/*.mp3) restent sur le site
const AUDIO_BASE = 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/s/';
// Extrait refait (champs "v" pour le son, "vv" pour la vidéo, dans data.json) : ?v=<n> dans l'URL pour ne pas resservir l'ancienne version en cache
function audioURL(src) {
  const m = /^sons\/auto\/([^?]+\.m4a)(\?.*)?$/.exec(src || '');
  return m ? `${AUDIO_BASE}${m[1].slice(0, 2)}/${m[1]}${m[2] || ''}` : src;
}
function videoURL(q) { return q.video ? `${VIDEO_BASE}${q.video.slice(0, 2)}/${q.video}.mp4${q.vv ? `?v=${q.vv}` : ''}` : null; }
// Vidéo élargie (champ "cx" : [secondes avant, durée de l'extrait, secondes après]) : sert à refaire la coupe dans l'appli
const CX_BASE = VIDEO_BASE.replace(/v\/$/, 'cx/');
function cxURL(q) { return q.cx && q.video ? `${CX_BASE}${q.video.slice(0, 2)}/${q.video}.mp4?v=${q.vv || 1}` : null; }

// ===== COUPE EN ATTENTE : validée dans l'appli, pas encore refaite sur le serveur (≤ 1 h) =====
// La réplique joue alors la vidéo élargie, limitée à la fenêtre choisie (son compris) : partout, carte, scène, son.
const coupeDe = q => { const c = avisCoupes[q.i] || mesCoupes[q.i]; return c && c.fp === fpOf(q) ? c : null; };   // coupe de CETTE version
const demandeDe = q => !!(avisDemandes[q.i] || mesDemandes[q.i]);
const peutCouper = q => !!cxURL(q) && !coupeDe(q) && !demandeDe(q);
function fenetre(q) {
  const c = coupeDe(q);
  return c && !c.fini && cxURL(q) ? [q.cx[0] + c.ds, q.cx[0] + q.cx[1] + c.de] : null;
}
const winByURL = new Map();   // adresse de la vidéo élargie → fenêtre
const srcWin = new Map();     // source donnée au lecteur (adresse ou copie en mémoire) → fenêtre
// adresse à lire pour la scène : la vidéo élargie fenêtrée si une coupe attend, sinon l'extrait
function playURL(q) {
  const w = fenetre(q);
  if (!w) return videoURL(q);
  const u = cxURL(q); winByURL.set(u, w); return u;
}
const winOf = el => srcWin.get(el.currentSrc || el.src) || null;
// position et durée affichées : relatives à la fenêtre quand il y en a une
function span(el) {
  const w = winOf(el);
  return w ? [Math.max(0, Math.min(el.currentTime, w[1]) - w[0]), w[1] - w[0]] : [el.currentTime || 0, el.duration];
}
function seekStart(el) { el.currentTime = winOf(el)?.[0] || 0; }
// lecteur fenêtré : départ au début de la fenêtre, arrêt (et « fin ») à sa fin
function watchWin(el) {
  let raf = 0;
  const tick = () => {
    const w = winOf(el);
    if (!w || el.paused) return;
    if (el.currentTime >= w[1]) { el.pause(); el.dispatchEvent(new Event('ended')); return; }
    raf = requestAnimationFrame(tick);
  };
  const clamp = () => { const w = winOf(el); if (w && (el.currentTime < w[0] - 0.05 || el.currentTime >= w[1] - 0.02)) el.currentTime = w[0]; };
  el.addEventListener('loadedmetadata', clamp);
  el.addEventListener('play', clamp);
  el.addEventListener('playing', () => { cancelAnimationFrame(raf); tick(); });
}

// ===== SÉLECTION : Livres I à VI, film, inédits 1 à 3 (cases de la feuille « Sélection ») =====
function loadSel() {
  try {
    const raw = localStorage.getItem('kaam_sel');
    if (raw != null) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) {
        // sélection enregistrée avant l'arrivée des pilotes avec tout coché : « Tout Kaamelott » le reste
        // (kaam_sel_v2 est écrit avec la sélection : un choix fait depuis, pilotes décochés compris, est respecté)
        if (readStr('kaam_sel_v2', '') !== '1' && PART_IDS_V1.every(id => v.includes(id))) return PART_IDS.slice();
        return PART_IDS.filter(id => v.includes(id));
      }
    }
  } catch {}
  const old = readStr('kaam_source', 'all');            // migration : « Série » = tout sauf le film (inédits compris)
  return old === 'film' ? ['film'] : old === 'serie' ? PART_IDS.filter(id => id !== 'film') : PART_IDS.slice();
}
function loadMedia() {
  const m = readStr('kaam_media', '');
  if (m === 'video' || m === 'audio' || m === 'text') return m;
  let v = null, a = null;
  try { v = localStorage.getItem('kaam_video_only'); a = localStorage.getItem('kaam_audio_only'); } catch {}
  if (v === '1') return 'video';
  if (a === '1') return 'audio';
  if (v === '0' || a === '0') return 'text';            // Texte choisi explicitement : respecté
  return 'video';                                       // jamais choisi : Vidéo par défaut
}
// rien n'est écrit au chargement : la nouvelle clé ne l'est qu'au premier changement fait par l'utilisateur
function saveSel() { writeJSON('kaam_sel', sel); writeStr('kaam_sel_v2', '1'); }
function setMediaPref(m) { media = m; videoOnly = m === 'video'; audioOnly = m === 'audio'; writeStr('kaam_media', m); poolCache.clear(); }
// Partie d'une réplique (calculée une fois, dans parseQuote)
function partOf(c, inedit) {
  if (c.film) return 'film';
  if (c.dies) return 'dies';
  if (c.pil) return 'pil';
  if (inedit) { const m = /Inédit (\d)/.exec(c.inedTxt); return m ? 'in' + m[1] : null; }
  const k = ROM.indexOf(c.livre); return k >= 0 ? 'L' + (k + 1) : null;
}
const selAll = () => sel.length === PART_IDS.length;
const inSel = q => selAll() || sel.includes(q.part);
// Nombre de répliques par partie : t toutes, a avec son, v avec scène (calculé une fois par chargement des données)
let countsMemo = null;
function partCounts() {
  if (countsMemo && countsMemo.src === allQuotes) return countsMemo.c;
  const c = Object.fromEntries(PART_IDS.map(id => [id, { t: 0, a: 0, v: 0 }]));
  allQuotes.forEach(q => { const x = c[q.part]; if (x) { x.t++; if (q.audio) x.a++; if (q.video) x.v++; } });
  countsMemo = { src: allQuotes, c };
  return c;
}
const unitKey = () => videoOnly ? 'v' : audioOnly ? 'a' : 't';
function selCount(s = sel) { const c = partCounts(), k = unitKey(); return s.reduce((n, id) => n + c[id][k], 0); }
// Résumé de la sélection, en toutes lettres (« Livres I et II · Film », « Livres I à III », « Tout Kaamelott »)
function scopeLabel(s = sel) {
  const has = id => s.includes(id);
  if (PART_IDS.every(has)) return 'Tout Kaamelott';
  if (!s.length) return 'Aucune sélection';
  const books = [1, 2, 3, 4, 5, 6].filter(n => has('L' + n)), ined = [1, 2, 3].filter(n => has('in' + n)), out = [];
  if (books.length === 6) out.push('Toute la série');
  else if (books.length) {
    const runs = []; books.forEach(n => { const r = runs[runs.length - 1]; if (r && r[1] === n - 1) r[1] = n; else runs.push([n, n]); });
    const bits = runs.flatMap(([a, b]) => b - a >= 2 ? [`${ROM[a - 1]} à ${ROM[b - 1]}`] : b > a ? [ROM[a - 1], ROM[b - 1]] : [ROM[a - 1]]);
    out.push((books.length > 1 ? 'Livres ' : 'Livre ') + (bits.length > 1 ? bits.slice(0, -1).join(', ') + ' et ' + bits[bits.length - 1] : bits[0]));
  }
  if (has('film')) out.push('Film');
  if (ined.length === 3) out.push('Inédits');
  else if (ined.length) out.push((ined.length > 1 ? 'Inédits ' : 'Inédit ') + ined.join(' et '));
  if (has('dies')) out.push('Dies Iræ');
  if (has('pil')) out.push('Pilotes');
  return out.join(' · ');
}
const poolCache = new Map();
function bySel(arr) {
  if (selAll()) return arr;
  const key = `${sel.join()}|${arr === null ? 'all' : arr === audioIdx ? 'a' : arr === videoIdx ? 'v' : 'x'}`;
  if (arr !== verifyIdx && poolCache.has(key)) return poolCache.get(key);
  const out = (arr || allQuotes.map((_, i) => i)).filter(i => inSel(allQuotes[i]));
  if (arr !== verifyIdx) poolCache.set(key, out);
  return out;
}

// ===== PRÉCHARGEMENT =====
// Hugging Face met ~1 s à servir chaque extrait : on télécharge à l'avance ceux des répliques suivantes
// (fichiers de 30 à 200 Ko) et on les lit depuis la mémoire, ce qui rend le passage d'une réplique à l'autre immédiat.
const mediaCache = new Map();   // url distante → téléchargement en cours ou terminé
const mediaReady = new Map();   // url distante → url blob (extrait déjà en mémoire)
const mediaAbort = new Map();   // url distante → AbortController du téléchargement en cours
const MEDIA_CACHE_MAX = 24;   // extraits de 30 à 650 Ko
// Une copie en mémoire encore lue (carte, son, scène en grand) n'est libérée qu'une fois lâchée
const orphanBlobs = new Set();
const blobInUse = u => !!u && [cardVideo.src, player.src, document.getElementById('mvideo')?.src].includes(u);
function releaseBlob(u) { if (!u) return; if (blobInUse(u)) orphanBlobs.add(u); else URL.revokeObjectURL(u); }
function sweepBlobs() { for (const u of orphanBlobs) if (!blobInUse(u)) { URL.revokeObjectURL(u); orphanBlobs.delete(u); } }
const streamed = new Set();     // fichiers déjà lus directement depuis le réseau : pas de second téléchargement pour « Retour »
function cachedMedia(url) {
  if (!url || mediaCache.has(url) || streamed.has(url)) return;
  sweepBlobs();
  const ac = new AbortController();
  mediaAbort.set(url, ac);
  const job = fetch(url, { signal: ac.signal }).then(r => r.ok ? r.blob() : Promise.reject())
    .then(b => { if (mediaCache.get(url) === job) mediaReady.set(url, URL.createObjectURL(b)); })
    .catch(() => { if (mediaCache.get(url) === job) mediaCache.delete(url); })
    .finally(() => { if (mediaAbort.get(url) === ac) mediaAbort.delete(url); });
  mediaCache.set(url, job);
  while (mediaCache.size > MEDIA_CACHE_MAX) {             // les plus anciens sont libérés (téléchargement en cours : abandonné)
    const old = mediaCache.keys().next().value;
    mediaCache.delete(old);
    mediaAbort.get(old)?.abort();
    releaseBlob(mediaReady.get(old));
    mediaReady.delete(old);
  }
}
// Source à lire : la copie en mémoire si elle est prête, sinon le fichier distant, lu directement par le lecteur.
// Jamais un second téléchargement en parallèle : un préchargement en cours de ce même fichier est abandonné.
// Reste synchrone : sur iOS, play() doit partir dans le geste de l'utilisateur.
function mediaSrc(url) {
  const u = mediaReady.get(url);
  const w = winByURL.get(url);
  if (w) srcWin.set(u || url, w);
  if (u) return u;
  if (mediaAbort.has(url)) { mediaAbort.get(url).abort(); mediaCache.delete(url); }
  streamed.add(url);
  if (streamed.size > 50) streamed.delete(streamed.values().next().value);
  return url;
}
// Répliques probables après celle-ci : on précharge leur vidéo (modes vidéo / vérification) et leur son
function prefetchAround() {
  if (navigator.connection?.saveData) return;      // économie de données (Android) : seule la carte affichée se télécharge
  const P = pool();
  if (P && !P.length) return;
  const next = [];
  // dans l'ordre : les deux suivantes ; en aléatoire : la prochaine tirée à l'avance (la seule qui sera montrée)
  if (inOrder) {
    if (P) { const pos = P.indexOf(quoteIdx); if (pos !== -1) next.push(P[(pos + 1) % P.length], P[(pos + 2) % P.length]); }
    else next.push((quoteIdx + 1) % allQuotes.length);
  } else { if (nextRand === null) nextRand = pickRandom(); next.push(nextRand); }
  if (randPos > 0) next.push(randHistory[randPos - 1]);
  if (randPos < randHistory.length - 1) next.push(randHistory[randPos + 1]);
  next.filter(i => i != null && allQuotes[i]).forEach(i => {
    const q = allQuotes[i];
    if ((videoOnly || verifyMode) && q.video) cachedMedia(playURL(q));
    if (q.audio && (autoPlay || verifyMode || audioOnly)) cachedMedia(audioURL(q.audio));
  });
}
// pool vide (sélection sans réplique) : une réplique quelconque, pour que quoteIdx reste valide ; l'écran vide prend le relais
function pickRandom() { const P = pool(); return P && P.length ? rand(P) : Math.floor(Math.random() * allQuotes.length); }

// Un seul lecteur vidéo pour toutes les cartes : une fois le son autorisé par un toucher (iOS), il le reste
const cardVideo = document.createElement('video');
cardVideo.className = 'quote-video';
cardVideo.id = 'qvideo';
cardVideo.playsInline = true;
cardVideo.setAttribute('playsinline', '');
cardVideo.preload = 'auto';
watchWin(cardVideo);
['touchstart', 'touchend'].forEach(ev => cardVideo.addEventListener(ev, e => e.stopPropagation()));   // les gestes sur le lecteur ne changent pas de réplique

// ===== SCÈNE : figure du registre (image 16:9, repères de coupe, filet d'avancement, légende d'état) =====
// Rien n'est écrit sur l'image : l'état (chargement, sans le son, durée, fin, échec) est dans la légende dessous.
function sceneHTML(q, id) {
  // la source est écrite en clair sous la scène : la légende ne porte que l'état
  return `<figure class="scene"${id ? ` id="${id}"` : ''} data-s="loading"><div class="frame"><div class="prog" aria-hidden="true"><b></b></div></div>`
    + `<figcaption class="leg"><span class="st"></span></figcaption></figure>`;
}
const mmss = t => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const sceneGuards = new WeakMap();   // lecteur → délai de 8 s avant « Scène indisponible »
function setScene(v, st) {
  const f = v.closest('.scene');
  v.parentElement?.classList.toggle('muted', v.muted);
  if (!f) return;
  clearTimeout(sceneGuards.get(v));
  if (st === 'loading') sceneGuards.set(v, setTimeout(() => { if (f.dataset.s === 'loading' && v.closest('.scene') === f) setScene(v, 'error'); }, 8000));
  f.dataset.s = st;
  const el = f.querySelector('.st');
  if (!el) return;
  const T = {
    loading: ['', 'Chargement…'],
    muted:   ['red', '<i aria-hidden="true"></i>Touchez l’image pour le son'],
    playing: ['num', `${mmss(span(v)[0])} / ${mmss(span(v)[1])}`],
    ended:   ['ink', '<span aria-hidden="true">↻</span> Revoir'],
    error:   ['red', navigator.onLine === false ? 'Hors ligne · Réessayer' : 'Scène indisponible · Réessayer'],
  }[st];
  el.className = 'st ' + T[0];
  el.innerHTML = T[1];
}
function tickScene(v) {
  const f = v.closest('.scene');
  if (!f) return;
  const [t, d] = span(v);
  const p = d ? Math.min(100, t / d * 100) : 0;
  f.style.setProperty('--p', p.toFixed(1) + '%');
  if (f.dataset.s === 'playing') { const el = f.querySelector('.st'); if (el) el.textContent = `${mmss(t)} / ${mmss(d)}`; }
  if (!v.paused && !v.ended) requestAnimationFrame(() => tickScene(v));
}
function wireScene(v) {
  v.addEventListener('loadstart', () => setScene(v, 'loading'));
  v.addEventListener('playing', () => { setScene(v, v.muted ? 'muted' : 'playing'); tickScene(v); });
  v.addEventListener('volumechange', () => {
    if (!v.paused && v.closest('.scene')?.dataset.s !== 'loading') setScene(v, v.muted ? 'muted' : 'playing');
    else v.parentElement?.classList.toggle('muted', v.muted);
  });
  v.addEventListener('ended', () => { setScene(v, 'ended'); tickScene(v); });
  v.addEventListener('error', () => { if (v.getAttribute('src')) setScene(v, 'error'); });
}
// toucher la figure : rejouer avec le son, ou réessayer après un échec
function bindScene(fig, v) {
  fig.addEventListener('click', e => {
    e.stopPropagation();
    if (fig.dataset.s === 'error') {
      if (fig.dataset.src && offlineMiss(fig.dataset.src)) { setScene(v, 'error'); return; }
      if (fig.dataset.src && !v.getAttribute('src')) v.src = mediaSrc(fig.dataset.src);
      setScene(v, 'loading'); v.load(); v.play().catch(() => {}); return;
    }
    replayVideo(v);
  });
}
wireScene(cardVideo);
// la barre de lecture de l'écran Répliques suit aussi la scène de la carte
['playing', 'pause', 'ended', 'durationchange'].forEach(ev => cardVideo.addEventListener(ev, () => tickScrub()));
// iOS n'autorise le son qu'après un premier toucher : au premier toucher n'importe où (bouton, filtre, carte),
// on relance le lecteur avec le son ; Safari le considère alors comme débloqué pour toutes les vidéos suivantes
let soundUnlocked = false;
function unlockSound() {
  if (soundUnlocked) return;
  soundUnlocked = true;
  cardVideo.muted = false;
  if (cardVideo.src) cardVideo.play().catch(e => {
    if (e.name === 'NotAllowedError') { cardVideo.muted = true; soundUnlocked = false; }   // refus réel (pas une simple interruption)
  });
  else { cardVideo.play().catch(() => {}); cardVideo.pause(); }
  player.muted = false;
}
function playCardVideo(q, fig) {
  const url = playURL(q);
  const src = mediaSrc(url);
  const frame = fig.querySelector('.frame');
  frame.prepend(cardVideo);
  fig.dataset.src = url;   // « Réessayer » relance ce fichier
  if (offlineMiss(url)) { cardVideo.pause(); cardVideo.removeAttribute('src'); setScene(cardVideo, 'error'); return; }
  if (cardVideo.src !== src) { cardVideo.src = src; setScene(cardVideo, 'loading'); }
  seekStart(cardVideo);
  // son activé par défaut ; si le navigateur refuse (aucun toucher encore), lecture sans son, signalée
  cardVideo.muted = false;
  cardVideo.play().catch(e => {
    if (e.name !== 'NotAllowedError') return;            // lecture interrompue par la réplique suivante : rien à faire
    if (playingBtn) return;                              // refus arrivé après « Écouter » : la scène ne repart pas sous le son
    cardVideo.muted = true; cardVideo.play().catch(() => {});
  });
}

// Répliques parcourues (aléatoire / ordre) selon la sélection et l'affichage : null = toutes, [] = aucune (écran vide)
function pool() {
  if (verifyMode) {                         // jamais vide : l'écran « tout vérifié » prend le relais
    if (verifyIdx.length) return verifyIdx;
    const P = bySel(null); return P && P.length ? P : null;
  }
  if (videoOnly && videoIdx.length) return bySel(videoIdx);
  if (audioOnly && audioIdx.length) return bySel(audioIdx);
  return bySel(null);
}
const poolEmpty = () => { const P = pool(); return !!P && P.length === 0; };
// ===== VÉRIFICATION (avis son / vidéo justes ou non, envoyés à /api/avis) =====
// lecture validée : une valeur abîmée (autre type que la valeur par défaut) est ignorée en mémoire, jamais réécrite
function readJSON(k, def) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' && Array.isArray(v) === Array.isArray(def) ? v : def; }
  catch { return def; }
}
// vrai si l'écriture a réussi (stockage plein ou refusé : faux, l'appelant le dit)
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
// Empreinte du son et de la scène vérifiés (FNV-1a 32 bits, base 36 ; même calcul dans kaam-audio/avis_partage.py) :
// un son recalé ou une scène refaite change d'empreinte, la réplique revient alors à vérifier pour tout le monde
function fpOf(q) {
  if (q._fp) return q._fp;
  const s = `${q.audio || ''}|${q.video || ''}|${q.vv || 0}`;
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; }
  return (q._fp = h.toString(36));
}
// vérifiée sur ce téléphone, ou par quelqu'un d'autre sur ce même son et cette même scène
const dejaVue = q => !!avisFaits[q.i] || avisTous[q.i] === fpOf(q);
// Répliques déjà vérifiées par les autres : relues en entrant en vérification, au retour dans l'app, puis toutes les
// 3 min (cache Vercel d'1 min). Échec (hors ligne, test local sans API) : on garde la dernière liste connue.
let avisTousT = 0;
function loadAvisTous(force) {
  if (!verifyMode || (!force && Date.now() - avisTousT < 120e3)) return;
  avisTousT = Date.now();
  fetch('/api/avis').then(r => r.ok ? r.json() : null).then(j => {
    if (!j || !j.faits || typeof j.faits !== 'object' || Array.isArray(j.faits)) return;
    avisTous = j.faits; writeJSON('kaam_avis_tous', avisTous);
    const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    avisCoupes = obj(j.coupes); avisDemandes = obj(j.demandes);
    writeJSON('kaam_avis_coupes', avisCoupes); writeJSON('kaam_avis_demandes', avisDemandes);
    oublieMesCoupes();
    if (!verifyMode || !allQuotes.length) return;
    rebuildVerify();
    if (!verifyIdx.length) { renderCitations(); return; }    // les autres ont fini : écran « tout est vérifié »
    const b = document.querySelector('.bar.verify .bar-sum'), q = allQuotes[quoteIdx];
    if (b && q) b.innerHTML = citationsModel(q).summary;    // la réplique affichée reste : on ne l'enlève pas sous le doigt
  }).catch(() => {});
}
// Coupes et demandes de ce téléphone : oubliées dès que la liste commune les connaît, que la réplique a changé (nouveau
// son ou nouvelle scène), ou au bout de 2 jours si elles ne sont plus en attente d'envoi
function oublieMesCoupes() {
  const enFile = new Set(avisFile.map(a => a.i));
  const garde = (m, k) => {
    const q = parI(k), x = m[k];
    return !!q && !!x && !(k in (m === mesCoupes ? avisCoupes : avisDemandes)) && x.fp === fpOf(q) && (enFile.has(+k) || Date.now() - x.ts < 2 * 864e5);
  };
  for (const k of Object.keys(mesCoupes)) if (!garde(mesCoupes, k)) delete mesCoupes[k];
  for (const k of Object.keys(mesDemandes)) if (!garde(mesDemandes, k)) delete mesDemandes[k];
  writeJSON('kaam_coupes', mesCoupes); writeJSON('kaam_demandes', mesDemandes);
}
// Toutes les répliques de la sélection (Livres, film, inédits cochés) pas encore classées, en une seule file : dans
// l'ordre, les sons estimés (≈, les moins sûrs) d'abord, puis les autres répliques avec son ou vidéo, enfin celles sans
// rien (texte, ou son manquant à signaler) ; au hasard, tirage dans toute la file
function rebuildVerify() {
  const approx = [], media = [], texte = [];
  allQuotes.forEach((q, i) => { if (!dejaVue(q) && inSel(q)) (!(q.audio || q.video) ? texte : q.approx ? approx : media).push(i); });
  verifyIdx = approx.concat(media, texte);
  verifyTodo = { approx: approx.length, others: media.length, texte: texte.length };
}
const player = new Audio();   // un seul lecteur de son pour toute l'app
player.preload = 'auto';
watchWin(player);

// Accès au stockage local : toujours par ces fonctions (stockage refusé ou plein : valeur par défaut, jamais d'exception)
function readPref(k) { try { return localStorage.getItem(k) === '1'; } catch { return false; } }
function writePref(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch {} }
function readStr(k, def) { try { return localStorage.getItem(k) || def; } catch { return def; } }
function writeStr(k, v) { try { localStorage.setItem(k, String(v)); return true; } catch { return false; } }


// État du son sur le bouton qui l'a lancé : attente (chargement), lecture (rouge + filet d'avancement), échec
let switching = false;
function rowOf(btn) { return btn?.closest('.acts, .ent-a') || null; }
function setPlayingBtn(btn) {
  if (playingBtn && playingBtn !== btn) {
    playingBtn.classList.remove('playing', 'wait');
    const r = rowOf(playingBtn); if (r) { r.classList.remove('playing'); r.style.setProperty('--p', 0); }
    playingBtn.closest('.ent')?.classList.remove('playing');
  }
  playingBtn = btn;
  if (btn) {
    btn.classList.add('playing', 'wait');
    rowOf(btn)?.classList.add('playing');
    btn.closest('.ent')?.classList.add('playing');
    tickAudio();
  }
}
function tickAudio() {
  const r = rowOf(playingBtn);
  const [t, d] = span(player);
  if (r && d) r.style.setProperty('--p', Math.min(1, t / d).toFixed(3));
  if (playingBtn && !player.paused) requestAnimationFrame(tickAudio);
}
// échec : « Réessayer » 2,5 s dans le bouton (ou « Hors ligne » quand l'appareil n'a pas de réseau)
function audioFailed(why) {
  clearTimeout(audioGuard);
  const b = playingBtn;
  setPlayingBtn(null);
  const lp = b?.querySelector('.lp');
  if (lp) { lp.textContent = why || 'Réessayer'; setTimeout(() => { if (lp.isConnected) lp.textContent = 'Écouter'; }, 2500); }
  // lecteur principal : l'échec se lit aussi dans la barre de lecture
  if (b?.id === 'btn-audio') { failNote = why || 'Son indisponible'; tickScrub(); setTimeout(() => { failNote = ''; tickScrub(); }, 2500); }
  renderMini();
}
let failNote = '';   // « Son indisponible » / « Hors ligne » 2,5 s dans la barre de lecture
const offlineMiss = url => navigator.onLine === false && !mediaReady.has(url);   // hors ligne et pas en mémoire : inutile d'attendre
let audioGuard = null;   // délai maximum de chargement d'un son (Hugging Face qui ne répond pas)
let audioQ = null;       // réplique dont le son est dans le lecteur (mini-lecteur)
// scènes en pause (carte, quiz, fenêtre) ; le son continue (changement d'onglet : il passe dans le mini-lecteur)
function stopVideos() {
  cardVideo.pause();
  document.querySelectorAll('video').forEach(v => v.pause());
}
function stopAudio() {
  clearTimeout(audioGuard);
  player.pause();
  stopVideos();
  setPlayingBtn(null);
  audioQ = null;
  renderMini();
}
function playAudio(src, btn, q) {
  if (!src) return;
  if (btn && btn === playingBtn) { stopAudio(); return; }   // toucher pendant le chargement ou la lecture = arrêter
  const url = q && fenetre(q) ? playURL(q) : audioURL(src);   // coupe en attente : le son de la vidéo élargie, fenêtré
  if (offlineMiss(url)) { player.pause(); setPlayingBtn(btn || null); audioFailed('Hors ligne'); return; }
  // jamais deux sons à la fois : la scène (carte ou fenêtre) s'arrête
  cardVideo.pause();
  document.getElementById('mvideo')?.pause();
  switching = true;
  player.src = mediaSrc(url);
  seekStart(player);
  audioQ = q || null;
  setPlayingBtn(btn || null);
  clearTimeout(audioGuard);
  audioGuard = setTimeout(() => { if (playingBtn?.classList.contains('wait')) { player.pause(); audioFailed(); } }, 10000);
  player.play().catch(e => { if (e.name !== 'AbortError') audioFailed(); });
  switching = false;
  majSessionMedia(q);
  renderMini();
}
// Écran verrouillé et Centre de contrôle : la réplique et le personnage, suivante / précédente comme les gestes
function majSessionMedia(q) {
  if (!('mediaSession' in navigator) || !q) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: q.quote.length > 90 ? q.quote.slice(0, 88) + '…' : q.quote,
      artist: nameCase(q.name), album: fmtEp(q) || 'Kaamelott', artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] });
  } catch {}
}
if ('mediaSession' in navigator) {
  try {
    // jamais en vérification (chaque réplique s'y classe à la main) ; le son de la nouvelle réplique part (sauf lecture auto, qui s'en charge)
    const suivre = f => () => {
      if (currentView !== 'citations' || verifyMode) return;
      f();
      const q = allQuotes[quoteIdx];
      if (!autoPlay && q?.audio) playAudio(q.audio, document.getElementById('btn-audio'), q);
    };
    navigator.mediaSession.setActionHandler('nexttrack', suivre(() => swipeForward()));
    navigator.mediaSession.setActionHandler('previoustrack', suivre(() => swipeBack()));
  } catch {}
}
player.addEventListener('playing', () => { clearTimeout(audioGuard); playingBtn?.classList.remove('wait'); tickAudio(); tickScrub(); renderMini(); });
player.addEventListener('ended', () => { setPlayingBtn(null); tickScrub(); renderMini(); });
player.addEventListener('pause', () => { if (!switching && !player.ended && playingBtn && !playingBtn.classList.contains('wait')) setPlayingBtn(null); renderMini(); });
player.addEventListener('error', () => { if (playingBtn) audioFailed(); });

// ===== BARRE DE LECTURE (écran Répliques) : filet d'avancement du son ou de la scène, visible pendant la lecture seulement =====
let scrubRaf = 0;
function tickScrub() {
  cancelAnimationFrame(scrubRaf);
  const sc = document.getElementById('scrub');
  if (!sc) return;
  const q = allQuotes[quoteIdx];
  const inline = cardVideo.closest('#qvideo-slot');
  const m = playingBtn?.id === 'btn-audio' || (audioQ && q && audioQ.i === q.i && !inline) ? player : inline ? cardVideo : null;
  const [t, d] = m ? span(m) : [0, NaN];
  sc.style.setProperty('--p', (isFinite(d) && d > 0 ? Math.min(100, t / d * 100) : 0).toFixed(2) + '%');
  sc.classList.toggle('on', !!m && !m.paused && !m.ended);
  const bd = sc.querySelector('.badge');
  if (bd) { const txt = failNote || bd.dataset.t || ''; bd.textContent = txt; bd.hidden = !txt; }
  if (m && !m.paused && !m.ended) scrubRaf = requestAnimationFrame(tickScrub);
}

// ===== MINI-LECTEUR : le son continue quand on change d'onglet ou qu'on ouvre une fiche =====
function renderMini() {
  const el = document.getElementById('mini');
  if (!el) return;
  const ov = !document.getElementById('detail-overlay').classList.contains('hidden');
  const q = audioQ;
  // sur l'écran Répliques, la carte commande le son de SA réplique ; un son venu d'ailleurs (fiche, liste) garde le mini-lecteur
  const card = document.getElementById('quote-card') && allQuotes[quoteIdx];
  const own = !!q && !!card && card.i === q.i;
  const show = !!q && !!player.src && (currentView !== 'citations' || ov || !own);
  if (el.hidden !== !show) el.hidden = !show;
  if (!show) { el.dataset.k = ''; return; }
  const on = !player.paused && !player.ended;
  const k = `${q.i}|${on}`;
  if (el.dataset.k === k) return;
  el.dataset.k = k;
  const sub = [nameCase(q.name), epLabel(q)].filter(Boolean).join(' · ');
  el.innerHTML = `<button class="mini-open" id="mini-open" aria-label="Ouvrir la réplique : ${esc(nameCase(q.name))}">${faceHTML(faceName(q), 's', 'tile')}
      <span class="tx"><b>${typo(q.quote)}</b><span>${esc(sub)}</span></span></button>
    <button class="mb" id="mini-play" aria-label="${on ? 'Pause' : 'Lecture'}">${icon(on ? 'pause' : 'play')}</button>
    <button class="mb mx" id="mini-close" aria-label="Fermer le lecteur">${icon('x')}</button>`;
}
function bindMini() {
  const el = document.getElementById('mini');
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !audioQ) return;
    if (b.id === 'mini-play') {
      if (!player.paused && !player.ended) player.pause();
      else { if (player.ended) seekStart(player); cardVideo.pause(); player.play().catch(() => {}); }
    } else if (b.id === 'mini-close') stopAudio();
    else if (b.id === 'mini-open') gotoQuote(audioQ);
  });
}

// ===== PARSE DATA =====
// Coquilles des scripts sur les noms : corrigées à la lecture (data.json n'est pas réécrit, l'index i est conservé)
const NAME_FIX = {
  'DAME DU LAC': 'LA DAME DU LAC', 'LA DAME OU LAC': 'LA DAME DU LAC', 'IA DAME DU LAC': 'LA DAME DU LAC',
  'LE MAITRE D’ARMES': 'LE MAÎTRE D’ARMES', 'LE MAÎTRE D’ARMÉS': 'LE MAÎTRE D’ARMES', 'LE MAÎTRE D’ARME': 'LE MAÎTRE D’ARMES',
  "LE MAITRE D'ARMES": 'LE MAÎTRE D’ARMES', "LE MAÎTRE D'ARMES": 'LE MAÎTRE D’ARMES',
  'LÉODAGANR': 'LÉODAGAN', 'PÈRE BIAISE': 'PÈRE BLAISE',
};
// Le champ « character » ne prend que ~2 500 valeurs pour 33 000 répliques : son analyse est gardée par valeur
const charMemo = new Map();
function parseCharacter(raw) {
  let c = charMemo.get(raw);
  if (c) return c;
  const commaIdx = raw.indexOf(',');
  const n0 = commaIdx > -1
    ? raw.slice(0, commaIdx).trim().replace(/\s+/g, ' ').toUpperCase()
    : raw.trim().replace(/\s+/g, ' ').toUpperCase();
  const rest = commaIdx > -1 ? raw.slice(commaIdx + 1) : '';
  const livreM = rest.match(/livre\s+(I{1,3}V?|VI?)/i);
  const epM    = rest.match(/épisode\s+(\d+)\s*(?::\s*(.+))?/i);
  // scénarios inédits (« Inédit 3 : Dolor ») : jamais tournés, sauf ceux marqués "tourne":1 dans data.json
  // (Inédits 1 et 2, tournés : son + scène depuis le 13/10/2026)
  const inedM  = rest.match(/Inédit\s+(\d)\s*:\s*(.+)/i);
  c = {
    name: NAME_FIX[n0] || n0,
    livre: livreM ? livreM[1].toUpperCase() : '',
    episode: epM ? epM[1] : '',
    title: epM && epM[2] ? epM[2].trim() : '',
    film: /premier volet/i.test(rest) ? 'Kaamelott : Premier Volet' : '',
    // « PERCEVAL, pilote, épisode 4: La Romance de Perceval » ; « ARTHUR, Dies Iræ (court métrage, 2003) »
    // (le court métrage de 2003, pas l'épisode 9 du Livre VI qui porte le même nom)
    pil: /^\s*pilote\b/i.test(rest),
    dies: /court métrage/i.test(rest),
    inedTxt: inedM ? `Inédit ${inedM[1]} : ${titleCase(inedM[2].trim())}` : 'Inédit',   // « Le Spectre D'Uther » → « d'Uther »
  };
  charMemo.set(raw, c);
  return c;
}
// Didascalies des scripts (« (désignant Guethenoc) », « (à la cantonade) ») : jamais affichées.
// Le texte original reste intact dans data.json ; seule la réplique dite est montrée, cherchée et partagée.
function stripDid(t) {
  if (!t || t.indexOf('(') < 0) return t;
  return t.replace(/\s*\([^()]*\)\s*/g, ' ')
    .replace(/\s+([,.…])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim() || t;
}
function parseQuote(item, i) {
  const c = parseCharacter(item.character || '');
  return { i, quote: stripDid(item.quote), name: c.name, livre: c.livre, episode: c.episode, title: c.title, film: c.film,
    inedit: item.inedit ? c.inedTxt : '', tourne: !!item.tourne, hide: !!item.hide, part: partOf(c, item.inedit),
    audio: item.audio ? item.audio + (item.v ? `?v=${item.v}` : '') : null, video: item.video || null, vv: item.vv || 0, approx: !!item.approx,
    // vidéo élargie pour refaire la coupe : [secondes avant, durée de l'extrait, secondes après]
    cx: item.video && Array.isArray(item.cx) && item.cx.length === 3 && item.cx.every(x => typeof x === 'number' && x >= 0) ? item.cx : null,
    // pilotes et Dies Iræ : pas de script, répliques transcrites à l'écoute ; acteur = interprète s'il n'est pas celui de la série
    tr: !!item.transcription, acteur: item.acteur || '' };
}

const DATA_BYTES = 7000000;   // taille approximative de data.json (le serveur l'envoie compressé, sans longueur)
function bootProgress(got, total) {
  const box = document.getElementById('launch') ? '#launch' : '.boot';   // écran de lancement tant qu'il est là
  const rail = document.querySelector(`${box} .rail`);
  if (!rail) return;
  const pc = Math.min(99, Math.round(got / total * 100));
  rail.classList.remove('indet');
  rail.style.setProperty('--p', pc + '%');
  const m = document.querySelector(`${box} .m`);
  const mo = x => (x / 1e6).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (m) m.innerHTML = box === '#launch'
    ? `Premier lancement · ${mo(got)} Mo sur ${mo(Math.max(got, total))} Mo`
    : `<span>${mo(got)} Mo sur ${mo(Math.max(got, total))} Mo</span><span>${pc} %</span>`;
}
async function loadData() {
  const perso = loadPerso();   // en parallèle des répliques ; jamais bloquant (sans liste : les initiales)
  // jusqu'à 3 essais : le premier peut tomber sur la page de contrôle anti-robot de Vercel (403), qui se lève seule
  let raw = null, detail = '';
  for (let essai = 0; essai < 3 && !raw; essai++) {
    if (essai) await new Promise(r => setTimeout(r, 2500));
    try {
      const res = await fetch('data.json', { cache: essai ? 'reload' : 'default' });
      if (res.status === 401) throw Object.assign(new Error('code d’accès requis'), { acces: true });   // middleware.js
      detail = `HTTP ${res.status} ${res.headers.get('content-type') || ''} ${res.headers.get('x-vercel-mitigated') || ''}`;
      const json = /json/.test(res.headers.get('content-type') || '');   // un portail Wi-Fi renvoie du HTML en 200
      if (res.ok && !json) throw new Error('réponse qui n’est pas du JSON');
      if (res.ok && res.body && res.body.getReader) {
        // progression réelle (octets reçus) ; data.json est souvent compressé : on rapporte à sa taille connue
        const total = +(res.headers.get('content-encoding') ? 0 : res.headers.get('content-length')) || DATA_BYTES;
        const copy = window.caches && !navigator.serviceWorker?.controller ? res.clone() : null;
        const reader = res.body.getReader(), parts = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); got += value.length;
          bootProgress(got, total);
        }
        if (copy) caches.open('kaamelott-data').then(c => c.put('/data.json', copy)).catch(() => {});
        const buf = new Uint8Array(got); let at = 0;
        for (const p of parts) { buf.set(p, at); at += p.length; }
        raw = JSON.parse(new TextDecoder().decode(buf));
      } else if (res.ok) {
        // premier lancement (aucun service worker aux commandes) : la page range elle-même les répliques dans le cache
        // que le service worker servira ensuite, pour ne jamais les télécharger deux fois
        if (window.caches && !navigator.serviceWorker?.controller) {
          const copy = res.clone();
          caches.open('kaamelott-data').then(c => c.put('/data.json', copy)).catch(() => {});
        }
        raw = await res.json();
      }
    } catch (e) { if (e.acces) throw e; detail += ` · ${e.name}: ${e.message}`; }
  }
  if (!raw) throw new Error(`data.json : ${detail}`);
  if (!Array.isArray(raw) || !raw.length) throw new Error('data.json vide');   // jamais une app vide rechargée en boucle
  await Promise.race([perso, new Promise(r => setTimeout(r, 1500))]);
  allQuotes  = raw.map(parseQuote).filter(q => q.quote && q.name && !q.hide);   // hide : doublon masqué (index i conservé)
  audioIdx   = allQuotes.reduce((acc, q, i) => (q.audio && acc.push(i), acc), []);
  videoIdx   = allQuotes.reduce((acc, q, i) => (q.video && acc.push(i), acc), []);
  poolCache.clear();
  rebuildVerify(); loadAvisTous(true);
  if (!audioIdx.length) audioOnly = false;
  if (!videoIdx.length) { videoOnly = false; if (media === 'video') media = audioOnly ? 'audio' : 'text'; }   // en mémoire seulement
}

// ===== STORAGE =====
// kaam_fav est filtré en mémoire (entrées abîmées ignorées) mais jamais réécrit au chargement :
// la valeur stockée reste intacte tant que l'utilisateur ne modifie rien.
function loadFavorites() {
  let v; try { v = JSON.parse(localStorage.getItem('kaam_fav') || '[]'); } catch { v = []; }
  favorites = Array.isArray(v) ? v.filter(f => f && typeof f.quote === 'string' && typeof f.name === 'string') : [];
}
function saveFavorites() { return writeJSON('kaam_fav', favorites); }
// même réplique : même texte et même personnage (nom corrigé par NAME_FIX pour les favoris anciens)
function sameQuote(f, q) { return stripDid(f.quote) === q.quote && (NAME_FIX[f.name] || f.name) === q.name; }   // favoris enregistrés avec didascalies compris
function isFav(q) { return favorites.some(f => sameQuote(f, q)); }
// faux si l'enregistrement a échoué (stockage plein ou refusé) : rien n'est changé en mémoire
function toggleFav(q) {
  const before = favorites;
  if (isFav(q)) favorites = favorites.filter(f => !sameQuote(f, q));
  else { const { live, ...keep } = q; favorites = [keep, ...favorites]; }   // la réplique entière, avec son index stable i
  if (saveFavorites()) { if (favorites.length > before.length) garderFavoris(); return true; }
  favorites = before;
  return false;
}
// Étoile ronde (écran Répliques, scène en grand) ou étoile de liste ; le libellé reste lisible par VoiceOver
function favFace(on, label = 'Favori', tip = '') {
  return `${icon(on ? 'star-f' : 'star')}<span class="lab">${label}</span>${tip ? `<span class="tip" role="status">${tip}</span>` : ''}`;
}
function favCellHTML(q, on = isFav(q)) {
  return `<button class="ic fav${on ? ' on' : ''}" id="btn-fav" aria-pressed="${on}">${favFace(on)}</button>`;
}
// bouton Favori : état coché à jour, ou « Non enregistré » 2 s si le stockage a refusé
// Favoris gardés seulement sur l'appareil : stockage déclaré « persistant » au premier ajout (Safari efface sinon les
// données d'un site non visité pendant 7 jours ; les apps de l'écran d'accueil en sont exemptées)
let persistDemande = false;
function garderFavoris() {
  if (persistDemande) return;
  persistDemande = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}
}
// iPhone, dans un onglet Safari (pas l'app de l'écran d'accueil) : seul cas où les favoris peuvent disparaître
const ongletIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
function favButton(btn, q, label = 'Favori') {
  const ok = toggleFav(q), on = isFav(q);
  btn.innerHTML = favFace(on, label, ok ? '' : 'Non enregistré');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on);
  if (ok && on) btn.classList.add('pop'), setTimeout(() => btn.classList.remove('pop'), 300);
  if (!ok) {
    document.getElementById('sr-live').textContent = 'Favori non enregistré : le stockage de l’appareil est plein ou bloqué.';
    setTimeout(() => { if (btn.isConnected) btn.innerHTML = favFace(isFav(q), label); }, 2000);
  }
}

// Étoile de la carte (écran Répliques) remise à jour quand le favori a changé ailleurs (scène en grand, menu « … » d'une fiche)
function syncCardFav() {
  const btn = document.getElementById('btn-fav'), q = allQuotes[quoteIdx];
  if (!btn || !q || !document.getElementById('quote-card')) return;
  const on = isFav(q);
  if (btn.classList.contains('on') === on) return;
  btn.innerHTML = favFace(on);
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on);
}

// ===== UTILS =====
// Échappement HTML de tout gabarit : accepte aussi les nombres (0 compris), apostrophe comprise
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, c => ESC[c]); }
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
// Pictogramme du jeu de symboles d'index.html (à la manière des SF Symbols)
const icon = (id, cls = '') => `<svg viewBox="0 0 28 28"${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${id}"/></svg>`;

// ===== PORTRAITS : une image par personnage, tirée de ses propres scènes (img/perso/, liste dans perso.json) =====
// p = 3:4 (grandes cartes), s = carré (vignettes, ronds), w = 4:3 (en-tête de fiche). Noms de fichier à empreinte : immuables.
// Sans image (ou image introuvable) : la silhouette grise des Contacts d'iOS, jamais une couleur inventée.
let PERSO = {};
function persoURL(name, kind) { const f = PERSO[name]; return f ? `img/perso/${f}-${kind}.jpg` : null; }
function faceHTML(name, kind = 's', cls = 'av') {
  const u = persoURL(name, kind);
  return `<span class="${cls} mono${u ? ' img' : ''}" aria-hidden="true">${icon('person', 'pg')}${u ? `<img src="${u}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
}
// image absente ou refusée : retirée, la silhouette reste (écouteur unique, en capture : l'erreur d'une image ne remonte pas).
// Hors ligne, le service worker répond un GIF vide de 1 px (jamais d'erreur réseau) : traité comme une image absente.
function onImgLoad(e) { if (e.target?.tagName === 'IMG' && e.target.naturalWidth <= 1) onImgError(e); }
function onImgError(e) {
  const im = e.target;
  if (im && im.tagName === 'IMG' && im.parentElement?.classList.contains('img')) {
    im.parentElement.classList.remove('img');
    im.closest('.fiche-h')?.classList.remove('photo');
    im.closest('.stage')?.classList.remove('photo');   // carte de réplique : fond neutre
    im.remove();
  }
}
async function loadPerso() {
  try {
    const r = await fetch('perso.json');
    const j = r.ok && /json/.test(r.headers.get('content-type') || '') ? await r.json() : null;
    if (j && typeof j === 'object' && !Array.isArray(j)) PERSO = j;
  } catch {}
}
const livreNom = L => /^[IV]+$/.test(L) ? `Livre ${L}` : L === 'Film' ? 'Premier Volet' : L === 'Pilotes' ? 'Épisodes pilotes' : L;

// ===== MISE EN FORME =====
const nf = n => n.toLocaleString('fr-FR');
const plural = (n, w, ws = w + 's') => `${nf(n)} ${n > 1 ? ws : w}`;   // « 1 réplique », « 2 537 répliques »
const SEP = '<span class="sep" aria-hidden="true">·</span>';          // séparateur des lignes de résumé
function fmtEp(q) {
  if (q.film) return `Film · ${q.film}`;
  if (q.part === 'dies') return 'Dies Iræ · court métrage, 2003';
  if (q.part === 'pil') return `Pilote ${q.episode}${q.title ? ` : ${q.title}` : ''}`;
  if (q.inedit) return q.tourne ? q.inedit : `${q.inedit} · jamais tourné`;
  if (!q.livre && !q.episode) return '';
  let s = '';
  if (q.livre)   s += `Livre ${q.livre}`;
  if (q.episode) s += `${s ? ' · ' : ''}Épisode ${q.episode}`;
  if (q.title)   s += ` : ${titleCase(q.title)}`;
  return s;
}
// Cote courte d'une réplique (« L.IV · É.58 », « Film », « Inédit 3 ») : la référence du registre, en Plex Mono
function coteEp(q) {
  if (q.film) return 'Film';
  if (q.part === 'dies') return 'Dies Iræ';
  if (q.part === 'pil') return `Pilote ${q.episode}`;
  if (q.inedit) { const m = /Inédit (\d)/.exec(q.inedit); return m ? `Inédit ${m[1]}` : 'Inédit'; }
  if (!q.livre && !q.episode) return '';
  return [q.livre ? `L.${q.livre}` : '', q.episode ? `É.${q.episode}` : ''].filter(Boolean).join(' · ');
}
// Titres d'épisode tout en capitales dans les scripts (« AU BONHEUR DES DAMES ») : remis en casse de phrase,
// en gardant les chiffres romains (« Vox populi III ») et la capitale des noms de personnages (« Le monde d’Arthur »)
let KNOWN = null;   // noms de personnages d'un seul mot, sans accents ni casse
// noms propres des titres qui ne sont pas des personnages (lieux, objets, figures) ; les adjectifs (« romain ») restent en minuscule
const PROPRES = ['graal', 'aquitaine', 'tintagel', 'cornouailles', 'dieu', 'sainte', 'croix', 'silbury', 'hill', 'euripide', 'alexandre', 'gauvain', 'dagonet', 'caius', 'sloubi'];
function knownNames() {
  if (!KNOWN && allQuotes.length) KNOWN = new Set(getCharList().map(([n]) => n).filter(n => !/[\s’']/.test(n) && n.length > 2 && n !== 'TOUS').map(fold).concat(PROPRES));
  return KNOWN || new Set(PROPRES);
}
function titleCase(t) {
  // tout en capitales, ordinaux mis à part (« LA POÉTIQUE, 2e PARTIE », « 1re », « 3ème ») : leur minuscule ne compte pas
  const caps = t.replace(/(\d)(er|re|e|ème|nd|nde)(?![\p{L}])/gu, '$1');
  if (caps === caps.toUpperCase()) {
    const K = knownNames();
    let s = t.toLowerCase();
    s = s.charAt(0).toUpperCase() + s.slice(1);
    s = s.replace(/(^|[\s’'(-])(i{1,3}|iv|vi{0,3}|ix|x)(?=$|[\s,.:;!?)])/g, (m, a, r) => a + r.toUpperCase());
    return s.replace(/(^|[\s’'(-])(\p{L}+)/gu, (m, a, w) => K.has(fold(w)) ? a + w.charAt(0).toUpperCase() + w.slice(1) : m);
  }
  // « Guenièvre Et L’Orage » → « Guenièvre et l’Orage » : petits mots en bas de casse après le premier
  return t.split(' ').map((w, k) => {
    if (!k) return w;
    if (/^(Et|De|Du|Des|La|Le|Les|Aux|Au|En|À|Sur|Un|Une)$/.test(w)) return w.toLowerCase();
    return w.replace(/^(L|D)(['’])/, (m, a, b) => a.toLowerCase() + b);
  }).join(' ');
}
// Typographie française : apostrophe courbe, espace fine insécable (U+202F) avant ! ? ; » et après « ;
// insécable pleine (U+00A0) avant les deux-points (usage de l'Imprimerie nationale)
function typoHTML(h) {
  return h.replace(/&(#?\w+);/g, '&$1\u0001')          // entités (&quot; …) protégées de la règle du point-virgule
    .replace(/'/g, '’')
    .replace(/[   ]+([!?;»])/g, ' $1')
    .replace(/([^\s  ])([!?;»])/g, '$1 $2')
    .replace(/[   ]+:/g, ' :')
    .replace(/«[   ]*/g, '« ')
    .replace(/\u0001/g, ';');
}
function typo(s) { return typoHTML(esc(s == null ? '' : String(s).replace(/'/g, '’'))); }   // apostrophe courbe avant l'échappement
function quoteHTML(s) { return `<span class="g" aria-hidden="true">«</span> ${typo(s)} <span class="g" aria-hidden="true">»</span>`; }
// Source d'une réplique, prête à insérer en HTML (typographie appliquée)
// « Transcription » : réplique relevée à l'écoute (pilotes, Dies Iræ), pas tirée d'un script
function epHTML(q) { return typo(fmtEp(q)) + (q.tr ? ' · <span class="trs">Transcription</span>' : ''); }
// Interprète d'un rôle tenu par un autre acteur que dans la série (« Interprété par Vanessa Guedj »)
const byLine = q => q.acteur ? `Interprété par ${q.acteur}` : '';
const byHTML = q => q.acteur ? `<p class="src by">${esc(byLine(q))}</p>` : '';
// photo du personnage : jamais celle de l'acteur de la série sur une réplique jouée par un autre
const faceName = q => q.acteur ? '' : q.name;
// Nom en casse de titre pour les listes (« PÈRE BLAISE » → « Père Blaise », « LA DAME DU LAC » → « La Dame du Lac »)
const PETITS = new Set(['de', 'du', 'des', 'et', 'le', 'la', 'les', 'aux', 'au', 'à', 'en', 'sur']);
function nameCase(n) {
  return n.toLowerCase().split(/(\s+|-)/).map((w, k) => {
    if (!w.trim() || w === '-') return w;
    if (k > 0 && PETITS.has(w)) return w;
    if (k > 0 && /^(i{1,3}|iv|vi{0,3}|ix|x)$/.test(w)) return w.toUpperCase();   // « Perceval II »
    const m = /^(l'|l’|d'|d’)(.+)$/.exec(w);
    if (m) return (k ? m[1] : m[1].charAt(0).toUpperCase() + m[1].slice(1)) + m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}
// Corps de la réplique selon sa longueur : jamais tronquée (la scène défile si besoin)
function quoteSize(s) {
  const L = s.length, k = window.innerWidth < 360 ? .86 : 1;
  const px = L <= 30 ? 36 : L <= 60 ? 32 : L <= 110 ? 28 : L <= 180 ? 25 : L <= 280 ? 22 : L <= 420 ? 20 : 18;
  return Math.round(px * k);
}
// Pliage commun : ligatures dépliées (« cœur » = « coeur », personne ne tape œ sur iPhone), accents retirés
const DIACRITIQUES = /[\u0300-\u036f]/g;
const strip = s => (s || '').replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').normalize('NFD').replace(DIACRITIQUES, '');
function fold(s) { return strip(s).toLowerCase().replace(/[’']/g, "'"); }
// Surlignage : texte plié caractère par caractère, avec pour chaque caractère plié l'indice du caractère d'origine
// (« œ » donne « oe », deux caractères pliés qui pointent sur le même caractère d'origine)
function foldMap(s) {
  let f = '';
  const at = [];
  for (let k = 0; k < s.length; k++) {
    for (const x of strip(s[k]).toLowerCase().replace(/[^a-z0-9]/g, ' ')) { f += x; at.push(k); }
  }
  return { f, at };
}
// Surlignage : d'abord la phrase cherchée telle quelle (accents et apostrophes ignorés), sinon chaque mot cherché
// d'au moins 3 lettres ; toujours des mots entiers (« perce » souligne « Perceval »), jamais une lettre isolée.
// La typographie est appliquée une seule fois, sur le HTML découpé.
function highlight(text, query) {
  const plain = text.replace(/'/g, '’');
  const toks = foldIx(query).trim().split(' ').filter(Boolean);
  if (!toks.length) return typo(text);
  const { f, at } = foldMap(plain);
  const marks = new Uint8Array(plain.length);
  const mark = t => {                            // occurrences en début de mot, étendues jusqu'à la fin du mot
    let p = -1, n = 0;
    while ((p = f.indexOf(t, p + 1)) >= 0) {
      if (p > 0 && f[p - 1] !== ' ') continue;
      let e = p + t.length;
      while (e < f.length && f[e] !== ' ') e++;
      marks.fill(1, at[p], at[e - 1] + 1); n++;
    }
    return n;
  };
  const phrase = toks.join(' ');
  if (phrase.length < 3 || !mark(phrase)) toks.filter(t => t.length >= 3).forEach(mark);
  let out = '', i = 0;
  while (i < plain.length) {
    let j = i; while (j < plain.length && marks[j] === marks[i]) j++;
    out += marks[i] ? `<mark>${esc(plain.slice(i, j))}</mark>` : esc(plain.slice(i, j));
    i = j;
  }
  return typoHTML(out);
}
let charCache = null;
function getCharList() {                       // calculée une fois par chargement des données
  if (charCache && charCache.src === allQuotes) return charCache.list;
  const map = {};
  allQuotes.forEach(q => { map[q.name] = (map[q.name] || 0) + 1; });
  charCache = { src: allQuotes, list: Object.entries(map).sort((a, b) => b[1] - a[1]) };
  return charCache.list;
}
// Clé d'épisode : film, inédit, Dies Iræ et pilote comptés comme un épisode chacun
const epKeyOf = q => q.film ? 'film' : q.inedit ? 'x' + q.inedit : q.part === 'dies' ? 'dies' : q.part === 'pil' ? 'p' + q.episode : `${q.livre}|${q.episode}`;
// Nombre d'épisodes où parle chaque personnage (film et inédits comptés comme un épisode chacun), calculé une fois
let epCache = null;
function charEpisodes() {
  if (epCache && epCache.src === allQuotes) return epCache.m;
  const sets = {};
  allQuotes.forEach(q => { (sets[q.name] = sets[q.name] || new Set()).add(epKeyOf(q)); });
  const m = {};
  for (const n in sets) m[n] = sets[n].size;
  epCache = { src: allQuotes, m };
  return m;
}
// Sous-titre de l'en-tête ; hors ligne, il le dit (sans bandeau ni fenêtre)
function setMast(t) {
  const el = document.getElementById('mast-sub');
  if (!el) return;
  el.dataset.t = t;
  const off = navigator.onLine === false;
  el.classList.remove('tight');
  el.innerHTML = `<span class="mt">${esc(t)}</span>` + (off ? ` <span class="off">${icon('offline')}<span class="ot">Hors ligne</span></span>` : '');
  // le grand titre passe avant : s'il ne tient pas à côté de la pastille, elle se réduit à son pictogramme (libellé gardé pour VoiceOver)
  if (off) { const mt = el.querySelector('.mt'); if (mt.scrollWidth > mt.clientWidth + 1) el.classList.add('tight'); }
  const ct = document.getElementById('mast-ct');
  if (ct) ct.textContent = t;
}
// Grand titre repliable (iOS) : un témoin de 8 px en haut de la zone qui défile ; dès qu'il sort, l'en-tête passe en
// barre compacte. IntersectionObserver seulement (aucun écouteur de défilement) ; sans lui, le grand titre reste.
// Zone suivie : la liste de l'écran (#main-content > .scroll), ou la page entière du quiz après la réponse (.qpage).
let mastIO = null, mastMO = null, mastSc = null;
function armMast() {
  const mast = document.getElementById('main-header'), main = document.getElementById('main-content');
  if (!mast || !main) return;
  if (!main.querySelector('#quiz-stage.answered, #quiz-stage.long')) main.classList.remove('qpage');
  const sc = main.classList.contains('qpage') ? main : main.querySelector(':scope > .scroll');
  let s = sc && sc.querySelector(':scope > .mast-sent');
  if (sc === mastSc && s) return;                              // déjà suivi
  mastIO?.disconnect(); mastMO?.disconnect(); mastIO = mastMO = null; mastSc = sc;
  if (!sc || !('IntersectionObserver' in window)) { mast.classList.remove('compact'); return; }
  if (!s) { s = document.createElement('i'); s.className = 'mast-sent'; s.setAttribute('aria-hidden', 'true'); sc.prepend(s); }
  mast.classList.toggle('compact', sc.scrollTop > 8);           // position restaurée : bon état d'emblée
  mastIO = new IntersectionObserver(es => mast.classList.toggle('compact', !es[es.length - 1].isIntersecting), { root: sc });
  mastIO.observe(s);
  // la liste est réécrite (résultats de Chercher) : le témoin disparu est remis
  mastMO = new MutationObserver(() => { if (!sc.querySelector(':scope > .mast-sent')) { mastSc = null; armMast(); } });
  mastMO.observe(sc, { childList: true });
}
function watchMast() {
  const main = document.getElementById('main-content');
  // un écran est rendu (ou sa liste réécrite, comme les résultats de Chercher) : on resuit la bonne zone
  new MutationObserver(() => armMast()).observe(main, { childList: true });
}
// Sous-titre de l'en-tête par vue (Personnages et Favoris : leur grand titre suffit)
const MAST = { quiz: 'Quiz', personnages: 'Personnages', recherche: 'Rechercher', favoris: 'Favoris' };
function mastFor(view) { return view === 'citations' ? (verifyMode ? 'Vérification' : 'Répliques') : MAST[view]; }
function refreshMast() { const el = document.getElementById('mast-sub'); if (el) setMast(el.dataset.t || el.textContent); }
// bouton rond Réglages de l'en-tête : sur l'écran Répliques seulement
function showMastSet() { const b = document.getElementById('mast-set'); if (b) b.hidden = !(currentView === 'citations' && allQuotes.length && document.getElementById('detail-overlay').classList.contains('hidden')); refreshSetBtn(); refreshScope(); refreshBack(); }
// Sélecteur de la sélection sous le grand titre (Répliques hors vérification, Quiz libre) ; #app.has-scope lui fait sa place.
// Une page superposée (fiche, scène) le cache sans changer la mise en page dessous.
let quizDaily = false;
function refreshScope() {
  const b = document.getElementById('mast-scope');
  if (!b) return;
  const on = !!allQuotes.length && ((currentView === 'citations' && !verifyMode) || (currentView === 'quiz' && !quizDaily));
  const ov = !document.getElementById('detail-overlay').classList.contains('hidden');
  document.getElementById('app').classList.toggle('has-scope', on);
  b.hidden = !on || ov;
  if (on) {
    const l = scopeLabel();
    const sl = b.querySelector('.sl');
    if (sl.textContent !== l) sl.textContent = l;
    b.setAttribute('aria-label', `Sélection : ${l}. Modifier`);
  }
}
// Clavier (iPad, ordinateur) : flèches gauche / droite pour changer de réplique
function onArrowKeys(e) {
  if (currentView !== 'citations' || sheetOpen() || !document.getElementById('detail-overlay').classList.contains('hidden')) return;
  if (e.target.matches?.('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); swipeForward(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); swipeBack(); }
}

// ===== FEUILLE (réglages, signalement) : vraie fenêtre modale =====
let sheetFocus = null;
function openSheet(html) {
  const sheet = document.getElementById('sheet'), back = document.getElementById('sheet-back');
  if (sheet.hidden) sheetFocus = document.activeElement;
  sheet.className = 'sheet';
  sheet.innerHTML = html;
  sheet.hidden = false; back.hidden = false;
  back.onclick = closeSheet;
  sheet.setAttribute('aria-labelledby', 'sh-title');
  document.getElementById('app').inert = true;
  const h = sheet.querySelector('h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  bindSheetGestures(sheet);
  navSoon();
  return sheet;
}
function closeSheet() {
  const sheet = document.getElementById('sheet');
  if (sheet.hidden) return;
  sheet.hidden = true;
  document.getElementById('sheet-back').hidden = true;
  sheet.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });   // la vidéo de la coupe se tait
  sheet.innerHTML = '';
  sheet.style.bottom = ''; sheet.style.maxHeight = '';
  document.getElementById('app').inert = false;
  if (sheetFocus?.isConnected) sheetFocus.focus({ preventScroll: true });
  sheetFocus = null;
  navSoon();
}
function sheetOpen() { return !document.getElementById('sheet').hidden; }
// glisser la feuille vers le bas (plus de 80 px) la ferme, depuis n'importe où tant qu'elle n'a pas défilé
let sheetSwipe = false;
function bindSheetGestures(sheet) {
  if (sheetSwipe) return;                         // écouteurs posés une seule fois (la feuille est réutilisée)
  sheetSwipe = true;
  let y0 = null;
  sheet.addEventListener('touchstart', e => { y0 = sheet.scrollTop <= 0 && !e.target.closest('textarea, .tl') ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener('touchend', e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 80) closeSheet(); y0 = null; }, { passive: true });
  sheet.addEventListener('scroll', refreshCaret, { passive: true });
}
// iOS (WebKit) ne redessine pas le curseur d'un champ qui bouge sous lui (feuille remontée au-dessus du clavier, feuille
// qui défile, note qui grandit) : le curseur restait à l'ancienne place. Reposer la sélection telle quelle le recalcule.
let caretFrame = 0;
function refreshCaret() {
  if (caretFrame) return;
  caretFrame = requestAnimationFrame(() => {
    caretFrame = 0;
    const el = document.activeElement;
    if (el && el.tagName === 'TEXTAREA' && el.closest('#sheet')) {
      try { el.setSelectionRange(el.selectionStart, el.selectionEnd, el.selectionDirection); } catch {}
    }
  });
}
// Clavier iOS : la feuille (position fixe en bas) remonte au-dessus du clavier tant qu'il est ouvert
function fitSheetToKeyboard() {
  const sheet = document.getElementById('sheet'), vv = window.visualViewport;
  if (sheet.hidden) return;
  const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  sheet.style.bottom = kb > 40 ? kb + 'px' : '';
  sheet.style.maxHeight = kb > 40 ? (vv.height - 12) + 'px' : '';
  refreshCaret();
}

// ===== RÉGLAGES =====
function mediaMode() { return videoOnly ? 'video' : audioOnly ? 'audio' : 'text'; }
// unité des nombres selon l'affichage : scènes (Vidéo), répliques avec son (Son), répliques (Texte)
function unitPlural(n) { return videoOnly ? plural(n, 'scène') : audioOnly ? plural(n, 'réplique avec son', 'répliques avec son') : plural(n, 'réplique'); }
function settingsHTML() {
  const m = mediaMode();
  // contrôle segmenté d'iOS : un bouton par valeur, coché ou non
  const seg = (lab, opts, off) => `<div class="seg" role="radiogroup" aria-label="${lab}"${off ? ' aria-disabled="true"' : ''}>${opts.map(([on, attrs, label]) =>
    `<button role="radio" class="${on ? 'on' : ''}" aria-checked="${on}" ${attrs}${off ? ' disabled' : ''}>${label}</button>`).join('')}</div>`;
  const { approx, others, texte } = verifyTodo;
  const tot = approx + others + texte;
  const todoTxt = !tot
    ? 'Tout est vérifié pour cette sélection, à vous tous.'
    : `Il en reste ${nf(tot)}${approx ? `, en commençant par ${plural(approx, 'son')} ${approx > 1 ? 'les' : 'le'} moins sûr${approx > 1 ? 's' : ''}` : ''}${texte ? `, et ${plural(texte, 'réplique')} sans son ni vidéo à la fin` : ''}.`;
  const P = verifyMode ? null : pool();
  const n = P ? P.length : allQuotes.length;
  return `
    <div class="grab" aria-hidden="true"></div>
    <div class="sh-nav"><span></span><h2 id="sh-title">Réglages</h2><button class="r" id="sheet-close">OK</button></div>
    <p class="gh">Sélection</p>
    <div class="g"><button class="gr" id="row-sel" aria-haspopup="dialog"><span class="k">Épisodes</span><span class="v">${esc(scopeLabel())}</span>${icon('chev', 'chev')}</button></div>
    <p class="gh">Affichage</p>
    <div class="g"><div class="gr${verifyMode ? ' dis' : ''}">${seg('Affichage', [[m === 'text', 'id="chip-text"', 'Texte'], [m === 'audio', 'id="chip-audio-only"', 'Son']]
      .concat(videoIdx.length ? [[m === 'video', 'id="chip-video-only"', 'Vidéo']] : []), verifyMode)}</div></div>
    <p class="gf">Vidéo montre la scène et ne garde que les répliques qui en ont. Chaque scène se télécharge à l’affichage (30 à 650 Ko).</p>
    <p class="gh">Lecture</p>
    <div class="g"><button class="gr${verifyMode ? ' dis' : ''}" id="sw-auto" role="switch" aria-checked="${autoPlay}" data-auto="${autoPlay ? 0 : 1}"${verifyMode ? ' disabled' : ''}><span class="k">Lecture auto<small>Le son part dès qu’une réplique s’affiche</small></span><span class="sw" aria-hidden="true"></span></button></div>
    <p class="gf" role="status">${verifyMode ? 'Affichage et lecture auto sont suspendus pendant la vérification.'
      : n ? `<b>${unitPlural(n)}</b> ${n > 1 ? 'correspondent' : 'correspond'}.` : 'Aucune réplique ne correspond.'}</p>
    <p class="gh">Partage</p>
    <div class="g"><div class="gr">${seg('Partager', [[shareMode === 'extrait', 'data-share="extrait"', 'Extrait'], [shareMode === 'texte', 'data-share="texte"', 'Texte'], [shareMode === 'deux', 'data-share="deux"', 'Les deux']])}</div></div>
    <p class="gf">${shareMode === 'texte' ? 'Partager envoie la réplique écrite, avec le personnage et l’épisode.'
      : shareMode === 'deux' ? 'Partager envoie la scène (ou le son) et la réplique écrite. Certaines messageries en font deux messages.'
      : 'Partager envoie la scène, ou le son pour une réplique sans scène. Sans fichier possible, la réplique écrite part à la place.'}</p>
    <p class="gh">Contribuer</p>
    <div class="g"><button class="gr act${verifyMode ? ' on' : ''}" id="chip-verify"><span class="k">${verifyMode ? 'Quitter la vérification' : 'Vérifier les sons et les scènes'}</span>${icon('chev', 'chev')}</button></div>
    <p class="gf">Écouter, regarder, signaler ce qui cloche. ${todoTxt}</p>
    <p class="gh">Confidentialité</p>
    <p class="gf">Favoris et réglages restent sur cet appareil. Les avis de vérification partent sans nom ni adresse, seulement pour corriger les extraits. Les sons et les scènes viennent de Hugging Face, qui voit l’adresse IP de l’appareil, comme tout site.</p>`;
}
function openSettings() {
  const sheet = openSheet(settingsHTML());
  bindSettings(sheet);
}
// l'écran derrière la feuille suit tout de suite : nouvelle réplique si la courante sort du pool, écran vide si plus rien
function refreshBehind() {
  if (currentView === 'quiz') { refreshScope(); return; }          // le quiz change à la question suivante
  if (currentView !== 'citations') return;
  const P = pool();
  if (P && P.length && !P.includes(quoteIdx)) randomQuote(); else renderCitations();
}
function refreshAfterSetting(focusSel) {
  refreshBehind();
  const sheet = document.getElementById('sheet');
  const y = sheet.scrollTop;
  sheet.innerHTML = settingsHTML();
  sheet.scrollTop = y;
  bindSettings(sheet);
  const f = focusSel && sheet.querySelector(focusSel);
  (f || sheet.querySelector('h2'))?.focus({ preventScroll: true });
}
function bindSettings(sheet) {
  sheet.className = 'sheet';
  sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
  sheet.querySelector('#row-sel').addEventListener('click', () => showSelection('settings'));
  const setMedia = m => {
    setMediaPref(m);
    nextRand = null;
    refreshAfterSetting({ text: '#chip-text', audio: '#chip-audio-only', video: '#chip-video-only' }[m]);
  };
  sheet.querySelector('#chip-text').addEventListener('click', () => setMedia('text'));
  sheet.querySelector('#chip-audio-only').addEventListener('click', () => setMedia('audio'));
  sheet.querySelector('#chip-video-only')?.addEventListener('click', () => setMedia('video'));
  sheet.querySelectorAll('[data-share]').forEach(b => b.addEventListener('click', () => {
    shareMode = b.dataset.share; writeStr('kaam_share', shareMode);
    refreshAfterSetting(`[data-share="${shareMode}"]`);
  }));
  sheet.querySelectorAll('[data-auto]').forEach(b => b.addEventListener('click', () => {
    autoPlay = b.dataset.auto === '1'; writePref('kaam_autoplay', autoPlay);
    refreshAfterSetting('#sw-auto');
  }));
  sheet.querySelector('#chip-verify').addEventListener('click', () => {
    verifyMode = !verifyMode; writePref('kaam_verify', verifyMode);
    rebuildVerify(); nextRand = null; loadAvisTous(true); resetHistory();
    refreshAfterSetting('#chip-verify');
    refreshScope();
  });
}

// ===== FEUILLE « SÉLECTION » : cases rondes, nombres selon l'affichage, total en direct =====
// Ouverte depuis le sélecteur sous le titre (from = 'scope') ou depuis Réglages › Épisodes (from = 'settings' : « ‹ Réglages »).
const PART_GROUPS = [['Série', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']], ['Film', ['film']], ['Inédits', ['in1', 'in2', 'in3']], ['Avant la série', ['dies', 'pil']]];
function partLabel(id) {
  if (id[0] === 'L') return `Livre ${ROM[+id[1] - 1]}`;
  if (id === 'film') return 'Kaamelott : Premier Volet';
  if (id === 'dies') return 'Dies Iræ, court métrage';
  if (id === 'pil') return 'Épisodes pilotes';
  const q = allQuotes.find(x => x.part === id);
  return q ? q.inedit : `Inédit ${id[2]}`;
}
function selectionHTML(from) {
  const c = partCounts(), k = unitKey(), unitLab = { v: 'scènes', a: 'répliques avec son', t: 'répliques' }[k];
  const ck = on => `<span class="ck${on ? ' on' : ''}" aria-hidden="true">${on ? icon('check') : ''}</span>`;
  const row = id => {
    const on = sel.includes(id), n = c[id][k], none = !n;
    const lab = partLabel(id);
    return `<button class="gr${none ? ' off' : ''}" role="checkbox" aria-checked="${on}" data-part="${id}" aria-label="${esc(typoPlain(lab))}, ${none ? 'aucune ' + (k === 'v' ? 'scène' : k === 'a' ? 'réplique avec son' : 'réplique') : unitPlural(n)}">${ck(on)}`
      + `<span class="k">${typo(lab)}${none && c[id].t ? '<small>Jamais tourné · texte seul</small>' : ''}</span>${none ? '' : `<span class="n">${nf(n)}</span>`}</button>`;
  };
  const all = selAll(), total = selCount(), books = PART_GROUPS[0][1], allBooks = books.every(id => sel.includes(id));
  const grand = PART_IDS.reduce((n, id) => n + c[id][k], 0);
  const zero = sel.filter(id => !c[id][k]).map(partLabel).map(l => l.replace(/ :.*/, ''));
  const what = k === 'v' ? 'Vidéo' : 'Son';
  const foot = !sel.length ? ['Aucune sélection', 'Cochez au moins un élément.', true]
    : !total ? [k === 'v' ? 'Aucune scène' : 'Aucun son', `Rien à montrer en ${what}. Ajoutez un Livre, ou passez en Texte.`, true]
    : zero.length && k !== 't' ? [unitPlural(total), `${zero.join(', ')} se ${zero.length > 1 ? 'lisent' : 'lit'} en Texte seulement.`, true]
    : [unitPlural(total), scopeLabel(), false];
  return `
    <div class="grab" aria-hidden="true"></div>
    <div class="sh-nav">${from === 'settings' ? `<button class="l" id="sel-back">${icon('chev-l', 'bk')}Réglages</button>` : '<span></span>'}<h2 id="sh-title">Sélection</h2><button class="r" id="sheet-close">OK</button></div>
    <div class="g ckl first"><button class="gr" role="checkbox" aria-checked="${all}" data-part="all" aria-label="Tout Kaamelott, ${unitPlural(grand)}">${ck(all)}<span class="k">Tout Kaamelott</span><span class="n">${nf(grand)}</span></button></div>
    ${PART_GROUPS.map(([g, ids], j) => `<p class="gh">${g}${j === 0 ? `<button id="sel-books">${allBooks ? 'Aucun Livre' : 'Tous les Livres'}</button>` : ''}</p>
    <div class="g ckl">${ids.map(row).join('')}</div>`).join('')}
    <p class="gf">Les nombres comptent ${{ v: 'les répliques avec scène (affichage Vidéo)', a: 'les répliques avec son (affichage Son)', t: 'toutes les répliques (affichage Texte)' }[k]}.</p>
    <div class="foot" role="status" id="sel-foot"><b>${esc(foot[0])}</b><span${foot[2] ? ' class="warn"' : ''}>${typo(foot[1])}</span></div>`;
}
// apostrophes droites → courbes, sans HTML (libellés VoiceOver)
function typoPlain(s) { return String(s).replace(/'/g, '’'); }
function showSelection(from) {
  const sheet = document.getElementById('sheet');
  const render = focus => {
    const y = sheet.hidden ? 0 : sheet.scrollTop;
    if (sheet.hidden) openSheet(selectionHTML(from)); else { sheet.innerHTML = selectionHTML(from); sheet.querySelector('h2')?.setAttribute('tabindex', '-1'); }
    sheet.className = 'sheet selsheet';
    sheet.scrollTop = y;
    const f = focus && sheet.querySelector(focus);
    (f || sheet.querySelector('h2'))?.focus({ preventScroll: true });
    sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
    sheet.querySelector('#sel-back')?.addEventListener('click', () => {
      sheet.innerHTML = settingsHTML(); sheet.scrollTop = 0; bindSettings(sheet);
      sheet.querySelector('#row-sel')?.focus({ preventScroll: true });
    });
    sheet.querySelector('#sel-books').addEventListener('click', () => {
      const books = PART_GROUPS[0][1], on = books.every(id => sel.includes(id));
      change(on ? sel.filter(id => !books.includes(id)) : sel.concat(books), '#sel-books');
    });
    sheet.querySelectorAll('[data-part]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.part;
      const next = id === 'all' ? (selAll() ? [] : PART_IDS.slice()) : sel.includes(id) ? sel.filter(x => x !== id) : sel.concat(id);
      change(next, `[data-part="${id}"]`);
    }));
  };
  const change = (next, focus) => {
    sel = PART_IDS.filter(id => next.includes(id));
    saveSel(); poolCache.clear(); rebuildVerify(); nextRand = null;
    render(focus);
    refreshBehind();
    refreshScope();
  };
  render();
}

// ===== RÉPLIQUES =====
// Plafonds du corps de la réplique quand une scène occupe le haut de l'écran (ailleurs, fitQuote calcule le corps)
const Q_MAX = { video: 26, videoSE: 21, quiz: 28, quizSE: 22, scene: 28 };
const fitMemo = new Map();      // taille trouvée par fitQuote, par réplique et par place disponible
// Corps de la réplique calculé sur la place réelle de la pochette : le texte en occupe au moins les deux tiers, jamais plus
// petit que le barème quoteSize() sauf pour tenir ; au-delà du plancher, la réplique défile dans la pochette.
function fitQuote(card, qt, qb, q) {
  const avail = qb.clientHeight;
  const key = `${q.i}|${card.clientWidth}x${avail}|${textScale()}`;
  const set = fs => { qt.style.fontSize = fs + 'px'; };
  if (fitMemo.has(key)) { set(fitMemo.get(key)); return; }
  const small = innerWidth < 360 || innerHeight < 620, k = textScale();
  const MAX = Math.round((small ? 36 : 46) * Math.max(1, k)), MIN = Math.round((small ? 17 : 19) * k);
  const fit = r => {
    let lo = MIN, hi = MAX; set(hi);
    if (qt.offsetHeight <= avail * r) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; set(m); if (qt.offsetHeight <= avail * r) lo = m; else hi = m; }
    return lo;
  };
  let fs = Math.max(fit(.62), Math.min(Math.round(quoteSize(q.quote) * 1.12 * k), fit(.97)));
  // grand texte (Dynamic Type) : jamais un mot coupé au milieu (« Dépêch / ez-vous ») ; les 3 plus longs doivent tenir sur une ligne
  const mots = q.quote.split(/\s+/).sort((a, b) => b.length - a.length).slice(0, 3);
  const mesure = document.createElement('span');
  mesure.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
  qt.appendChild(mesure);
  set(fs);
  while (fs > MIN && mots.some(m => { mesure.textContent = m; return mesure.offsetWidth > qt.clientWidth; })) set(--fs);
  mesure.remove();
  fitMemo.set(key, fs);
}
// Taille du texte choisie dans iOS (Réglages › Luminosité › Taille du texte) : 1 = taille par défaut (17 px)
function textScale() {
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 17;
  return Math.min(1.6, Math.max(.85, fs / 17));
}
// « Touchez ou glissez » : seulement sur les 3 premières répliques montrées (compte mémorisé sur l'appareil)
function hintCount() { return +readStr('kaam_hint', 0) || 0; }
function countHint() { writeStr('kaam_hint', hintCount() + 1); }
let firstRender = true;
// Aléatoire ↔ Dans l'ordre : bouton de l'écran Répliques (vérification ou non), plus dans les Réglages
function setOrder(seq) {
  inOrder = seq; writePref('kaam_in_order', inOrder); nextRand = null;
  // retour en Aléatoire : la réplique atteinte dans l'ordre entre dans l'historique (« Retour » ramène à la précédente vue)
  if (!inOrder && randHistory[randPos] !== quoteIdx) pushHistory(quoteIdx);
}
// Données de l'écran Répliques (aucun effet sur la page, sauf le compteur de l'aide)
function citationsModel(q) {
  const P = pool();
  // rang de la réplique dans le parcours, en aléatoire comme dans l'ordre. Réplique ouverte exprès hors du parcours
  // (recherche, favoris) : pas de rang (jamais « 0 sur … »), on dit pourquoi elle n'en a pas
  const rank = P ? P.indexOf(quoteIdx) : quoteIdx;
  const counter = verifyMode
    ? verifyCounter()
    : rank < 0 ? (!inSel(q) ? 'Hors sélection' : videoOnly ? 'Sans vidéo' : audioOnly ? 'Sans son' : 'Hors sélection')
    : P ? `${nf(rank + 1)} sur ${nf(P.length)}${videoOnly ? ' avec vidéo' : audioOnly ? ' avec son' : ''}` : `${nf(quoteIdx + 1)} sur ${nf(allQuotes.length)}`;
  const summary = verifyMode
    ? ['Tout vérifier', plural(verifyIdx.length, 'restante'), selAll() ? '' : esc(scopeLabel())].filter(Boolean).join(SEP)
    : [{ text: 'Texte', audio: 'Son', video: 'Vidéo' }[mediaMode()], autoPlay ? 'Lecture auto' : '']
        .filter(Boolean).join(SEP);
  const inlineVideo = !!((videoOnly || verifyMode) && q.video);
  // l'aide n'est jamais dans la carte : une ligne discrète dessous, sur les 3 premières répliques
  const hint = !verifyMode && !inlineVideo && hintCount() < 3 ? (inOrder ? 'Touchez ou glissez pour la suivante' : 'Touchez ou glissez pour changer') : '';
  if (hint) countHint();
  return {
    counter, summary, inlineVideo, hint,
    reviewable: verifyMode,
    // réplique déjà classée (ouverte depuis Rechercher, ou par un autre pendant qu'on la regarde) : on le dit, plus de OK
    deja: verifyMode && dejaVue(q),
    couper: verifyMode && peutCouper(q),
    fav: isFav(q),
    what: q.audio && q.video ? 'Son et vidéo OK' : q.video ? 'Vidéo OK' : q.audio ? 'Son OK' : 'Texte OK',
    no: String(q.i + 1).padStart(5, '0').replace(/^(\d{2})/, '$1 '),   // « 03 345 », espace fine
    atStart: !inOrder && randPos <= 0,
    // ce que dit la barre de lecture (vérification seulement) ; une réplique sans son n'a ni barre ni libellé
    badge: verifyMode && q.audio && q.approx ? 'Son estimé' : '',
  };
}
// Bouton lecture du son : pictogramme lecture / pause, libellé pour VoiceOver (« Réessayer » après un échec).
// Sans son : rien (ce qui n'existe pas est masqué, jamais grisé).
function listenHTML(q, cls = 'tp') {
  return q.audio
    ? `<button class="${cls}" id="btn-audio">${icon('play', 'i-pl')}${icon('pause', 'i-pa')}<span class="lp">Écouter</span><span class="ls">Arrêter</span></button>`
    : '';
}
// Réglages autres que ceux par défaut et invisibles à l'écran : un point sur le bouton Réglages (et dans son libellé pour VoiceOver).
// La sélection n'en fait pas partie : elle est écrite sous le titre.
function activeFilters() {
  return [{ text: 'Texte', audio: 'Son', video: '' }[mediaMode()], autoPlay ? 'Lecture auto' : ''].filter(Boolean);
}
function refreshSetBtn() {
  const b = document.getElementById('mast-set');
  if (!b) return;
  const f = verifyMode ? ['Vérification'] : activeFilters();
  b.classList.toggle('dot', f.length > 0);
  b.setAttribute('aria-label', f.length ? `Réglages (${f.join(', ')})` : 'Réglages');
}
// Bouton Aléatoire / Dans l'ordre (écran Répliques, vérification comprise) : montre le mode en cours, le touche bascule
// (icône seule en vérification, faute de place à côté de « Passer »)
const orderBtnHTML = () => `<button class="vord${verifyMode ? ' ico' : ''}" id="btn-order" aria-label="Ordre : ${inOrder ? 'dans l’ordre' : 'aléatoire'}">${icon(inOrder ? 'order' : 'shuffle')}<span${verifyMode ? ' class="lab"' : ''}>${inOrder ? 'Dans l’ordre' : 'Aléatoire'}</span></button>`;
// bascule sur place : ni la scène ni le son ne repartent, VoiceOver ne relit pas la réplique
function toggleOrder() {
  setOrder(!inOrder);
  const $ = id => document.getElementById(id);
  const b = $('btn-order'); b.outerHTML = orderBtnHTML(); $('btn-order').addEventListener('click', toggleOrder); $('btn-order').focus({ preventScroll: true });
  const prev = $('btn-prev'), next = $('btn-next');
  if (prev) {
    prev.disabled = !inOrder && randPos <= 0;
    prev.setAttribute('aria-label', inOrder ? 'Réplique précédente' : 'Revenir à la réplique précédente'); prev.querySelector('span').textContent = inOrder ? 'Précédente' : 'Retour';
  }
  if (next) { next.setAttribute('aria-label', inOrder ? 'Réplique suivante' : 'Autre réplique'); next.querySelector('span').textContent = inOrder ? 'Suivante' : 'Autre'; }
  nextRand = null; prefetchAround();
}
// Gabarit de l'écran Répliques : la carte (photo floutée du personnage, ou fond neutre), le nom, la lecture, la navigation
function citationsHTML(q, m, dir) {
  const size = Math.round(Math.min(quoteSize(q.quote), innerWidth < 360 || innerHeight < 620 ? Q_MAX.videoSE : Q_MAX.video) * textScale());
  const photo = !m.inlineVideo && !q.acteur && persoURL(q.name, 's');
  const playable = !!(q.audio || m.inlineVideo);
  // outils : l'ordre (Aléatoire / Dans l'ordre), puis en glyphes seuls Scène (si elle existe) et Partager
  const tools = [
    orderBtnHTML(),
    q.video && !m.inlineVideo ? `<button class="tool" id="btn-video" aria-label="Voir la scène">${icon('film')}</button>` : '',
    `<button class="tool" id="btn-share" aria-label="Partager">${icon('share')}<span class="t">Partager</span></button>`,
  ].join('');
  const foot = [m.counter, m.hint].filter(Boolean).join(' · ');
  return `
    ${verifyMode ? `<button class="bar verify" id="btn-settings"><span class="bar-sum">${m.summary}</span>${icon('chev', 'chev')}</button>` : ''}
    ${m.inlineVideo ? sceneHTML(q, 'qvideo-slot') : ''}
    <div class="stage ${m.inlineVideo ? 'plain' : 'art'}${photo ? ' photo' : ''} swap-in${dir < 0 ? ' swap-back' : dir > 0 ? '' : ' rand'}" id="quote-card">
      ${photo ? `<span class="bgimg img" aria-hidden="true"><img src="${photo}" alt="" decoding="async"></span>` : ''}
      <div class="qblock">
        <blockquote class="quote" lang="fr"${m.inlineVideo ? ` style="font-size:${size}px" data-fs0="${size}"` : ''}>${quoteHTML(q.quote)}</blockquote>
      </div>
    </div>
    <div class="meta">
      <div class="who-b"><button class="who" id="btn-who" aria-label="${esc(nameCase(q.name))}, voir la fiche du personnage">${esc(nameCase(q.name))}</button>
        ${fmtEp(q) ? `<p class="src">${epHTML(q)}</p>` : ''}${byHTML(q)}</div>
      ${verifyMode ? `${m.couper ? `<button class="ic" id="btn-coupe" aria-label="Ajuster la coupe">${icon('cut')}</button>` : ''}${q.video ? `<button class="ic" id="btn-video" aria-label="Scène en grand">${icon('film')}</button>` : ''}<button class="ic" id="btn-share" aria-label="Partager">${icon('share')}<span class="t lab">Partager</span></button>` : ''}
      ${favCellHTML(q, m.fav)}
    </div>
    <div class="scrub${playable ? '' : ' none'}" id="scrub" aria-hidden="true"><div class="track"><i></i></div><span class="badge" data-t="${m.badge}"${m.badge ? '' : ' hidden'}>${m.badge}</span></div>
    ${verifyMode ? `
      ${m.reviewable ? `<div class="vrow">${listenHTML(q, 'tp sm')}${m.deja ? `<span class="vdone" id="avis-deja" role="img" aria-label="${dejaLabel(q)[1]}">${icon('check')}<span>${dejaLabel(q)[0]}</span></span>` : `<button class="ok" id="avis-ok">${icon('check')}<span>${m.what}</span></button>`}<button class="ko" id="avis-ko">Problème</button></div>` : ''}
      <div class="vfoot"><div class="stage-foot vf"><button class="vback" id="v-back" aria-label="Revenir à la réplique précédente"${randPos > 0 ? '' : ' disabled'}>${icon('chev-l')}</button><span class="quote-counter">${m.counter}</span><span class="vgo">${orderBtnHTML()}${m.reviewable ? `<button class="skip" id="avis-skip">Passer</button>` : ''}</span></div><div class="done-slot"></div></div>`
    : `
      <div class="transport">
        <button class="ts" id="btn-prev" aria-label="${inOrder ? 'Réplique précédente' : 'Revenir à la réplique précédente'}"${m.atStart ? ' disabled' : ''}>${icon('chev-l')}<span>${inOrder ? 'Précédente' : 'Retour'}</span></button>
        ${m.inlineVideo ? `<button class="tp" id="btn-replay" aria-label="Revoir la scène">${icon('replay')}</button>` : listenHTML(q) || '<span class="tp-x"></span>'}
        <button class="ts" id="btn-next" aria-label="${inOrder ? 'Réplique suivante' : 'Autre réplique'}"><span>${inOrder ? 'Suivante' : 'Autre'}</span>${icon('chev')}</button>
      </div>
      <div class="tools">${tools}</div>
      ${foot ? `<div class="stage-foot"><span class="quote-counter">${esc(foot)}</span></div>` : ''}`}`;
}
// Boutons de l'écran Répliques ; lance la scène dans la carte et le son en lecture auto (dans le geste)
function bindCitations(q, m, keep) {
  const $ = id => document.getElementById(id);
  $('btn-settings')?.addEventListener('click', openSettings);
  $('btn-who').addEventListener('click', e => { e.stopPropagation(); openPersonnage(q.name); });
  $('btn-fav').addEventListener('click', () => favButton($('btn-fav'), q));
  $('btn-share').addEventListener('click', () => shareQuote(q, $('btn-share')));
  if (m.reviewable) {
    $('avis-ok')?.addEventListener('click', () => recordAvis(q, true, [], ''));
    $('btn-coupe')?.addEventListener('click', () => openCoupe(q));
    $('avis-ko').addEventListener('click', () => openProblem(q));
    $('avis-skip')?.addEventListener('click', () => swipeForward());
  } else if (!verifyMode) {
    // en aléatoire, les boutons font comme les gestes (historique) ; dans l'ordre, voisines dans le corpus
    $('btn-prev').addEventListener('click', () => swipeBack());
    $('btn-next').addEventListener('click', () => swipeForward());
  }
  $('v-back')?.addEventListener('click', () => historyBack());
  $('btn-order').addEventListener('click', toggleOrder);
  refreshSetBtn();
  const fig = $('qvideo-slot');
  if (fig) { bindScene(fig, cardVideo); playCardVideo(q, fig); }
  else cardVideo.pause();
  prefetchAround();
  $('btn-video')?.addEventListener('click', () => showVideo(q));
  $('btn-replay')?.addEventListener('click', () => replayVideo(cardVideo));
  const audioBtn = $('btn-audio');
  if (audioBtn) {
    audioBtn.addEventListener('click', () => playAudio(q.audio, audioBtn, q));
    // son venu du mini-lecteur pour cette réplique : il continue, le bouton le reprend
    if (keep) { setPlayingBtn(audioBtn); audioBtn.classList.remove('wait'); }
    // Lecture auto : renderCitations est appelé dans le geste (tap/swipe/bouton), donc le navigateur l'autorise
    else if (autoPlay && !m.inlineVideo) playAudio(q.audio, audioBtn, q);
  }
}
// La réplique continue plus bas : la pochette s'arrête sur une ligne entière (jamais une ligne tranchée à mi-hauteur),
// la dernière ligne visible s'efface et « Suite ↓ » a sa propre ligne dessous. Une fois en bas : plus de fondu.
function snapLines(qb) {
  const qt = qb.querySelector('.quote');
  if (!qt) return;
  const lh = parseFloat(getComputedStyle(qt).lineHeight);
  if (!(lh > 0)) return;
  qb.style.flex = ''; qb.style.height = '';
  const n = Math.floor(qb.clientHeight / lh);
  if (n < 1) return;
  qb.style.setProperty('--lh', (n >= 2 ? lh : 0) + 'px');   // une seule ligne visible : elle reste nette
  qb.style.flex = '0 0 auto';
  qb.style.height = Math.floor(n * lh) + 'px';
}
function fitOverflow(card) {
  if (!card.isConnected) return;          // carte déjà remplacée par un rendu plus récent
  const qb = card.querySelector('.qblock');
  const over = qb.scrollHeight > qb.clientHeight + 4;
  let h = qb.nextElementSibling?.classList.contains('more-h') ? qb.nextElementSibling : null;
  if (over && !h) { qb.insertAdjacentHTML('afterend', '<p class="more-h" aria-hidden="true">Suite ↓</p>'); h = qb.nextElementSibling; snapLines(qb); }
  const more = over && qb.scrollTop + qb.clientHeight < qb.scrollHeight - 4;
  qb.classList.toggle('ovf', more);
  h?.classList.toggle('done', !more);
}
// Taille du texte calculée sur la place réelle (puis recalculée une fois les polices chargées)
function fitCard(card, q, inlineVideo) {
  if (inlineVideo) {
    const qt = card.querySelector('.quote'), qb = card.querySelector('.qblock');
    let fs = parseFloat(qt.style.fontSize) || 22;
    const min = Math.round(17 * textScale());
    while (fs > min && qt.offsetHeight > qb.clientHeight + 1) { fs--; qt.style.fontSize = fs + 'px'; }
  } else {
    const go = () => fitQuote(card, card.querySelector('.quote'), card.querySelector('.qblock'), q);
    go();
    if (firstRender && document.fonts?.ready) document.fonts.ready.then(() => {
      fitMemo.clear();
      if (card.isConnected) { go(); fitOverflow(card); }
    });
  }
  firstRender = false;
  requestAnimationFrame(() => fitOverflow(card));
}
// La place change sans nouveau rendu (rotation, barre d'adresse d'Android qui apparaît ou disparaît, mini-lecteur, fenêtre) :
// la carte ou le quiz sont remesurés sur la nouvelle place (hauteur figée par snapLines et « Suite ↓ » retirés)
let refitT = null, refitWH = '';
function refitMain() {
  const main = document.getElementById('main-content');
  const wh = `${main.clientWidth}x${main.clientHeight}`;
  if (wh === refitWH) return;
  refitWH = wh;
  refreshMast();                                        // « Hors ligne » : pastille réduite ou non selon la largeur
  const card = document.getElementById('quote-card');
  if (card && currentView === 'citations') {
    const q = allQuotes[quoteIdx], qb = card.querySelector('.qblock'), qt = card.querySelector('.quote');
    if (!q || !qb || !qt) return;
    fitMemo.clear();
    qb.style.flex = ''; qb.style.height = ''; qb.style.removeProperty('--lh');
    qb.nextElementSibling?.classList.contains('more-h') && qb.nextElementSibling.remove();
    qb.classList.remove('ovf');
    const inline = !!document.getElementById('qvideo-slot');
    if (inline && qt.dataset.fs0) qt.style.fontSize = qt.dataset.fs0 + 'px';
    fitCard(card, q, inline);
    fitOverflow(card);                                  // tout de suite (fitCard le refait à l'image suivante)
  } else if (currentView === 'quiz') fitQuiz(document.getElementById('quiz-stage'));
}
function watchResize() {
  const main = document.getElementById('main-content');
  if (!('ResizeObserver' in window)) { addEventListener('resize', () => { clearTimeout(refitT); refitT = setTimeout(refitMain, 120); }); return; }
  new ResizeObserver(() => { clearTimeout(refitT); refitT = setTimeout(refitMain, 120); }).observe(main);
}
// Toucher la carte = suivante ; glisser horizontalement = suivante / précédente (le défilement vertical reste libre) ;
// toucher long = écouter (le son part au relâcher, donc dans le geste : iOS l'autorise)
const LONG_PRESS = 450;
function bindCardGestures(card) {
  let lastScroll = 0, lastLong = 0, pressT = null;
  const qb = card.querySelector('.qblock');
  qb.addEventListener('scroll', () => { lastScroll = Date.now(); fitOverflow(card); }, { passive: true });
  card.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (Date.now() - lastLong < 700) return;                // fin d'un toucher long : le son, pas la suivante
    if (getSelection().toString().length) return;           // on sélectionnait du texte pour le copier
    if (Date.now() - lastScroll < 250) return;              // on faisait défiler une réplique longue
    swipeForward();
  });
  card.addEventListener('contextmenu', e => { if (document.getElementById('btn-audio')) e.preventDefault(); });
  let sx = 0, sy = 0, st = 0, moved = false;
  const unpress = () => { clearTimeout(pressT); card.classList.remove('press'); };
  card.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); moved = false;
    unpress();
    if (document.getElementById('btn-audio')) pressT = setTimeout(() => card.classList.add('press'), LONG_PRESS);
  }, { passive: true });
  card.addEventListener('touchmove', e => {
    const dx = Math.abs(e.touches[0].clientX - sx), dy = Math.abs(e.touches[0].clientY - sy);
    if (dx > 10 || dy > 10) { moved = true; unpress(); }
    if (dx > dy && dx > 8) e.preventDefault();
  }, { passive: false });
  card.addEventListener('touchcancel', unpress, { passive: true });
  card.addEventListener('touchend', e => {
    unpress();
    const dx = sx - e.changedTouches[0].clientX, dy = Math.abs(sy - e.changedTouches[0].clientY);
    const audio = document.getElementById('btn-audio');
    if (!moved && audio && Date.now() - st >= LONG_PRESS) { lastLong = Date.now(); audio.click(); return; }
    const fast = Date.now() - st < 250 && Math.abs(dx) > 30;
    if ((Math.abs(dx) > 50 || fast) && Math.abs(dx) > dy) { if (dx > 0) swipeForward(); else swipeBack(); }
  }, { passive: true });
}
let showAnyway = false;   // réplique ouverte exprès (recherche, favoris, fiche) : montrée même hors de la sélection
function renderCitations(dir = 0) {
  const main = document.getElementById('main-content');
  if (!allQuotes.length) return;
  refreshScope();                                                      // avant le rendu : la carte se mesure à sa vraie place
  const forced = showAnyway; showAnyway = false;
  if (verifyMode && !verifyIdx.length && !forced) { renderVerifyDone(); return; }   // tout est vérifié : on s'arrête (sauf réplique cherchée)
  if (!verifyMode && !forced && poolEmpty()) { renderEmptySel(); return; }
  const fid = main.contains(document.activeElement) ? document.activeElement.id : '';
  if (!allQuotes[quoteIdx]) quoteIdx = pickRandom();          // index périmé (filtres, données changées)
  if (randPos < 0) pushHistory(quoteIdx);                     // historique repris à zéro : il part de la réplique affichée
  const q = allQuotes[quoteIdx];
  // le son de cette réplique joue déjà (mini-lecteur) : il continue ; sinon tout s'arrête
  const keep = !!audioQ && audioQ.i === q.i && !player.paused && !player.ended && !verifyMode;
  if (keep) stopVideos(); else stopAudio();
  setMast(verifyMode ? 'Vérification' : 'Répliques');
  const m = citationsModel(q);
  main.innerHTML = citationsHTML(q, m, dir);
  bindCitations(q, m, keep);
  const card = document.getElementById('quote-card');
  fitCard(card, q, m.inlineVideo);
  bindCardGestures(card);
  tickScrub();
  renderMini();
  // VoiceOver : la nouvelle réplique est annoncée (pas au premier affichage), le focus reste sur le bouton touché
  if (announceNext) document.getElementById('sr-live').textContent = `${nameCase(q.name)} : ${q.quote.slice(0, 280)}`;
  announceNext = true;
  showDoneLine();
  const f = fid && document.getElementById(fid);
  if (f && !f.disabled) f.focus({ preventScroll: true });
}

// Sélection sans rien à montrer : un écran vide qui dit pourquoi et propose la sortie (jamais une réplique hors sélection)
function renderEmptySel() {
  stopAudio();
  setMast('Répliques');
  const main = document.getElementById('main-content');
  const onlyIn3 = sel.length === 1 && sel[0] === 'in3';
  const modify = `<button class="pill gray" id="empty-sel">Modifier la sélection</button>`;
  const asText = `<button class="pill" id="empty-text">Lire en Texte</button>`;
  const [ic, title, txt, btns] = !sel.length
    ? ['quote', 'Aucune sélection', 'Choisissez au moins un Livre, le film ou un inédit.', '<button class="pill" id="empty-sel">Choisir</button>']
    : videoOnly
    ? ['film', 'Aucune scène', onlyIn3 ? `${typo(partLabel('in3'))} n’a jamais été tourné. Ses ${plural(partCounts().in3.t, 'réplique')} se lisent en Texte.` : 'Aucune réplique de cette sélection n’a de scène.', asText + modify]
    : ['play', 'Aucun son', 'Aucune réplique de cette sélection n’a de son.', asText + modify];
  main.innerHTML = `<div class="empty sel0"><span class="ei">${icon(ic)}</span><b role="status">${title}</b>${txt}<div class="col2">${btns}</div></div>`;
  document.getElementById('empty-sel').addEventListener('click', () => showSelection('scope'));
  document.getElementById('empty-text')?.addEventListener('click', () => { setMediaPref('text'); nextRand = null; randomQuote(); refreshSetBtn(); });
  refreshSetBtn();
  renderMini();
}

// ===== AVIS DE VÉRIFICATION =====
// listes à cocher, comme dans Réglages d'iOS : Son, Scène, Texte (identifiants d'avis inchangés ; la liste des
// identifiants admis est aussi dans api/avis.js). Sans son : une seule case, « Le son manque ».
const PB_LISTS = [
  ['audio', 'Son', [['son_faux', 'Pas le bon son'], ['son_debut_coupe', 'Début coupé'], ['son_coupe', 'Coupé avant la fin'],
    ['son_deborde_avant', 'Déborde sur la réplique d’avant'], ['son_deborde', 'Déborde sur la suite'],
    ['son_generique', 'Générique dedans (avant ou après)'], ['son_bruit', 'Musique ou bruit par-dessus']]],
  ['sans_audio', 'Son', [['son_absent', 'Le son manque']]],
  ['video', 'Scène', [['video_fausse', 'Pas la bonne scène'], ['video_debut_coupe', 'Début coupé'], ['video_coupee', 'Coupée avant la fin'],
    ['video_deborde_avant', 'Déborde sur la réplique d’avant'], ['video_deborde', 'Déborde sur la suite'],
    ['video_generique', 'Générique dedans (avant ou après)'], ['video_decalee', 'Son et image décalés']]],
  ['texte', 'Texte', [['texte_faux', 'Le texte ne correspond pas'], ['texte_perso', 'Pas le bon personnage']]],
];
function openProblem(q) {
  const has = k => k === 'texte' || (k === 'sans_audio' ? !q.audio : !!q[k]);
  const ctx = [nameCase(q.name), q.film ? 'Film' : q.inedit ? q.inedit.replace(/ :.*/, '') : q.tr ? coteEp(q) : [q.livre && `Livre ${q.livre}`, q.episode && `Épisode ${q.episode}`].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  const sheet = openSheet(`
    <div class="grab" aria-hidden="true"></div>
    <div class="sh-nav"><button class="l" id="avis-cancel">Annuler</button><h2 id="sh-title">Problème</h2><button class="r" id="avis-send2" disabled>Envoyer</button></div>
    <p class="gf ctr">${esc(ctx)}</p>
    ${coupeHTML(q)}
    ${PB_LISTS.filter(([k]) => has(k)).map(([, lab, rows]) => `<p class="gh">${lab}</p><div class="g">${rows.map(([id, l]) =>
      `<button class="gr" data-pb="${id}" role="checkbox" aria-checked="false"><span class="k">${l}</span>${icon('check', 'ck')}</button>`).join('')}</div>`).join('')}
    <p class="gh"><label for="avis-note">Précision (facultatif)</label></p>
    <div class="g"><textarea class="note" id="avis-note" maxlength="500" aria-describedby="avis-prive" placeholder="Par exemple : le son mord sur la réplique suivante"></textarea></div>
    <p class="gf" id="avis-prive">Envoyé sans votre nom, seulement pour corriger les extraits. N’y mettez aucune information personnelle.</p>
    <div class="sh-foot"><button class="pill wide" id="avis-send" disabled>Signaler et passer</button><p class="sh-help" id="avis-help">Cochez au moins une case, ou écrivez une précision.</p></div>`);
  const picked = new Set();
  const send = sheet.querySelector('#avis-send'), note = sheet.querySelector('#avis-note');
  const send2 = sheet.querySelector('#avis-send2');
  const upd = () => { send.disabled = send2.disabled = !picked.size && !note.value.trim(); sheet.querySelector('#avis-help').hidden = !send.disabled; };
  sheet.querySelectorAll('[data-pb]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.pb;
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    b.classList.toggle('on', picked.has(id)); b.setAttribute('aria-checked', picked.has(id)); upd();
  }));
  // note qui s'agrandit avec le texte (jusqu'à 4 lignes)
  note.addEventListener('input', () => { upd(); note.style.height = 'auto'; note.style.height = Math.min(Math.max(note.scrollHeight, 88), 120) + 'px'; refreshCaret(); });
  note.addEventListener('focus', () => setTimeout(() => { note.scrollIntoView({ block: 'center' }); refreshCaret(); }, 300));
  sheet.querySelector('#avis-cancel').addEventListener('click', closeSheet);
  sheet.querySelector('#pb-coupe')?.addEventListener('click', () => { closeSheet(); openCoupe(q); });
  sheet.querySelector('#pb-recoupe')?.addEventListener('click', () => { closeSheet(); demanderRecoupe(q); });
  // réplique déjà classée (par soi ou un autre) : le signalement part quand même, c'est un nouvel avis voulu
  const go = () => { closeSheet(); recordAvis(q, false, [...picked], note.value.trim(), {}, dejaVue(q)); };
  send.addEventListener('click', go); send2.addEventListener('click', go);
}
// État d'une réplique déjà classée, dans la carte Vérifier (à la place de « OK ») : [court, à l'écran ; long, pour VoiceOver]
function dejaLabel(q) {
  const c = coupeDe(q);
  if (demandeDe(q)) return ['À recouper', 'Nouvelle coupe demandée : la réplique reviendra à vérifier'];
  if (c && !c.fini) return ['Coupée', 'Coupe envoyée : elle remplace l’extrait d’ici une heure'];
  return avisFaits[q.i] === 2 ? ['Déjà signalée', 'Déjà signalée'] : ['Déjà vérifiée', 'Déjà vérifiée'];
}
// En tête de la feuille Problème : refaire la coupe soi-même, ou demander qu'elle soit refaite (coupe ratée)
function coupeHTML(q) {
  if (!q.audio && !q.video) return '';
  if (peutCouper(q)) return `<div class="g"><button class="gr act" id="pb-coupe"><span class="k">Ajuster la coupe<small>Reprendre le début ou la fin sur la vidéo, comme dans Photos</small></span>${icon('chev', 'chev')}</button></div>`;
  if (demandeDe(q)) return `<p class="gf">Nouvelle coupe demandée : la réplique reviendra à vérifier, avec une vidéo à recouper.</p>`;
  if (coupeDe(q) || dejaVue(q)) return `<div class="g"><button class="gr act" id="pb-recoupe"><span class="k">La coupe est ratée : la refaire<small>La réplique reviendra à vérifier, avec une vidéo à recouper</small></span>${icon('chev', 'chev')}</button></div>`;
  return '';
}
// « Coupe ratée » : la demande part dans la file des avis ; la réplique reste affichée, avec son nouvel état
function demanderRecoupe(q) {
  const ts = Date.now(), fp = fpOf(q);
  avisFile.push({ i: q.i, quote: q.quote, name: q.name, audio: q.audio, video: q.video, approx: q.approx, fp, ok: false, problemes: [], note: '', demande: 'recoupe', ts });
  if (!writeJSON('kaam_avis_file', avisFile)) { avisFile.pop(); document.getElementById('sr-live').textContent = 'Demande impossible : le stockage du téléphone est plein.'; return; }
  mesDemandes[q.i] = { fp, ts }; writeJSON('kaam_demandes', mesDemandes);
  scheduleSend();
  lastAvis = { i: q.i, idx: quoteIdx, ts, t: Date.now(), what: 'Recoupe demandée', demande: true, label: nameCase(q.name) };
  showAnyway = true; showQuote(quoteIdx, 0);
}

// ===== AJUSTER LA COUPE (façon Photos) : la vidéo élargie, une poignée de début et une de fin =====
// La vidéo élargie contient cx[0] s avant l'extrait, l'extrait (cx[1] s) et cx[2] s après ; les poignées partent sur l'extrait.
// Valider envoie les décalages [début, fin] : la coupe vaut validation, et joue tout de suite (fenêtre) en attendant le serveur.
const CUT_MIN = 0.2;                       // durée minimale d'un extrait
const secFR = t => `${(Math.round(t * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;
const ecart = (t, fem) => Math.abs(t) < 0.005 ? (fem ? 'inchangée' : 'inchangé') : `${t < 0 ? '−' : '+'}${secFR(Math.abs(t))}`;
function openCoupe(q) {
  if (!peutCouper(q)) return;
  stopAudio();
  const [pre, d, post] = q.cx, T = pre + d + post;
  let a = pre, b = pre + d;
  const ctx = [nameCase(q.name), q.tr ? coteEp(q) : q.film ? 'Film' : [q.livre && `Livre ${q.livre}`, q.episode && `Épisode ${q.episode}`].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  const pc = t => `${(t / T * 100).toFixed(3)}%`;
  const sheet = openSheet(`
    <div class="grab" aria-hidden="true"></div>
    <div class="sh-nav"><button class="l" id="cz-cancel">Annuler</button><h2 id="sh-title">Ajuster la coupe</h2><button class="r" id="cz-ok2">Valider</button></div>
    <p class="gf ctr">${esc(ctx)}</p>
    ${sceneHTML(q, 'cz-fig').replace('class="scene"', 'class="scene cz"')}
    <div class="tl" id="cz-tl" style="--o0:${pc(pre)};--o1:${pc(pre + d)}">
      <div class="tl-track"><i class="tl-orig" aria-hidden="true"></i><i class="tl-sel" aria-hidden="true"></i><i class="tl-head" aria-hidden="true"></i>
        <button class="tl-h" id="cz-a" role="slider" aria-label="Début de l’extrait" aria-valuemin="0" aria-valuemax="${T.toFixed(2)}"></button>
        <button class="tl-h" id="cz-b" role="slider" aria-label="Fin de l’extrait" aria-valuemin="0" aria-valuemax="${T.toFixed(2)}"></button></div>
    </div>
    <p class="cz-t" id="cz-t" role="status"></p>
    <div class="cz-row"><button class="pill gray" id="cz-play">${icon('play', 'i-pl')}${icon('pause', 'i-pa')}<span class="lp">Lecture</span><span class="ls">Pause</span></button><button class="pill gray" id="cz-reset">Réinitialiser</button></div>
    <p class="gf">Glissez les poignées pour reprendre un début coupé ou retirer ce qui déborde (la réplique d’avant, le générique). Le pointillé marque la coupe actuelle. Votre coupe remplace l’extrait pour tout le monde.</p>
    <div class="sh-foot"><button class="pill wide" id="cz-ok">Valider la coupe</button><p class="sh-help" id="cz-help" hidden></p></div>`);
  sheet.classList.add('coupe');
  const fig = sheet.querySelector('#cz-fig'), tl = sheet.querySelector('#cz-tl'), track = tl.querySelector('.tl-track');
  const ha = sheet.querySelector('#cz-a'), hb = sheet.querySelector('#cz-b'), play = sheet.querySelector('#cz-play');
  const v = document.createElement('video');
  v.className = 'quote-video'; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  wireScene(v);
  fig.querySelector('.frame').prepend(v);
  const url = cxURL(q);
  fig.dataset.src = url;
  if (offlineMiss(url)) setScene(v, 'error'); else { v.src = mediaSrc(url); setScene(v, 'loading'); }
  // prête : l'image du début de l'extrait, sans légende (la lecture se commande sous la barre)
  v.addEventListener('loadeddata', () => {
    if (fig.dataset.s !== 'loading') return;
    clearTimeout(sceneGuards.get(v)); v.currentTime = a;
    fig.dataset.s = 'pret'; fig.querySelector('.st').textContent = '';
  });
  let raf = 0;
  const draw = () => {
    tl.style.setProperty('--a', pc(a)); tl.style.setProperty('--b', pc(b));
    tl.style.setProperty('--h', pc(Math.min(T, Math.max(0, v.currentTime || a))));
    ha.setAttribute('aria-valuenow', a.toFixed(2)); ha.setAttribute('aria-valuetext', `Début ${ecart(a - pre)}`);
    hb.setAttribute('aria-valuenow', b.toFixed(2)); hb.setAttribute('aria-valuetext', `Fin ${ecart(b - pre - d, true)}`);
    sheet.querySelector('#cz-t').textContent = `Début ${ecart(a - pre)} · Fin ${ecart(b - pre - d, true)} · ${secFR(b - a)}`;
  };
  const playing = on => { play.classList.toggle('playing', on); };
  const tick = () => {
    cancelAnimationFrame(raf);
    if (v.paused) { playing(false); draw(); return; }
    if (v.currentTime >= b) { v.pause(); v.currentTime = b; playing(false); draw(); return; }
    draw(); raf = requestAnimationFrame(tick);
  };
  v.addEventListener('playing', () => { playing(true); tick(); });
  v.addEventListener('pause', () => playing(false));
  // aperçu image : la vidéo se cale sur la poignée glissée (une demande de position par image affichée, pas plus)
  let seekTo = null, seekRaf = 0;
  const seek = t => { seekTo = t; if (!seekRaf) seekRaf = requestAnimationFrame(() => { seekRaf = 0; if (seekTo !== null && v.readyState) v.currentTime = Math.min(seekTo, (v.duration || T) - 0.01); seekTo = null; draw(); }); };
  const tAt = x => { const r = track.getBoundingClientRect(); return Math.min(T, Math.max(0, (x - r.left) / r.width * T)); };
  let drag = null;
  const move = e => {
    const t = tAt(e.clientX);
    if (drag === 'a') { a = Math.min(Math.max(0, t), b - CUT_MIN); seek(a); }
    else if (drag === 'b') { b = Math.max(Math.min(T, t), a + CUT_MIN); seek(b); }
    else seek(Math.min(Math.max(t, 0), T));
    draw();
  };
  tl.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    v.pause();
    drag = e.target === ha ? 'a' : e.target === hb ? 'b' : 'scrub';
    try { tl.setPointerCapture(e.pointerId); } catch {}
    tl.classList.toggle('drag', drag !== 'scrub');
    move(e); e.preventDefault();
  });
  tl.addEventListener('pointermove', e => { if (drag) { move(e); e.preventDefault(); } });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => tl.addEventListener(ev, () => { drag = null; tl.classList.remove('drag'); }));
  tl.addEventListener('touchmove', e => e.preventDefault(), { passive: false });   // jamais de défilement pendant le glisser (iOS)
  // clavier, VoiceOver : flèches ±0,05 s (Maj : ±0,5 s)
  [[ha, 'a'], [hb, 'b']].forEach(([h, k]) => h.addEventListener('keydown', e => {
    const st = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!st) return;
    e.preventDefault();
    const dt = st * (e.shiftKey ? 0.5 : 0.05);
    if (k === 'a') { a = Math.min(Math.max(0, a + dt), b - CUT_MIN); seek(a); } else { b = Math.max(Math.min(T, b + dt), a + CUT_MIN); seek(b); }
    draw();
  }));
  play.addEventListener('click', () => {
    if (!v.paused) { v.pause(); return; }
    if (fig.dataset.s === 'error') { if (!v.getAttribute('src') && !offlineMiss(url)) v.src = mediaSrc(url); v.load(); }
    v.currentTime = a; v.muted = false;
    v.play().catch(() => {});
  });
  fig.addEventListener('click', () => play.click());
  sheet.querySelector('#cz-reset').addEventListener('click', () => { v.pause(); a = pre; b = pre + d; seek(a); draw(); });
  sheet.querySelector('#cz-cancel').addEventListener('click', closeSheet);
  const valider = () => {
    const ds = Math.round((a - pre) * 100) / 100, de = Math.round((b - pre - d) * 100) / 100;
    closeSheet();
    if (!ds && !de) { recordAvis(q, true, [], ''); return; }          // rien de changé : c'est un « OK »
    recordAvis(q, true, [], '', { coupe: [ds, de] }, true);
  };
  sheet.querySelector('#cz-ok').addEventListener('click', valider);
  sheet.querySelector('#cz-ok2').addEventListener('click', valider);
  draw();
}

// extra : { coupe: [ds, de] } (coupe refaite, vaut validation) ; force : nouvel avis sur une réplique déjà classée
function recordAvis(q, ok, problemes, note, extra = {}, force = false) {
  if (avisFaits[q.i] && !force) return;         // jamais deux avis pour la même réplique (double toucher)
  avisFaits[q.i] = ok ? 1 : 2;                  // 1 = validée, 2 = signalée
  const fp = fpOf(q);
  avisFile.push({ i: q.i, quote: q.quote, name: q.name, audio: q.audio, video: q.video, approx: q.approx, fp, ok, problemes, note, ...extra,
    ...(extra.coupe ? { cx: q.cx, vv: q.vv || 0 } : {}), ts: Date.now() });   // coupe : la fenêtre est déduite et gardée côté serveur
  // la file d'abord : si elle ne peut pas être écrite, la réplique n'est pas marquée « vérifiée » (elle reviendra)
  if (writeJSON('kaam_avis_file', avisFile)) writeJSON('kaam_avis_faits', avisFaits);
  // la coupe joue tout de suite sur ce téléphone, sans attendre la liste commune
  if (extra.coupe) { mesCoupes[q.i] = { fp, ds: extra.coupe[0], de: extra.coupe[1], ts: avisFile[avisFile.length - 1].ts }; writeJSON('kaam_coupes', mesCoupes); }
  if (avisFile.length >= 5) sendAvis(); else scheduleSend();
  // « Validé · Annuler » ou « Signalé · Annuler » pendant 5 s : un pouce qui glisse ne valide rien pour de bon
  const ts = avisFile[avisFile.length - 1].ts;
  lastAvis = { i: q.i, idx: quoteIdx, ts, t: Date.now(), what: extra.coupe ? 'Coupé' : ok ? 'Validé' : 'Signalé',
    label: `${nameCase(q.name)}${q.film ? ', film' : q.tr ? `, ${coteEp(q)}` : q.livre ? `, Livre ${q.livre}${q.episode ? `, ép. ${q.episode}` : ''}` : ''}` };
  rebuildVerify();
  if (!verifyIdx.length) { renderCitations(); return; }
  if (inOrder) stepQuote(1); else randomQuote();
}
let lastAvis = null, doneTimer = null;
function showDoneLine() {
  clearTimeout(doneTimer);
  const slot = document.querySelector('.done-slot');
  if (!slot || !verifyMode || !lastAvis) return;
  const left = 5000 - (Date.now() - lastAvis.t);
  if (left <= 0) { lastAvis = null; return; }
  const sent = !avisFile.some(a => a.ts === lastAvis.ts);
  slot.outerHTML = `<div class="done-line done-slot" role="status"><span><b>${lastAvis.what}</b> · ${esc(lastAvis.label)}</span><button id="avis-undo"${sent ? ' disabled' : ''}>${sent ? 'Déjà envoyé' : 'Annuler'}</button></div>`;
  document.getElementById('avis-undo').addEventListener('click', undoAvis);
  // la ligne d'annulation prend la place du compteur le temps de ses 5 s (même hauteur : rien ne bouge sous le pouce)
  const foot = document.querySelector('.stage-foot.vf');
  if (foot) foot.hidden = true;
  doneTimer = setTimeout(() => {
    const d = document.querySelector('.done-line'); if (d) d.outerHTML = '<div class="done-slot"></div>';
    if (foot) foot.hidden = false;
    lastAvis = null;
  }, left);
}
function undoAvis() {
  const last = lastAvis;
  if (!last || !avisFile.some(a => a.ts === last.ts)) return;
  if (!last.demande) delete avisFaits[last.i];
  if (mesCoupes[last.i]?.ts === last.ts) { delete mesCoupes[last.i]; writeJSON('kaam_coupes', mesCoupes); }
  if (mesDemandes[last.i]?.ts === last.ts) { delete mesDemandes[last.i]; writeJSON('kaam_demandes', mesDemandes); }
  avisFile = avisFile.filter(a => a.ts !== last.ts);
  writeJSON('kaam_avis_faits', avisFaits);   // ordre inverse de recordAvis : jamais un avis en file pour une réplique non marquée
  writeJSON('kaam_avis_file', avisFile);
  lastAvis = null; clearTimeout(doneTimer);
  rebuildVerify();
  showAnyway = true;                         // la réplique revient, même si elle était la dernière à vérifier
  // historique recalé sur la réplique rendue : « ‹ » ramène ensuite à celle d'avant, dès le premier toucher
  if (randHistory[randPos - 1] === last.idx) randPos--; else if (randHistory[randPos] !== last.idx) pushHistory(last.idx);
  showQuote(last.idx, last.demande ? 0 : -1);
  document.getElementById('sr-live').textContent = last.demande ? 'Demande annulée.' : 'Avis annulé.';
}
// Écran de fin : plus rien à vérifier dans cette sélection
function renderVerifyDone() {
  stopAudio();                                   // met aussi la scène de la carte en pause
  setMast('Vérification');
  const total = allQuotes.reduce((n, q) => n + (inSel(q) ? 1 : 0), 0);
  const vals = Object.values(avisFaits);
  document.getElementById('main-content').innerHTML = `
    <button class="bar verify" id="btn-settings"><span class="bar-sum">Terminé</span>${icon('chev', 'chev')}</button>
    <div class="scroll"><div class="fin"><div class="ok-i">${icon('check')}</div><h1>Tout est vérifié.</h1>
      <p>${nf(total)} sur ${nf(total)}, à vous tous. Merci.</p>
      <p class="gh">Sur ce téléphone</p>
      <dl class="grp"><div><dt>Validés</dt><dd>${nf(vals.filter(v => v !== 2).length)}</dd></div><div><dt>Signalés</dt><dd>${nf(vals.filter(v => v === 2).length)}</dd></div><div><dt>En attente d’envoi</dt><dd>${nf(avisFile.length)}</dd></div></dl>
      <button class="pill wide" id="verify-leave">Revenir à la lecture</button></div></div>`;
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('verify-leave').addEventListener('click', () => {
    verifyMode = false; writePref('kaam_verify', false); nextRand = null; resetHistory();
    showQuote(pickRandom());
  });
}
// Envoi par lots ; les avis restent dans l'appareil tant que l'envoi n'a pas réussi.
// Un lot refusé pour de bon (400, 415) est écarté ; 429 et 5xx : nouvel essai avec un délai doublé.
let sending = false, sendDelay = 15000, sendRetry = null, idleSend = null;
// → promesse de la fin de l'envoi (le partage d'une coupe attend qu'elle soit enregistrée avant de demander l'extrait)
let sendingP = Promise.resolve();
function sendAvis() {
  if (sending || !avisFile.length) return sendingP;
  sending = true;
  clearTimeout(sendRetry);
  // 100 avis et ~60 Ko au plus (un envoi « keepalive », page qui se ferme, est plafonné à 64 Kio par le navigateur)
  const lot = [];
  let taille = 0;
  for (const a of avisFile.slice(0, 100)) {
    const t = new TextEncoder().encode(JSON.stringify(a)).length + 1;
    if (lot.length && taille + t > 60000) break;
    lot.push(a); taille += t;
  }
  // identifiant du lot : un même lot renvoyé (réponse perdue) réécrit le même fichier côté serveur, jamais un doublon
  const id = h32(lot.map(a => a.ts).join(',')).toString(36).padStart(7, '0') + lot.length.toString(36).padStart(2, '0');
  return sendingP = fetch('/api/avis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lot: id, avis: lot }), keepalive: document.visibilityState === 'hidden' })
    .then(r => {
      if (r.ok || r.status === 400 || r.status === 415) {
        const sent = new Set(lot.map(a => a.ts));
        avisFile = avisFile.filter(a => !sent.has(a.ts));
        writeJSON('kaam_avis_file', avisFile);
        sendDelay = 15000;
        refreshVerifyCounter();
        if (avisFile.length >= 5) setTimeout(sendAvis, 0);   // lot coupé par la taille : la suite part aussitôt
      } else if (r.status === 429 || r.status >= 500) {
        sendRetry = setTimeout(sendAvis, sendDelay); sendDelay = Math.min(sendDelay * 2, 300000);
      }
    })
    // réseau coupé ou envoi refusé par le navigateur : nouvel essai plus tard (le retour du réseau relance aussi)
    .catch(() => { sendRetry = setTimeout(sendAvis, sendDelay); sendDelay = Math.min(sendDelay * 2, 300000); })
    .finally(() => { sending = false; });
}
function refreshVerifyCounter() {
  const c = document.querySelector('.stage-foot.vf .quote-counter');
  if (c) c.textContent = verifyCounter();
}
// pied de la vérification, étroit (‹, ordre, Passer à côté) : les avis en attente d'envoi priment, sinon le total vérifié
function verifyCounter() { return avisFile.length ? `${nf(avisFile.length)} à envoyer` : plural(Object.keys(avisFaits).length, 'vérifiée'); }
// envoi après 20 s sans nouvel avis, et dès le retour du réseau
function scheduleSend() { clearTimeout(idleSend); idleSend = setTimeout(sendAvis, 20000); }


// ===== NAVIGATION ENTRE RÉPLIQUES =====
// Seul endroit qui change la réplique affichée puis la rend ; dir : 1 suivante, -1 précédente, 0 au hasard
function showQuote(idx, dir = 0) { quoteIdx = idx; renderCitations(dir); }
// Ajoute une réplique à l'historique aléatoire (l'historique « en avant » est coupé si l'on était revenu en arrière)
function pushHistory(idx) {
  if (randPos < randHistory.length - 1) randHistory = randHistory.slice(0, randPos + 1);
  randHistory.push(idx);
  randPos = randHistory.length - 1;
}
function stepQuote(dir) {
  if (!verifyMode && poolEmpty()) { renderCitations(); return; }
  const P = pool();
  let idx;
  if (P) {
    const pos = P.indexOf(quoteIdx);
    idx = pos === -1
      ? (dir > 0 ? P.find(i => i > quoteIdx) ?? P[0] : [...P].reverse().find(i => i < quoteIdx) ?? P[P.length - 1])
      : P[(pos + dir + P.length) % P.length];
  } else {
    idx = (quoteIdx + dir + allQuotes.length) % allQuotes.length;
  }
  if (verifyMode) pushHistory(idx);   // vérification : « ‹ » revient aux répliques vues, même dans l'ordre (les classées quittent la file)
  showQuote(idx, dir);
}
function randomQuote() {
  if (!verifyMode && poolEmpty()) { renderCitations(); return; }
  const P = pool();
  const idx = nextRand !== null && (!P || P.includes(nextRand)) && nextRand !== quoteIdx ? nextRand : pickRandom();
  nextRand = null;
  pushHistory(idx);
  showQuote(idx, 0);
}
// Toucher / glisser : selon le mode, réplique suivante dans l'ordre ou au hasard (avec historique)
// En vérification, tout retour (glisser, flèche, « ‹ ») passe par l'historique des répliques vues (les classées quittent la
// file : « la précédente dans l'ordre » n'est plus celle qu'on vient de voir) ; en avant, l'historique d'abord, puis la file.
function swipeForward() {
  if (verifyMode && randPos < randHistory.length - 1) historyForward();
  else if (inOrder) stepQuote(1); else historyForward();
}
function swipeBack() { if (inOrder && !verifyMode) stepQuote(-1); else historyBack(); }
// historique repris à zéro en entrant en vérification ou en en sortant : « ‹ » ne ramène pas dans l'autre mode
function resetHistory() { randHistory = []; randPos = -1; }
function historyBack() {
  if (randPos > 0) { randPos--; showQuote(randHistory[randPos], -1); }
}
function historyForward() {
  if (randPos < randHistory.length - 1) { randPos++; showQuote(randHistory[randPos], 1); }
  else randomQuote();
}
// Ouvre une réplique précise (recherche, favoris, fiche) dans la page Répliques
// Réplique ouverte depuis Rechercher : « ‹ » dans l'en-tête (et Retour système) ramène aux résultats, à leur place
let backTo = null;
function gotoQuote(q) {
  const from = currentView === 'recherche' ? 'recherche' : null;
  let idx = allQuotes.indexOf(q);
  if (idx < 0) idx = allQuotes.findIndex(x => x.quote === q.quote && x.name === q.name);
  if (idx < 0) return;
  ficheState = overlaySnapshot();                                       // on retrouvera la fiche à sa place
  closeOverlay();
  quoteIdx = idx;
  pushHistory(idx);
  showAnyway = true;
  setView('citations');
  showAnyway = false;
  backTo = from;
  refreshBack();
  navSoon();
}
function refreshBack() {
  const b = document.getElementById('mast-back');
  if (b) b.hidden = !(backTo && currentView === 'citations' && document.getElementById('detail-overlay').classList.contains('hidden'));
}
function goBack() { const v = backTo; backTo = null; if (v) setView(v); }
// Partage : feuille système si elle existe, sinon copie ; la confirmation s'écrit dans le bouton (jamais de fenêtre d'alerte)
const shareTimers = new WeakMap();   // bouton → { libellé d'origine, minuteur } pendant « Copié » / « Envoyé »
async function shareText(text, btn) {
  let said = '';
  if (navigator.share) {
    try { await navigator.share({ text }); said = 'Envoyé'; }
    catch (e) {
      // hors du geste (iOS, après un extrait injoignable) : un second toucher envoie le texte ; jamais un bouton figé
      if (e.name === 'NotAllowedError') { sayInButton(btn, 'Envoyer', 10000); document.getElementById('sr-live').textContent = 'Texte prêt : touchez Envoyer.'; }
      else restoreButton(btn);
      return;
    }
  } else {
    try { await navigator.clipboard.writeText(text); said = 'Copié'; }
    catch {                                   // presse-papiers refusé : copie à l'ancienne
      const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
      ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      said = ok ? 'Copié' : 'Échec';
    }
  }
  document.getElementById('sr-live').textContent = said === 'Copié' ? 'Copié dans le presse-papiers.' : said === 'Envoyé' ? 'Envoyé.' : 'Copie impossible.';
  sayInButton(btn, said, 1500);
}
// Écrit un mot dans le bouton (« Copié », « Préparation… », « Envoyer ») puis remet son libellé après ms (0 : jusqu'au prochain mot)
function sayInButton(btn, said, ms) {
  if (!btn || !btn.isConnected) return;
  const lab = btn.querySelector('.t') || btn;
  const prev = shareTimers.get(btn);
  if (prev) clearTimeout(prev.timer);
  const html = prev ? prev.html : lab.innerHTML;
  lab.textContent = said;
  btn.classList.add('said');
  const reset = () => { lab.innerHTML = html; btn.classList.remove('said'); shareTimers.delete(btn); };
  shareTimers.set(btn, { html, reset, timer: ms ? setTimeout(reset, ms) : 0 });
}
function restoreButton(btn) { const t = btn && shareTimers.get(btn); if (t) { clearTimeout(t.timer); t.reset(); } }
function shareTextOf(q) {
  const extra = [q.acteur && `interprété par ${q.acteur}`, q.tr && 'transcription'].filter(Boolean).join(', ');
  return `« ${q.quote} »\n${nameCase(q.name)}${fmtEp(q) ? ', ' + fmtEp(q) : ''}${extra ? ` (${extra})` : ''}\n\nKaamelott`;
}

// Partage de l'EXTRAIT (la scène, sinon le son) avec le texte, quand l'appareil sait partager un fichier ;
// sinon le texte seul, comme avant. La feuille de partage ne s'ouvre que dans le geste (iOS) : un extrait déjà en
// mémoire part au premier toucher ; sinon il se télécharge (« Préparation… ») et part tout seul si le navigateur
// le permet encore (Android), ou le bouton propose « Envoyer » pour un second toucher (iOS).
const shareFiles = new Map();     // url de l'extrait → File prêt (les 4 derniers)
const sharePending = new Set();   // url en cours de téléchargement : un second toucher ne relance rien
const shareTexteSeul = new Set(); // extrait injoignable : le toucher suivant envoie le texte tout de suite (dans le geste)
// coupe en attente : l'extrait coupé est fabriqué en ligne (api/extrait.js) d'après la coupe enregistrée, sans attendre le PC
function extraitURL(q) {
  if (fenetre(q)) return `/api/extrait?i=${q.i}&fp=${coupeDe(q).fp}`;
  return q.video ? videoURL(q) : q.audio ? audioURL(q.audio) : null;
}
function canShareFiles() {
  try { return !!navigator.canShare && navigator.canShare({ files: [new File([new Blob()], 'x.mp4', { type: 'video/mp4' })] }); }
  catch { return false; }
}
function extraitFile(q, url, blob) {
  const ext = q.video ? 'mp4' : (/\.(\w+)(\?|$)/.exec(url) || [])[1] || 'm4a';
  const mots = q.quote.replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
  const type = q.video ? 'video/mp4' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
  return new File([blob], `Kaamelott - ${nameCase(q.name)} - ${mots}.${ext}`.replace(/[\\/:*?"<>|]/g, ''), { type });
}
let shareDelai = 20000;     // téléchargement bloqué (réseau coupé ou changé en cours, iOS ne rend jamais la main) : abandon
async function fetchExtrait(q, url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), shareDelai);
  let blob;
  try {
    const r = await fetch(mediaReady.get(url) || url, { signal: ctl.signal });   // copie déjà en mémoire (préchargement) : instantané
    if (!r.ok) throw new Error(r.status);
    blob = await r.blob();
  } finally { clearTimeout(t); }
  const f = extraitFile(q, url, blob);
  shareFiles.set(url, f);
  while (shareFiles.size > 4) shareFiles.delete(shareFiles.keys().next().value);
  return f;
}
async function shareExtrait(q, f, btn) {
  // la scène seule par défaut : avec un texte, iOS et WhatsApp envoient deux messages, ou le texte en légende (« Les deux »)
  const avec = shareMode === 'deux' ? { text: shareTextOf(q) } : {};
  try { await navigator.share({ files: [f], ...avec }); }
  catch (e) {
    if (e.name === 'NotAllowedError') {                                  // geste expiré pendant le téléchargement
      sayInButton(btn, 'Envoyer', 10000);
      document.getElementById('sr-live').textContent = 'Extrait prêt : touchez Envoyer.';
      return 'attente';
    }
    if (e.name === 'AbortError') { restoreButton(btn); return 'annulé'; }   // feuille fermée sans envoyer
    await shareText(shareTextOf(q), btn); return 'texte';                    // fichier refusé : le texte
  }
  document.getElementById('sr-live').textContent = 'Envoyé.';
  sayInButton(btn, 'Envoyé', 1500);
  return 'envoyé';
}
function shareQuote(q, btn) {
  const url = extraitURL(q);
  if (shareMode === 'texte' || !url || !navigator.share || !canShareFiles() || shareTexteSeul.has(url)) return shareText(shareTextOf(q), btn);
  const f = shareFiles.get(url);
  if (f) return shareExtrait(q, f, btn);
  if (sharePending.has(url)) return Promise.resolve();
  sharePending.add(url);
  sayInButton(btn, 'Préparation…', 0);
  // coupe encore sur ce téléphone seulement : envoyée d'abord, le serveur ne découpe que les coupes enregistrées
  const envoi = fenetre(q) && avisFile.some(a => a.i === q.i && a.coupe) ? sendAvis() : Promise.resolve();
  return envoi.then(() => fetchExtrait(q, url))
    .then(f => shareExtrait(q, f, btn), e => e.name === 'AbortError'
      ? (sayInButton(btn, 'Réseau trop lent, réessayez', 4000), 'délai')       // le bouton redevient utilisable
      : (shareTexteSeul.add(url), shareText(shareTextOf(q), btn)))              // extrait injoignable : le texte
    .finally(() => sharePending.delete(url));
}

// ===== QUIZ =====
const TOP_CHARS = [
  'ARTHUR', 'PERCEVAL', 'LÉODAGAN', 'LANCELOT', 'GUENIÈVRE',
  'KARADOC', 'BOHORT', 'SÉLI', 'MERLIN', 'PÈRE BLAISE',
  'DEMETRA', 'LE TAVERNIER', 'GUETHENOC', 'YVAIN', 'YGERNE',
  'LE RÉPURGATEUR', 'CALOGRENANT', 'ATTILA', 'VENEC', 'GALESSIN',
];
function initQuiz() {
  quizState = { correct: 0, total: 0, streak: 0, best: +readStr('kaam_quiz_best', 0) || 0, answered: false };
}
// Tirage juste : personnage d'abord (uniforme), puis une de ses répliques. Chaque nom affiché a ainsi 1 chance sur 4
// d'être le bon (plus de « réflexe Arthur »). Pool : réplique avec scène, 25 signes au moins, sans le nom de celui qui parle.
const QUIZ_RECENT = [];                      // 80 dernières questions : pas de redite
let quizByChar = null;
function quizAccepts(q) {
  if (q.tr || !TOP_CHARS.includes(q.name) || !q.video || q.quote.length < 25) return false;   // transcriptions : hors quiz
  return !fold(q.quote).includes(fold(q.name.replace(/^(LE|PÈRE) /, '')));
}
function buildQuizPool() {
  if (quizByChar && quizByChar.src === allQuotes) return;
  quizByChar = { src: allQuotes, m: {} };
  allQuotes.forEach((q, i) => {
    if (quizAccepts(q)) (quizByChar.m[q.name] = quizByChar.m[q.name] || []).push(i);   // pas de « ||= » : iOS 13.4 et plus
  });
}
// Le quiz libre suit la sélection : chaque personnage garde ses répliques de la sélection (cache par sélection).
// Moins de 4 personnages ou de 20 questions : repli sur tout Kaamelott, annoncé sous le titre.
const QUIZ_MIN_CHARS = 4, QUIZ_MIN_Q = 20;
let quizSel = null;
function quizSelPool() {
  buildQuizPool();
  const key = sel.join();
  if (quizSel && quizSel.key === key && quizSel.src === quizByChar) return quizSel;
  let m = quizByChar.m, fallback = false;
  if (!selAll()) {
    const f = {}; let n = 0;
    for (const name in quizByChar.m) {
      const l = quizByChar.m[name].filter(i => inSel(allQuotes[i]));
      if (l.length) { f[name] = l; n += l.length; }
    }
    if (Object.keys(f).length >= QUIZ_MIN_CHARS && n >= QUIZ_MIN_Q) m = f; else fallback = true;
  }
  quizSel = { key, src: quizByChar, m, fallback };
  return quizSel;
}
// Quiz libre : de préférence une réplique qui tient en entier à l'écran avec ses 4 réponses (240 signes au plus)
const QUIZ_LEN = 240;
function quizPick() {
  const { m } = quizSelPool();
  const names = Object.keys(m);
  for (let t = 0; t < 40; t++) {
    const i = rand(m[rand(names)]);
    if (allQuotes[i].quote.length > QUIZ_LEN && t < 30) continue;
    if (!QUIZ_RECENT.includes(i)) { QUIZ_RECENT.push(i); if (QUIZ_RECENT.length > 80) QUIZ_RECENT.shift(); return allQuotes[i]; }
  }
  return allQuotes[rand(m[rand(names)])];
}
function shuffle(a, rnd = Math.random) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// ===== QUESTION DU JOUR : la même pour tout le monde ce jour-là (graine = date), une seule tentative =====
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function dailyState() { const st = readJSON('kaam_qdj', {}); return st.d === todayKey() ? st : null; }
// tirage stable : le plus petit hachage (jour, clé) gagne. Ajouter une vidéo ou une réplique ailleurs ne change pas la
// question du jour (un tirage par position, lui, changeait dès que le corpus bougeait)
function h32(s) { let h = 0x811c9dc5; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193) >>> 0; return h; }
const minPar = (xs, cle) => xs.reduce((m, x) => (cle(x) < cle(m) ? x : m));
function dailyQuestion() {
  buildQuizPool();                                  // tout Kaamelott : la même question pour tout le monde, quelle que soit la sélection
  const jour = todayKey(), rnd = mulberry32(+jour.replace(/-/g, ''));
  // réplique déjà tirée aujourd'hui sur ce téléphone (kaam_qdj.i) : on la garde, même si data.json a changé entre-temps
  const deja = dailyState()?.i, vue = deja != null && allQuotes.find(x => x.i === deja);
  // personnage d'abord (chacun a la même chance), puis une de ses répliques
  const q = vue || allQuotes[minPar(quizByChar.m[minPar(Object.keys(quizByChar.m), n => h32(`${jour}|${n}`))], p => h32(`${jour}|${allQuotes[p].i}`))];
  const wrong = shuffle(TOP_CHARS.filter(c => c !== q.name), rnd).slice(0, 3);
  return { q, choices: shuffle([q.name, ...wrong], rnd) };
}
// ----- Réponse au quiz : chaque étape séparée (score, lignes, scène, rangée du pouce) -----
// Score et record ; la question du jour n'est enregistrée qu'une fois (pas en relecture)
function quizRecord(btn, replay, { q, daily, hist }) {
  const correct = btn.dataset.choice === q.name;
  const lost = quizState.streak;
  let record = false;
  if (daily) {
    if (!replay) {
      writeJSON('kaam_qdj', { d: todayKey(), i: q.i, pick: btn.dataset.choice, ok: correct });   // i : relu tel quel
      hist[todayKey()] = correct; writeJSON('kaam_qdj_hist', hist);
    }
  } else {
    quizState.total++;
    if (correct) {
      quizState.correct++; quizState.streak++;
      if (quizState.streak > quizState.best) {
        quizState.best = quizState.streak; record = true;
        writeStr('kaam_quiz_best', quizState.best);
      }
    } else quizState.streak = 0;
  }
  return { correct, lost, record };
}
// les 4 lignes restent en place : rien ne bouge sous le doigt
function quizMarkChoices(btn, q) {
  document.querySelectorAll('.choice').forEach(b => {
    b.setAttribute('aria-disabled', 'true');
    if (b.dataset.choice === q.name) { b.classList.add('right'); b.querySelector('.v').innerHTML = icon('check') + '<span class="sr">Juste</span>'; }
    else if (b === btn) { b.classList.add('wrong'); b.querySelector('.v').innerHTML = icon('x') + '<span class="sr">Faux</span>'; }
    else b.classList.add('dim');
  });
}
// Score : rien tant qu'on n'a pas joué, puis une seule ligne de texte sous le titre
function quizStatText(daily, hist) {
  if (daily) {
    if (!dailyState()) return '';
    const n = Object.values(hist).filter(Boolean).length;
    return `${nf(n)} ${n > 1 ? 'jours justes' : 'jour juste'}`;
  }
  const { correct, total, streak, best } = quizState;
  if (!quizState.answered && quizSelPool().fallback) return 'Pas assez de scènes dans cette sélection : questions sur tout Kaamelott.';
  if (!total) return '';
  return `${nf(correct)} sur ${nf(total)}${streak > 1 ? ` · série de ${nf(streak)}` : ''}${best > 1 ? ` · record ${nf(best)}` : ''}`;
}
function quizUpdateScore(daily, hist) {
  const el = document.getElementById('quiz-stat');
  if (!el) return;
  const t = quizStatText(daily, hist);
  el.textContent = t; el.hidden = !t;
}
// la récompense : la scène, projetée dans le geste (donc avec le son), en tête de la zone ; en relecture, sans le son
function quizShowScene(q, replay) {
  if (!replay) stopAudio();                 // jamais deux sons : le mini-lecteur s'arrête, la scène parle
  const scene = document.getElementById('quiz-scene');
  scene.innerHTML = sceneHTML(q, 'quiz-fig');
  const fig = document.getElementById('quiz-fig');
  bindScene(fig, cardVideo);
  if (!replay) playCardVideo(q, fig);
  else { fig.querySelector('.frame').prepend(cardVideo); cardVideo.src = mediaSrc(playURL(q)); setScene(cardVideo, 'loading'); cardVideo.muted = true; cardVideo.play().catch(() => {}); }
}
// rangée du pouce après la réponse : Partager / Quiz libre (question du jour) ou Question suivante
function quizNavAfter(daily) {
  const nav = document.getElementById('quiz-nav');
  if (daily) {
    const res = readJSON('kaam_qdj', {});
    nav.className = 'nav two';
    nav.innerHTML = `<button class="tbtn" id="qdj-share"><span class="t">Partager</span></button><button class="pill" id="quiz-free">Quiz libre</button>`;
    const d = new Date().toLocaleDateString('fr-FR');
    document.getElementById('qdj-share').addEventListener('click', e => shareText(`Kaamelott · Qui a dit ça ? · ${d} · ${res.ok ? 'Juste' : 'Faux'}${quizState.best ? ` (record ${quizState.best})` : ''}`, e.currentTarget));
    document.getElementById('quiz-free').addEventListener('click', () => renderQuiz());
  } else {
    nav.className = 'nav one';
    nav.innerHTML = `<button class="pill" id="quiz-next">Question suivante</button>`;
    const nx = document.getElementById('quiz-next');
    nx.addEventListener('click', () => renderQuiz());
    if (usingKeyboard) nx.focus({ preventScroll: true });   // clavier : on enchaîne sur « Question suivante »
  }
}
function quizAnswer(btn, replay, ctx) {
  if (quizState.answered) return;
  quizState.answered = true;
  const { q, daily, stage, fade } = ctx;
  const { correct, lost, record } = quizRecord(btn, replay, ctx);
  quizMarkChoices(btn, q);
  quizUpdateScore(daily, ctx.hist);
  // source : l'épisode seulement (le nom est déjà dans la ligne « Juste »)
  const vd = document.getElementById('quiz-verdict');
  vd.innerHTML = `${correct ? 'Juste.' : 'Faux.'}<span>${correct ? `C’est bien ${esc(nameCase(q.name))}.` : `C’était ${esc(nameCase(q.name))}.`}${!correct && lost > 1 && !daily ? ` Série de ${lost} perdue.` : ''}${record && quizState.best > 1 ? ' Nouveau record.' : ''}</span>`;
  vd.hidden = false;
  document.getElementById('quiz-ask').hidden = true;
  const after = document.getElementById('quiz-after');
  after.innerHTML = epHTML(q); after.hidden = !fmtEp(q);
  if (!replay) document.getElementById('sr-live').textContent = correct
    ? `Juste, c’est ${nameCase(q.name)}.${record ? ' Nouveau record.' : ''}`
    : `Faux, c’était ${nameCase(q.name)}.${lost > 1 && !daily ? ` Série de ${lost} perdue.` : ''}`;
  quizShowScene(q, replay);
  stage.classList.add('answered');
  stage.scrollTop = 0; fade();
  quizNavAfter(daily);
}
// Quiz : jamais de texte ni de scène coupés. Avant la réponse, le corps de la question descend jusqu'à ce qu'elle tienne ;
// si elle ne tient toujours pas, c'est la page entière qui défile (jamais une ligne tranchée). Après la réponse, la scène
// prend la hauteur disponible (16:9 entier), la question se lit dessous en faisant défiler.
function fitQuiz(stage) {
  if (!stage?.isConnected) return;
  const main = document.getElementById('main-content');
  const qt = stage.querySelector('.quiz-q .quote');
  const fr = stage.querySelector('.q-scene .frame');
  main.classList.remove('qpage');
  stage.classList.remove('long');
  if (!fr && qt) {
    let fs = +qt.dataset.fs0 || parseFloat(qt.style.fontSize) || 24;
    qt.style.fontSize = fs + 'px';
    const min = Math.round((innerHeight < 620 ? 15 : 17) * textScale());
    while (fs > min && stage.scrollHeight > stage.clientHeight + 1) { fs--; qt.style.fontSize = fs + 'px'; }
  }
  if (stage.scrollHeight > stage.clientHeight + 1) {
    if (!fr) stage.classList.add('long');
    main.classList.add('qpage');
    main.scrollTop = 0;
  }
  armMast();
}
function renderQuiz(daily = false) {
  if (!quizState) initQuiz();
  stopVideos();
  document.getElementById('main-content').classList.remove('qpage');
  setMast(daily ? 'Question du jour' : 'Quiz');
  quizDaily = daily;
  refreshScope();                            // question du jour : pas de sélecteur (la même pour tout le monde)
  const main = document.getElementById('main-content');
  let q, choices;
  if (daily) ({ q, choices } = dailyQuestion());
  else {
    q = quizPick();
    choices = shuffle([q.name, ...shuffle(TOP_CHARS.filter(c => c !== q.name)).slice(0, 3)]);
  }
  quizState.current = q;
  quizState.answered = false;
  cachedMedia(playURL(q));                   // la scène se télécharge pendant que l'on réfléchit
  const short = innerHeight < 620;
  const fs = Math.round(Math.min(quoteSize(q.quote), short ? Q_MAX.quizSE : Q_MAX.quiz) * textScale());
  const done = dailyState();
  const hist = readJSON('kaam_qdj_hist', {});
  const stat = quizStatText(daily, hist);
  main.innerHTML = `
    <p class="qstat" id="quiz-stat"${stat ? '' : ' hidden'}>${esc(stat)}</p>
    <div class="scroll" id="quiz-stage">
      <p class="verdict" id="quiz-verdict" hidden></p>
      <div class="qcard">
        <div id="quiz-scene" class="q-scene"></div>
        <figure class="quiz-q">
          <p class="ask" id="quiz-ask">${daily ? 'Question du jour · qui a dit ça ?' : 'Qui a dit ça ?'}</p>
          <blockquote class="quote" lang="fr" style="font-size:${fs}px" data-fs0="${fs}">${quoteHTML(q.quote)}</blockquote>
          <figcaption class="src" id="quiz-after" hidden></figcaption>
        </figure>
      </div>
    </div>
    <div class="choices" role="group" aria-label="Qui a dit ça ?">
      ${choices.map(c => `<button class="choice" data-choice="${esc(c)}">${faceHTML(c, 's', 'l')}<span class="n">${esc(nameCase(c))}</span><span class="v"></span></button>`).join('')}
    </div>
    ${daily
      ? `<div class="nav txt" id="quiz-nav"><button class="tbtn" id="quiz-free">Revenir au quiz libre</button></div>`
      : `<div class="nav txt" id="quiz-nav"><button class="tbtn" id="quiz-daily">${done ? `Question du jour · ${done.ok ? 'juste' : 'faux'}` : 'Question du jour'}</button><button class="tbtn" id="quiz-next">Passer</button></div>`}`;

  const stage = document.getElementById('quiz-stage');
  // la question entière dans la zone (corps réduit jusqu'à 17 px) ; après la réponse, la scène entière en tête
  const fade = () => fitQuiz(stage);
  fade();
  // les polices arrivées après coup changent la hauteur du texte : on remesure (jamais une ligne coupée)
  document.fonts?.ready.then(() => { if (stage.isConnected) fade(); });
  document.getElementById('quiz-next')?.addEventListener('click', () => renderQuiz());
  document.getElementById('quiz-daily')?.addEventListener('click', () => renderQuiz(true));
  document.getElementById('quiz-free')?.addEventListener('click', () => renderQuiz());
  const answer = (btn, replay) => quizAnswer(btn, replay, { q, daily, hist, stage, fade });
  document.querySelectorAll('.choice').forEach(btn => btn.addEventListener('click', () => answer(btn, false)));
  // question du jour déjà jouée : on montre la réponse donnée, sans nouvelle tentative
  if (daily && done) {
    const b = [...document.querySelectorAll('.choice')].find(x => x.dataset.choice === done.pick);
    if (b) answer(b, true);
  }
}

// ===== ENTRÉES DE LISTE (fiche, recherche, favoris) =====
// Une ligne = la réplique (toucher : elle s'ouvre) et un bouton « … » (ou un toucher long sur la ligne) qui ouvre le menu :
// Écouter, Voir la scène (seulement s'ils existent), Favori, Partager. Rien n'est répété sous chaque ligne.
function entHTML(q, k, opts = {}) {
  const by = q.acteur ? `<span class="by">${esc(byLine(q))}</span>` : '';
  const meta = opts.fiche ? (by ? `<div class="ent-m">${by}</div>` : '') : `<div class="ent-m">${opts.name === false ? '' : `<b>${esc(nameCase(q.name))}</b>`}${epHTML(q)}${by ? ` · ${by}` : ''}</div>`;
  const lost = opts.remove && !q.live;                   // favori dont la réplique n'existe plus telle quelle
  return `<div class="ent" data-k="${k}">
    ${lost ? `<div class="ent-m">${esc(nameCase(q.name))} · réplique modifiée depuis : retirez-la avec le bouton « … »</div>` : meta}
    ${lost ? `<div class="ent-q">${typo(q.quote)}</div>` : `<button class="ent-q" data-act="goto">${opts.query ? highlight(q.quote, opts.query) : typo(q.quote)}</button>`}
    <span class="ent-on" aria-hidden="true">${icon('play')}</span>
    <button class="ent-more" data-act="menu" aria-haspopup="dialog" aria-label="Actions : ${esc(nameCase(q.name))}">${icon('more')}</button>
  </div>`;
}
// Menu d'une ligne (feuille d'actions d'iOS) ; chaque action ferme le menu
function openEntryMenu(q, ent, opts, onFav) {
  const playing = playingBtn && playingBtn === ent.querySelector('.ent-more');
  const fav = isFav(q);
  const row = (act, ic, lab, cls = '') => `<button class="gr${cls}" data-m="${act}">${icon(ic, 'mi')}<span class="k t">${lab}</span></button>`;
  const rows = [
    allQuotes.length && q.audio ? row('audio', playing ? 'pause' : 'play', playing ? 'Arrêter' : 'Écouter') : '',
    allQuotes.length && q.video ? row('video', 'film', 'Voir la scène') : '',
    q.live === false ? '' : allQuotes.length ? row('goto', 'quote', 'Ouvrir la réplique') : '',
    row('fav', fav ? 'star-f' : 'star', opts.remove ? 'Retirer des favoris' : fav ? 'Retirer des favoris' : 'Ajouter aux favoris'),
    row('share', 'share', 'Partager'),
  ].join('');
  const sheet = openSheet(`
    <div class="grab" aria-hidden="true"></div>
    <div class="sh-nav"><span></span><h2 id="sh-title">${esc(nameCase(q.name))}</h2><button class="r" id="sheet-close">OK</button></div>
    <p class="mq">${typo(q.quote)}</p>
    <div class="g">${rows}</div>`);
  sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
  sheet.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
    const m = b.dataset.m, more = ent.querySelector('.ent-more');
    if (m === 'share') { shareQuote(q, b).then(r => { if (r !== 'attente' && r !== 'délai') setTimeout(closeSheet, 700); }); return; }
    closeSheet();
    if (m === 'audio') playAudio(q.audio, more, q);
    else if (m === 'video') showVideo(q);
    else if (m === 'goto') gotoQuote(q);
    else if (m === 'fav') onFav();
  }));
}
const undoByEntry = new WeakMap();   // entrée de favori retirée → de quoi la remettre à sa place
// Délégation des actions d'une liste d'entrées ; list(k) rend la réplique de l'entrée k
function bindEntries(container, list, opts = {}) {
  const act = (a, ent) => {
    const q = list(+ent.dataset.k);
    if (!q) return;
    const what = a.dataset.act;
    if (what === 'goto') gotoQuote(q);
    else if (what === 'menu') openEntryMenu(q, ent, opts, () => favEntry(q, ent));
    else if (what === 'undo' && undoByEntry.has(ent)) {
      const { at, saved, rowHTML } = undoByEntry.get(ent);
      if (!isFav(saved)) {
        favorites.splice(Math.min(at, favorites.length), 0, saved);
        if (!saveFavorites()) { favorites = favorites.filter(f => f !== saved); a.textContent = 'Non enregistré'; return; }
      }
      ent.classList.remove('off');
      ent.querySelector('.ent-a.undo').remove();
      ent.querySelector('.ent-more').hidden = false;
      undoByEntry.delete(ent);
      opts.onCount?.();
      document.getElementById('sr-live').textContent = 'Remise dans les favoris.';
    }
  };
  // Favori depuis le menu ; dans Favoris : retirée tout de suite, la ligne reste en place, barrée, avec « Remettre »
  const favEntry = (q, ent) => {
    if (!opts.remove) {
      const ok = toggleFav(q);
      document.getElementById('sr-live').textContent = !ok ? 'Favori non enregistré : le stockage de l’appareil est plein ou bloqué.'
        : isFav(q) ? 'Ajoutée aux favoris.' : 'Retirée des favoris.';
      return;
    }
    const at = favorites.findIndex(f => sameQuote(f, q));
    const saved = favorites[at];
    if (at < 0) return;
    favorites.splice(at, 1);
    if (!saveFavorites()) { favorites.splice(at, 0, saved); document.getElementById('sr-live').textContent = 'Non enregistré : le stockage de l’appareil est plein ou bloqué.'; return; }
    ent.classList.add('off');
    ent.querySelector('.ent-more').hidden = true;
    ent.insertAdjacentHTML('beforeend', `<div class="ent-a undo"><span class="lab">Retirée des favoris</span><button class="cell un" data-act="undo">Remettre</button></div>`);
    undoByEntry.set(ent, { at, saved });
    opts.onCount?.();
    ent.querySelector('[data-act="undo"]').focus({ preventScroll: true });
  };
  let lastLong = 0, pressT = null, sx = 0, sy = 0;
  container.addEventListener('click', e => {
    if (Date.now() - lastLong < 700) { e.preventDefault(); return; }   // fin d'un toucher long : le menu est déjà ouvert
    const a = e.target.closest('[data-act]');
    const ent = a?.closest('.ent');
    if (a && ent) act(a, ent);
  });
  // toucher long sur une ligne = son menu
  container.addEventListener('touchstart', e => {
    clearTimeout(pressT);
    const ent = e.target.closest('.ent');
    if (!ent || ent.classList.contains('off') || e.target.closest('.ent-more, [data-act=undo]')) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    pressT = setTimeout(() => { lastLong = Date.now(); act(ent.querySelector('.ent-more'), ent); }, 500);
  }, { passive: true });
  container.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10) clearTimeout(pressT); }, { passive: true });
  ['touchend', 'touchcancel'].forEach(ev => container.addEventListener(ev, () => clearTimeout(pressT), { passive: true }));
  container.addEventListener('contextmenu', e => { if (e.target.closest('.ent')) e.preventDefault(); });
}

// ===== PERSONNAGES =====
let persSort = 'count';
let persTop = 0, persAll = false, persFilter = '';
let ficheState = null;          // fiche quittée pour ouvrir une réplique : { name, start, shown, top }
const isDuo = n => / ET /.test(n);
function renderPersonnages() {
  stopVideos();
  setMast(mastFor('personnages'));
  const main = document.getElementById('main-content');
  const chars = getCharList();
  // tri A→Z sur le nom sans article (« La Dame du Lac » sous D), lettres et tri calculés sur la même clé
  const sortKey = n => fold(n.replace(/^(LE|LA|LES)\s+|^L['’]\s*/, ''));
  const solo = chars.filter(([n]) => !isDuo(n)), duos = chars.filter(([n]) => isDuo(n));
  const az = persSort === 'alpha';
  const list = persSort === 'alpha' ? [...solo].sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0]), 'fr')) : solo;
  const MINOR = 5;
  const minors = persSort === 'count' ? solo.filter(([, c]) => c < MINOR).length : 0;
  const eps = charEpisodes();
  // une ligne façon Apple TV : vignette photo (ou initiale sur la couleur), nom, « N répliques · N épisodes », chevron
  const row = ([name, count], cls = '') => `<button class="idx-row${cls}" data-char="${esc(name)}" data-f="${esc(fold(nameCase(name)))}">${faceHTML(name, 's', 'av sq')}<span class="t"><span class="n">${esc(nameCase(name))}</span><span class="c">${plural(count, 'réplique')}${eps[name] ? ` · ${plural(eps[name], 'épisode')}` : ''}</span></span>${icon('chev', 'chev')}</button>`;
  let rows = '', letter = '';
  list.forEach(c => {
    if (persSort === 'alpha') {
      const l = sortKey(c[0]).charAt(0).toUpperCase();
      if (l !== letter) { letter = l; rows += `<div class="idx-l">${l}</div>`; }
    }
    if (minors && c[1] < MINOR && !rows.includes('idx-more')) rows += `<button class="idx-more" id="pers-more"><span class="av sq mono more-av" aria-hidden="true">${icon('people')}</span><span class="t"><span class="n">Rôles de passage</span><span class="c">${nf(minors)} personnages, moins de ${MINOR} répliques chacun</span></span>${icon('chev', 'chev')}</button>`;
    rows += row(c, minors && c[1] < MINOR ? ' minor' : '');
  });
  if (duos.length) rows += `<div class="idx-l voix">À plusieurs voix</div>` + duos.map(c => row(c, ' duo')).join('');
  // « Les plus présents » : grandes cartes photo qui défilent à l'horizontale (tri par répliques seulement)
  const top = az ? [] : solo.slice(0, 10);
  main.innerHTML = `
    <div class="scroll" id="pers-scroll">
      <div class="page-h"><h1 class="sr">Personnages</h1></div>
      <label class="pf field">${icon('search')}<input id="pers-filter" type="search" placeholder="Filtrer les noms" aria-label="Filtrer les noms" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></label>
      ${top.length ? `<div id="pers-top"><h2 class="h2">Les plus présents</h2><div class="shelf posters">${top.map(([n, c]) => `<button class="poster" data-char="${esc(n)}">${faceHTML(n, 'p', 'pc')}<b>${esc(nameCase(n))}</b><span>${plural(c, 'réplique')}</span></button>`).join('')}</div></div>` : ''}
      <div class="sec-h"><h2 class="h2" id="pers-h">${az ? 'De A à Z' : 'Tous'}<span class="hc"> · ${nf(solo.length)}</span></h2>
        <button class="sortb tbtn" data-sort="${az ? 'count' : 'alpha'}" aria-label="${az ? 'Trier par nombre de répliques' : 'Trier de A à Z'}">${az ? 'Par répliques' : 'De A à Z'}</button></div>
      <div class="perso-list${minors && !persAll ? ' collapsed' : ''}${az ? ' az' : ''}" id="pers-list">${rows}</div>
    </div>`;
  const sc = document.getElementById('pers-scroll'), listEl = document.getElementById('pers-list'), input = document.getElementById('pers-filter');
  const applyFilter = () => {
    const v = fold(input.value.trim());
    listEl.classList.toggle('filtering', !!v);
    const tp = document.getElementById('pers-top'); if (tp) tp.hidden = !!v;
    const sh = main.querySelector('.sec-h'); if (sh) sh.classList.toggle('filtering', !!v);
    listEl.querySelectorAll('.idx-row').forEach(r => { r.hidden = !!v && !r.dataset.f.includes(v); });
    // une lettre sans nom visible disparaît avec ses noms
    listEl.querySelectorAll('.idx-l').forEach(h => {
      let n = h.nextElementSibling, any = false;
      while (n && !n.classList.contains('idx-l')) { if (n.classList.contains('idx-row') && !n.hidden) any = true; n = n.nextElementSibling; }
      h.hidden = !!v && !any;
    });
  };
  input.value = persFilter;
  if (persFilter) applyFilter();
  input.addEventListener('input', () => { persFilter = input.value; applyFilter(); sc.scrollTop = 0; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  sc.addEventListener('touchstart', e => { if (e.target !== input) input.blur(); }, { passive: true });
  main.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => { persSort = b.dataset.sort; persTop = 0; renderPersonnages(); }));
  document.getElementById('pers-more')?.addEventListener('click', () => { persAll = true; listEl.classList.remove('collapsed'); });
  listEl.addEventListener('click', e => { const r = e.target.closest('.idx-row'); if (r) openPersonnage(r.dataset.char); });
  document.getElementById('pers-top')?.addEventListener('click', e => { const r = e.target.closest('[data-char]'); if (r) openPersonnage(r.dataset.char); });
  sc.scrollTop = persTop;
  sc.addEventListener('scroll', () => { persTop = sc.scrollTop; }, { passive: true });
}

// Page superposée (fiche personnage, scène) : l'en-tête reste visible, le reste de l'app est inerte dessous.
// overlayCtx dit ce qui est ouvert : { kind: 'fiche', snap() → position de la fiche } ou { kind: 'scene', from: fiche d'origine }
let overlayCtx = null;
function overlaySnapshot() { return !overlayCtx ? null : overlayCtx.kind === 'fiche' ? overlayCtx.snap() : overlayCtx.from || null; }
let overlayFocus = null;
let usingKeyboard = false;   // dernière interaction au clavier (sinon toucher / souris)

function openOverlay(html) {
  const overlay = document.getElementById('detail-overlay');
  if (overlay.classList.contains('hidden')) overlayFocus = document.activeElement;
  overlay.querySelectorAll('video').forEach(v => v.pause());
  overlayCtx = null;
  overlay.innerHTML = html;
  overlay.classList.remove('hidden');
  document.getElementById('mast-set').hidden = true;
  document.getElementById('mast-scope').hidden = true;
  document.getElementById('mast-back').hidden = true;
  // barre de navigation : transparente sur l'aplat, opaque (avec le titre) une fois l'aplat passé
  // (témoin au bas de l'aplat, suivi par IntersectionObserver sous la barre : aucun écouteur de défilement)
  const sc = overlay.querySelector('.scroll'), nb = overlay.querySelector('.back'), hero = overlay.querySelector('.fiche-h');
  if (sc && nb && !nb.classList.contains('solid')) {
    const s = document.createElement('i'); s.className = 'mast-sent'; s.setAttribute('aria-hidden', 'true');
    s.style.cssText = hero ? 'top:auto;bottom:8px;height:1px' : '';
    (hero || sc).append(s);
    if ('IntersectionObserver' in window) new IntersectionObserver(es => nb.classList.toggle('solid', !es[es.length - 1].isIntersecting), { root: sc, rootMargin: `-${nb.offsetHeight}px 0px 0px 0px` }).observe(s);
    else nb.classList.add('solid');
  }
  renderMini();
  // le retour est aussi en bas (pouce) : même action que « Retour » en haut
  overlay.querySelector('#detail-back2')?.addEventListener('click', () => overlay.querySelector('#detail-back')?.click());
  bindEdgeBack(overlay);
  document.getElementById('main-content').inert = true;
  // clavier : focus sur « Retour » ; toucher : focus sur la page elle-même (aucun contour visible)
  if (usingKeyboard) overlay.querySelector('#detail-back')?.focus({ preventScroll: true });
  else { overlay.setAttribute('tabindex', '-1'); overlay.focus({ preventScroll: true }); }
  navSoon();
  return overlay;
}
// Retour système (bouton ou geste d'Android, flèche du navigateur) : une seule entrée d'historique « témoin » tant qu'une
// feuille ou une page superposée est ouverte ; Retour la ferme (scène ouverte depuis une fiche : retour à la fiche).
// Fermée par l'app (bouton, glisser du bord gauche d'iOS) : le témoin est retiré, jamais de double retour ni d'entrée parasite.
let navMark = false, navIgnore = 0, navT = null;
// un autre onglet que Répliques compte aussi comme « ouvert » : Retour y ramène d'abord (convention Android), puis quitte
const navOpen = () => sheetOpen() || !document.getElementById('detail-overlay').classList.contains('hidden') || (!!backTo && currentView === 'citations')
  || (currentView !== 'citations' && !!allQuotes.length);
function navSoon() { clearTimeout(navT); navT = setTimeout(navSync, 0); }   // fermer puis rouvrir dans le même geste : rien ne bouge
function navSync() {
  const open = navOpen();
  if (open && !navMark) { history.pushState({ kaam: 1 }, ''); navMark = true; }
  else if (!open && navMark) {
    navMark = false;
    if (history.state?.kaam) { navIgnore++; history.back(); }       // déjà retiré par le navigateur : rien à faire
  }
}
function bindHistory() {
  // rechargé sur l'entrée témoin : rien n'est ouvert, on la retire
  if (history.state?.kaam) { navIgnore++; history.back(); }
  addEventListener('popstate', () => {
    if (navIgnore) { navIgnore--; navSoon(); return; }
    navMark = false;
    if (sheetOpen()) closeSheet();
    else if (!document.getElementById('detail-overlay').classList.contains('hidden')) { const b = document.getElementById('detail-back'); b ? b.click() : closeOverlay(); }
    else if (backTo && currentView === 'citations') goBack();
    else if (currentView !== 'citations') setView('citations');
    navSoon();
  });
}
// glisser depuis le bord gauche = Retour (convention iOS) ; écouteurs posés une seule fois
let edgeBound = false;
function bindEdgeBack(overlay) {
  if (edgeBound) return;
  edgeBound = true;
  let x0 = null, y0 = 0;
  overlay.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX < 28 ? t.clientX : null; y0 = t.clientY; }, { passive: true });
  overlay.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    if (x0 !== null && t.clientX - x0 > 70 && Math.abs(t.clientY - y0) < 60) overlay.querySelector('#detail-back')?.click();
    x0 = null;
  }, { passive: true });
}
function closeOverlay() {
  const overlay = document.getElementById('detail-overlay');
  overlay.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
  const was = !overlay.classList.contains('hidden');
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
  overlayCtx = null;
  document.getElementById('main-content').inert = false;
  if (was) setMast(mastFor(currentView));
  showMastSet();
  syncCardFav();
  renderMini();
  if (was && overlayFocus?.isConnected) overlayFocus.focus({ preventScroll: true });
  overlayFocus = null;
  navSoon();
}
// En-tête d'épisode de la fiche, en clair : « Livre IV · ép. 58 », « Film », « Inédit 3 »
function epLabel(q) {
  if (q.film) return 'Film';
  if (q.tr) return coteEp(q);
  if (q.inedit) return coteEp(q);
  return [q.livre ? `Livre\u00a0${q.livre}` : '', q.episode ? `ép.\u00a0${q.episode}` : ''].filter(Boolean).join(' · ');
}
const livreDe = q => q.film ? 'Film' : q.inedit ? 'Inédits' : q.part === 'dies' ? 'Dies Iræ' : q.part === 'pil' ? 'Pilotes' : q.livre || '';
const LIVRES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'Film', 'Inédits', 'Dies Iræ', 'Pilotes'];
function openPersonnage(name, restore) {
  stopVideos();
  setMast('Personnages');
  const quotes = allQuotes.filter(q => q.name === name);
  const epKey = epKeyOf;
  const epCount = new Map();
  quotes.forEach(q => epCount.set(epKey(q), (epCount.get(epKey(q)) || 0) + 1));
  const epTitre = q => q.film ? 'Premier volet' : q.inedit ? q.inedit.replace(/^Inédit \d\s*:\s*/, '') : q.part === 'dies' ? 'Dies Iræ' : titleCase(q.title || '');
  const byLivre = new Map();
  quotes.forEach(q => { const L = livreDe(q); if (L) byLivre.set(L, (byLivre.get(L) || 0) + 1); });
  const livres = LIVRES.filter(L => byLivre.has(L));
  const withAudio = quotes.filter(q => q.audio);
  const nm = nameCase(name);
  const hero = persoURL(name, 'w');   // grande image en tête (sinon l'aplat de couleur et l'initiale)
  let start = restore?.start || 0, shown = start, lastEp = null;
  const overlay = openOverlay(`
    <div class="back"><button id="detail-back" aria-label="Retour aux personnages">${icon('back')}</button><span class="nt" aria-hidden="true">${esc(nm)}</span></div>
    <div class="scroll" id="fiche-scroll">
      <header class="fiche-h${hero ? ' photo' : ''}">${hero ? `<span class="hero img" aria-hidden="true"><img src="${hero}" alt="" decoding="async"></span>` : ''}
        <div class="tx"><h1${nm.length > 13 ? ' class="long"' : ''}>${esc(nm)}</h1>
        <p class="part">${plural(quotes.length, 'réplique')} · ${plural(epCount.size, 'épisode')}</p></div>
      </header>
      <div class="pills fiche-acts${withAudio.length ? '' : ' one'}">
        ${withAudio.length ? `<button class="pill gray" id="f-play">${icon('play')}Écouter</button>` : ''}
        <button class="pill gray" id="f-rand">${icon('shuffle')}Aléatoire</button>
      </div>
      ${livres.length > 1 ? `<h2 class="h2">Livres</h2><div class="livres glist" role="group" aria-label="Aller au Livre">${livres.map(L => `<button class="gl-row" data-livre="${L}"><span class="k">${esc(livreNom(L))}</span><span class="d">${plural(byLivre.get(L), 'réplique')}</span>${icon('chev', 'chev')}</button>`).join('')}</div>` : ''}
      <h2 class="h2">Répliques</h2>
      <div id="fiche-list" class="fiche"></div>
    </div>`);
  const sc = overlay.querySelector('#fiche-scroll');
  const listEl = overlay.querySelector('#fiche-list');
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { if (es[0].isIntersecting) more(); }, { root: sc, rootMargin: '600px 0px' }) : null;
  const more = (n = 50) => {
    io?.disconnect();
    listEl.querySelector('.more:not(.top)')?.remove();
    const next = quotes.slice(shown, shown + n);
    let html = '';
    next.forEach((q, j) => {
      const k = epKey(q);
      if (k !== lastEp) {
        lastEp = k;
        const nk = epCount.get(k);
        html += `<div class="ep-h"><span class="t">${typo(epTitre(q) || epLabel(q))}</span><span class="c">${esc(epLabel(q))}</span><span class="n">${plural(nk, 'réplique')}</span></div>`;
      }
      html += entHTML(q, shown + j, { fiche: true });
    });
    listEl.insertAdjacentHTML('beforeend', html);
    shown += next.length;
    if (shown < quotes.length) {
      listEl.insertAdjacentHTML('beforeend', `<button class="more tbtn">Afficher les 50 suivantes · ${nf(quotes.length - shown)} restantes</button>`);
      const b = listEl.querySelector('.more:not(.top)');
      b.addEventListener('click', () => more());
      io?.observe(b);
    }
  };
  const from = s0 => {
    start = s0; shown = s0; lastEp = null;
    listEl.innerHTML = s0 > 0 ? `<button class="more top tbtn">Revenir au début · ${nf(s0)} répliques avant</button>` : '';
    listEl.querySelector('.more.top')?.addEventListener('click', () => { from(0); sc.scrollTop = 0; });
  };
  from(start);
  more(restore ? Math.max(50, restore.shown - start) : 50);
  if (restore) sc.scrollTop = restore.top;
  overlay.querySelectorAll('[data-livre]').forEach(b => b.addEventListener('click', () => {
    const s0 = quotes.findIndex(q => livreDe(q) === b.dataset.livre);
    if (s0 < 0) return;
    from(s0); more();
    sc.scrollTop = listEl.offsetTop - overlay.querySelector('.back').offsetHeight - 8;
  }));
  bindEntries(listEl, k => quotes[k]);
  overlay.querySelector('#f-rand').addEventListener('click', () => gotoQuote(rand(quotes)));   // la fiche est retrouvée au retour
  // Écouter : une de ses répliques avec son, ouverte et jouée dans le geste
  overlay.querySelector('#f-play')?.addEventListener('click', () => {
    const q = rand(withAudio); gotoQuote(q);
    const b = document.getElementById('btn-audio');
    if (b && !playingBtn) playAudio(q.audio, b, allQuotes[quoteIdx]);
  });
  overlayCtx = { kind: 'fiche', snap: () => ({ name, start, shown, top: sc.scrollTop }) };
  overlay.querySelector('#detail-back').addEventListener('click', () => { stopVideos(); ficheState = null; closeOverlay(); });
}

// ===== RECHERCHE =====
// Débuts de mot, dans l'ordre d'abord, puis tous les mots dans n'importe quel ordre ; ni titres ni noms (un résultat montre toujours pourquoi il est là)
const foldIx = s => ' ' + strip(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
let IX = null;
function buildIndex() { if (!IX || IX.src !== allQuotes) IX = { src: allQuotes, q: allQuotes.map(x => foldIx(x.quote)) }; }
// Index de recherche et pool du quiz préparés en arrière-plan, 1,5 s après l'ouverture, par tranches courtes :
// la première frappe dans Chercher et l'ouverture du Quiz ne gèlent plus l'écran (buildIndex reste le repli immédiat)
function buildIndexSoon() {
  const src = allQuotes, q = new Array(src.length), m = {};
  let k = 0;
  const step = () => {
    if (src !== allQuotes) return;                                  // données rechargées entre-temps
    const end = Math.min(k + 2000, src.length);
    for (; k < end; k++) {
      if (!IX || IX.src !== src) q[k] = foldIx(src[k].quote);
      if (quizAccepts(src[k])) (m[src[k].name] = m[src[k].name] || []).push(k);
    }
    if (k < src.length) { setTimeout(step, 0); return; }
    if (!IX || IX.src !== src) IX = { src, q };
    if (!quizByChar || quizByChar.src !== src) quizByChar = { src, m };
  };
  setTimeout(step, 1500);
}
function searchHits(query) {
  buildIndex();
  const toks = foldIx(query).trim().split(' ').filter(Boolean);
  if (!toks.length) return null;
  const phrase = ' ' + toks.join(' ');
  const text = [], loose = [];
  for (let i = 0; i < allQuotes.length; i++) {
    const h = IX.q[i];
    if (h.includes(phrase)) text.push(allQuotes[i]);
    else if (toks.length > 1 && toks.every(t => h.includes(' ' + t))) loose.push(allQuotes[i]);
  }
  const who = getCharList().filter(([n]) => !isDuo(n) && foldIx(n).startsWith(phrase)).slice(0, 3);
  return { text: text.concat(loose), who };
}
// Ce qu'on cherchait reste là quand on revient sur l'onglet (texte, nombre d'entrées affichées, défilement).
// Portée : Partout par défaut ; « sel » = la sélection (segment visible si elle n'est pas Tout Kaamelott), pour la session.
const searchState = { q: '', top: 0, shown: 40, scope: 'all' };
let searchTimeout = null;
function renderRecherche() {
  stopVideos();
  setMast(mastFor('recherche'));
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="search"><label class="field">${icon('search')}
      <input type="search" id="search-input" placeholder="Un mot, une réplique, un nom" aria-label="Rechercher une réplique" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <button class="clr" id="search-clear" aria-label="Effacer">${icon('x')}</button></label>
      <div class="scopebar" id="search-scope" hidden></div>
    </div>
    <div class="scroll" id="search-results"></div>`;
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const clr = document.getElementById('search-clear');
  const scopeBar = document.getElementById('search-scope');
  // contrôle segmenté « Partout | <sélection> », comme le champ de recherche de Mail
  const drawScope = v => {
    const show = !selAll() && v.length >= 2;
    scopeBar.hidden = !show;
    if (!show) return;
    const lab = scopeLabel(), on = searchState.scope === 'sel';
    scopeBar.innerHTML = `<div class="seg" role="radiogroup" aria-label="Chercher dans"><button role="radio" class="${on ? '' : 'on'}" aria-checked="${!on}" data-scope="all">Partout</button>`
      + `<button role="radio" class="${on ? 'on' : ''}" aria-checked="${on}" data-scope="sel"><span class="sl">${esc(lab)}</span></button></div>`;
  };
  scopeBar.addEventListener('click', e => {
    const b = e.target.closest('[data-scope]');
    if (!b || b.dataset.scope === searchState.scope) return;
    searchState.scope = b.dataset.scope; searchState.top = 0; searchState.shown = 40;
    run(input.value.trim(), false);
    scopeBar.querySelector(`[data-scope="${searchState.scope}"]`)?.focus({ preventScroll: true });
  });
  const idle = () => {
    results.innerHTML = `<div class="res-n" role="status">${nf(allQuotes.length)} répliques. Les accents et la ponctuation sont facultatifs.</div>`;
  };
  const run = (v, keep) => {
    clr.hidden = !input.value;
    drawScope(v);
    if (!v) { idle(); return; }
    if (v.length < 2) { results.innerHTML = `<div class="res-n" role="status">Encore une lettre.</div>`; return; }
    doSearch(v, results, keep);
  };
  input.value = searchState.q;
  run(searchState.q.trim(), true);
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchState.q = input.value; searchState.top = 0; searchState.shown = 40;
    clr.hidden = !input.value;
    const v = input.value.trim();
    searchTimeout = setTimeout(() => run(v, false), v.length < 2 ? 0 : 80);
  });
  // la touche « Rechercher » du clavier et un toucher sur la liste rangent le clavier
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  results.addEventListener('touchstart', () => input.blur(), { passive: true });
  // la liste qu'on quitte (réplique ouverte) peut encore émettre un défilement à 0 en se vidant : ignoré, la position est gardée
  results.addEventListener('scroll', () => { if (currentView === 'recherche' && results.isConnected) searchState.top = results.scrollTop; }, { passive: true });
  clr.addEventListener('click', () => { input.value = ''; searchState.q = ''; searchState.top = 0; searchState.shown = 40; run('', false); input.focus(); });
  if (!searchState.q) input.focus();       // jamais le clavier par-dessus des résultats qu'on venait chercher
}
function doSearch(query, container, keep) {
  const res = searchHits(query);
  const every = res ? res.text : [];
  const scoped = searchState.scope === 'sel' && !selAll();
  const hits = scoped ? every.filter(inSel) : every;
  const partout = scoped ? ` · ${nf(every.length)} partout` : '';
  // la requête désigne un personnage : une ligne de renvoi vers sa fiche, puis les répliques qui contiennent le mot
  const who = (res?.who || []).map(([n, c]) => `<button class="res-who idx-like" data-name="${esc(n)}">${faceHTML(n)}<span class="t"><span class="n">${esc(nameCase(n))}</span><span class="c">${plural(c, 'réplique')}</span></span>${icon('chev', 'chev')}</button>`).join('');
  const bindWho = () => container.querySelectorAll('.res-who').forEach(b => b.addEventListener('click', () => openPersonnage(b.dataset.name)));
  if (!hits.length) {
    container.innerHTML = (who ? `<h2 class="res-h">Personnages</h2>${who}` : '') + (scoped && every.length
      ? `<div class="empty"><span class="ei">${icon('search')}</span><b>Rien dans cette sélection.</b><small>${plural(every.length, 'réplique')} partout : touchez « Partout ».</small></div>`
      : `<div class="empty">${who ? '' : `<span class="ei">${icon('search')}</span>`}<b>${who ? 'Aucune réplique ne contient ce mot.' : `Rien pour « ${esc(query)} ».`}</b><small>Vérifiez l’orthographe, ou essayez le début d’un mot.</small></div>`);
    bindWho();
    return;
  }
  let shown = 0;
  container.innerHTML = who
    ? `<h2 class="res-h">Personnages</h2>${who}<div class="res-h" role="status">Répliques<b>${nf(hits.length)}${partout}</b></div><div id="res-list"></div>`
    : `<div class="res-n" role="status">${nf(hits.length)} réplique${hits.length > 1 ? 's' : ''}${partout}</div><div id="res-list"></div>`;
  bindWho();
  const listEl = container.querySelector('#res-list');
  const more = n => {
    listEl.querySelector('.more')?.remove();
    const next = hits.slice(shown, shown + (n || 40));
    listEl.insertAdjacentHTML('beforeend', next.map((q, j) => entHTML(q, shown + j, { query })).join(''));
    shown += next.length;
    searchState.shown = shown;
    if (shown < hits.length) {
      listEl.insertAdjacentHTML('beforeend', `<button class="more tbtn">Afficher la suite · ${nf(hits.length - shown)} restantes</button>`);
      listEl.querySelector('.more').addEventListener('click', () => more());
    }
  };
  more(keep ? Math.max(40, searchState.shown) : 40);
  bindEntries(listEl, k => hits[k]);
  if (keep) container.scrollTop = searchState.top;
}

// ===== FAVORIS =====
// Les favoris sont gardés tels qu'enregistrés ; on retrouve la réplique à jour (son, scène) par son index stable i, puis par texte et nom
let byI = null;
function parI(i) {
  if (!byI || byI.src !== allQuotes) byI = { src: allQuotes, m: new Map(allQuotes.map(q => [q.i, q])) };
  return byI.m.get(+i) || null;
}
function liveQuote(f) {
  if (!allQuotes.length) return { ...f, live: true };
  const hit = (f.i != null && parI(f.i)) || null;
  if (hit && hit.quote === f.quote) return { ...hit, live: true };
  const t = allQuotes.find(x => sameQuote(f, x));
  return t ? { ...t, live: true } : { ...f, live: false };
}
function renderFavoris() {
  stopVideos();
  setMast(mastFor('favoris'));
  const main = document.getElementById('main-content');
  if (!favorites.length) {
    main.innerHTML = `<div class="scroll"><div class="page-h"><h1 class="sr">Favoris</h1></div>
      <div class="empty fav0"><span class="ei">${icon('star')}</span><b>Aucun favori</b><small>Touchez ☆ sur une réplique pour la garder ici.</small>${allQuotes.length ? '<button class="tbtn" id="fav-open">Réplique au hasard</button>' : ''}</div></div>`;
    document.getElementById('fav-open')?.addEventListener('click', () => { quoteIdx = pickRandom(); setView('citations'); });
    return;
  }
  const list = favorites.map(liveQuote);
  const sub = () => { const n = favorites.length; return `${nf(n)} réplique${n > 1 ? 's' : ''} enregistrée${n > 1 ? 's' : ''}${n > 1 ? ' · la plus récente en tête' : ''}`; };
  const playable = () => list.filter(q => q.live && favorites.some(f => sameQuote(f, q)));
  main.innerHTML = `<div class="scroll"><div class="page-h"><h1 class="sr">Favoris</h1><p id="fav-count">${sub()}</p>${ongletIOS()
      ? '<p class="fav-garde">Pour ne jamais les perdre, ajoutez Kaamelott à l’écran d’accueil (Partager, puis « Sur l’écran d’accueil ») : Safari efface les données d’un site non ouvert pendant 7 jours.</p>' : ''}</div>
    ${allQuotes.length ? `<div class="pills"><button class="pill gray" id="fav-play">${icon('play')}Lecture</button><button class="pill gray" id="fav-rand">${icon('shuffle')}Aléatoire</button></div>` : ''}
    <div id="fav-list">${list.map((q, k) => entHTML(q, k, { remove: true })).join('')}</div></div>`;
  // plus aucun favori lisible (dernier retiré, ou répliques modifiées depuis) : Lecture et Aléatoire grisés, jamais un bouton qui ne fait rien
  const pillsState = () => { const none = !playable().length; ['fav-play', 'fav-rand'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = none; }); };
  bindEntries(main.querySelector('#fav-list'), k => list[k], { remove: true, onCount: () => { document.getElementById('fav-count').textContent = sub(); pillsState(); } });
  pillsState();
  // Lecture : la plus récente (avec son, de préférence) ; Aléatoire : une au hasard. Le son part dans le geste.
  const open = q => { if (!q) return; gotoQuote(q); const b = document.getElementById('btn-audio'); if (b && q.audio && !playingBtn) playAudio(q.audio, b, allQuotes[quoteIdx]); };
  document.getElementById('fav-play')?.addEventListener('click', () => { const P = playable(); open(P.find(q => q.audio) || P[0]); });
  document.getElementById('fav-rand')?.addEventListener('click', () => { const P = playable(); open(P.length ? rand(P) : null); });
}

// Lecteur sans commandes : toucher la vidéo la rejoue depuis le début, son activé
function replayVideo(v) {
  player.pause(); setPlayingBtn(null);          // jamais deux sons à la fois
  v.muted = false; seekStart(v);
  v.play().catch(() => {});
}

// ===== SCÈNE EN GRAND (« Scène ») =====
function showVideo(q) {
  stopAudio();
  const fromFiche = overlayCtx?.kind === 'fiche' ? overlayCtx.snap() : null;   // scène ouverte depuis une fiche : « Retour » y ramène
  setMast('Scène');
  const overlay = openOverlay(`
    <div class="back solid"><button id="detail-back" aria-label="Retour">${icon('back')}</button><span class="nt">Scène</span></div>
    <div class="scroll scene-page">
      ${sceneHTML(q, 'mfig')}
      <figure class="body">
        <blockquote class="quote" lang="fr" style="font-size:${Math.round(Math.min(quoteSize(q.quote), Q_MAX.scene) * textScale())}px">${quoteHTML(q.quote)}</blockquote>
        <div class="meta"><div class="who-b"><button class="who" id="m-who" aria-label="${esc(nameCase(q.name))}, voir la fiche du personnage">${esc(nameCase(q.name))}</button>
          ${fmtEp(q) ? `<p class="src">${epHTML(q)}</p>` : ''}${byHTML(q)}</div>
          <button class="ic fav${isFav(q) ? ' on' : ''}" id="m-fav" aria-pressed="${isFav(q)}">${favFace(isFav(q))}</button></div>
      </figure>
      <div class="pills">
        <button class="pill gray" id="m-share">${icon('share')}<span class="t">Partager</span></button>
        <button class="pill gray" id="m-goto">Voir la réplique</button>
      </div>
    </div>`);
  const fig = document.getElementById('mfig');
  const v = document.createElement('video');
  v.className = 'quote-video'; v.id = 'mvideo';
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  wireScene(v); watchWin(v);
  fig.querySelector('.frame').prepend(v);
  fig.dataset.src = playURL(q);
  if (offlineMiss(fig.dataset.src)) setScene(v, 'error');
  else { v.src = mediaSrc(fig.dataset.src); setScene(v, 'loading'); }
  bindScene(fig, v);
  v.muted = false;
  v.play().catch(e => { if (e.name === 'NotAllowedError') { v.muted = true; v.play().catch(() => {}); } });
  const fav = document.getElementById('m-fav');
  fav.addEventListener('click', () => favButton(fav, q));
  document.getElementById('m-share').addEventListener('click', e => shareQuote(q, e.currentTarget));
  document.getElementById('m-goto').addEventListener('click', () => gotoQuote(q));
  document.getElementById('m-who').addEventListener('click', () => openPersonnage(q.name));
  overlayCtx = { kind: 'scene', from: fromFiche };
  document.getElementById('detail-back').addEventListener('click', () => {
    if (fromFiche) { v.pause(); openPersonnage(fromFiche.name, fromFiche); } else closeOverlay();
  });
  return overlay;
}

// ===== NAVIGATION ENTRE ONGLETS =====
function bindNav() {
  document.getElementById('bottom-nav').querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      const ovOpen = !document.getElementById('detail-overlay').classList.contains('hidden');
      if (btn.dataset.view === 'personnages' && (ovOpen || currentView === 'personnages')) ficheState = null;   // convention iOS : retour à l'index
      if (btn.dataset.view !== currentView || ovOpen) setView(btn.dataset.view);
    });
  });
}
// pendant le chargement et sur l'écran d'erreur, les onglets sans objet sont désactivés (Favoris reste ouvert après une erreur)
function setTabsEnabled(on) {
  const nav = document.getElementById('bottom-nav');
  nav.classList.toggle('off', !on);
  nav.querySelectorAll('.nav-btn').forEach(b => {
    if (on) { b.classList.remove('keep'); b.removeAttribute('aria-disabled'); }
    else if (!b.classList.contains('keep')) b.setAttribute('aria-disabled', 'true');
  });
}
function keepTabs(views) {
  document.querySelectorAll('.nav-btn').forEach(b => { if (views.includes(b.dataset.view)) { b.classList.add('keep'); b.removeAttribute('aria-disabled'); } });
}
function setView(view) {
  if (!allQuotes.length && view !== 'favoris') {         // répliques pas encore chargées : seuls les favoris s'ouvrent
    if (view === 'citations' && !booting) { currentView = 'citations'; boot(); }
    return;
  }
  if (reloadIfIdle(view)) return;          // nouvelle version : rechargée, la vue demandée s'ouvrira après
  stopVideos();                            // le son continue d'un onglet à l'autre (mini-lecteur) ; Répliques le reprend ou l'arrête
  closeSheet();
  closeOverlay();
  backTo = null;
  currentView = view;
  if (view !== 'quiz') quizDaily = false;
  refreshScope();
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if      (view === 'citations')   renderCitations();
  else if (view === 'quiz')        renderQuiz();
  else if (view === 'personnages') { renderPersonnages(); if (ficheState) { const f = ficheState; ficheState = null; openPersonnage(f.name, f); } }
  else if (view === 'recherche')   renderRecherche();
  else if (view === 'favoris')     renderFavoris();
  showMastSet();
  renderMini();
  // le mini-lecteur vient d'apparaître sous le quiz : la question est réajustée à la place qui reste (jamais coupée)
  if (view === 'quiz') fitQuiz(document.getElementById('quiz-stage'));
  navSoon();                               // autre onglet que Répliques : une entrée témoin, Retour y ramène
}

// ===== SERVICE WORKER ET MISES À JOUR =====
// Une nouvelle version n'est jamais appliquée en plein geste : on recharge seulement à un moment neutre
// (retour au premier plan, changement d'onglet, aucune feuille ni page superposée ouverte), et jamais au tout premier lancement.
let updatePending = false;
// vrai si la page recharge ; la vue demandée (ou la vue en cours) est rouverte après le rechargement
function reloadIfIdle(view) {
  if (updatePending && !sheetOpen() && document.getElementById('detail-overlay').classList.contains('hidden')) {
    updatePending = false;
    try { sessionStorage.setItem('kaam_after_reload', view || currentView); } catch {}
    location.reload();
    return true;
  }
  return false;
}
// Écran « Code d'accès » : les répliques ne se chargent qu'avec le code (cookie posé par api/acces.js, 400 jours).
// Aucun focus automatique (iOS : pas de clavier imposé à l'ouverture).
function renderAcces() {
  setMast('Kaamelott');
  keepTabs(['citations']);
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="empty acces"><span class="ei">${icon('person')}</span><span class="err-k">Code d’accès</span>Entrez le code qu’on vous a donné pour ouvrir l’app.
      <form class="acces-f" id="acces-f" novalidate>
        <input id="acces-code" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-label="Code d’accès" aria-describedby="acces-msg">
        <button class="pill" type="submit">Entrer</button>
      </form><small id="acces-msg" role="alert"></small></div>`;
  const f = document.getElementById('acces-f'), msg = document.getElementById('acces-msg'), btn = f.querySelector('button');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const code = document.getElementById('acces-code').value.trim();
    if (!code) { msg.textContent = 'Entrez le code.'; return; }
    btn.disabled = true; msg.textContent = '';
    try {
      const r = await fetch('/api/acces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (r.ok) { boot(); return; }
      msg.textContent = r.status === 401 ? 'Code incorrect.' : r.status === 429 ? 'Trop d’essais : réessayez dans une heure.' : 'Serveur indisponible, réessayez.';
    } catch { msg.textContent = navigator.onLine === false ? 'Hors ligne : il faut du réseau pour entrer le code.' : 'Serveur indisponible, réessayez.'; }
    btn.disabled = false;
  });
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadCtrl = !!navigator.serviceWorker.controller;   // une version tournait déjà
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    // code changé ou absent : les répliques en cache sont retirées, la page recharge une seule fois (jamais de boucle)
    if (e.data?.type === 'ACCES') {
      try { if (sessionStorage.getItem('kaam_acces_recharge')) return; sessionStorage.setItem('kaam_acces_recharge', '1'); } catch { return; }
      location.reload(); return;
    }
    if (e.data?.type === 'DATA_UPDATED') { updatePending = true; return; }   // nouvelles répliques : rechargement au moment neutre
    if (e.data?.type !== 'SW_UPDATED' || !hadCtrl) return;
    updatePending = true;
  });
}
// L'app installée sur l'écran d'accueil ne « navigue » pas quand iOS la rouvre : on cherche une nouvelle version
// au retour au premier plan, au plus une fois par heure
let lastUpdateCheck = Date.now();
function onVisible() {
  loadAvisTous();
  if (Date.now() - lastUpdateCheck > 3600e3) {
    lastUpdateCheck = Date.now();
    navigator.serviceWorker?.getRegistration().then(r => r && r.update()).catch(() => {});
  }
  reloadIfIdle();
}

// ===== DÉMARRAGE =====
let retryTimer = null, autoRetried = false, booting = false, waitingOnline = false;
async function boot() {
  if (booting || window.__kaamVieux) return;   // appareil trop ancien (compat.js) : son message reste à l'écran                     // jamais deux démarrages en parallèle (Réessayer, retour du réseau, minuteur)
  clearTimeout(retryTimer);
  booting = true;
  currentView = 'citations';
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'citations'));
  const main = document.getElementById('main-content');
  setTabsEnabled(false);
  const launch = document.getElementById('launch');
  if (launch) {
    // premier démarrage : l'écran de lancement (K blanc sur noir) couvre tout ; la barre ne vient qu'après 1 s d'attente.
    // Le <div class="boot"> vide d'index.html reste dessous (compat.js y écrit si l'appareil est trop ancien).
    launchSlowT = setTimeout(() => launch.querySelector('.launch-slow')?.classList.add('on'), 1000);
  } else {
    // « Réessayer », retour du réseau : chargement dans la page
    main.innerHTML = `<div class="boot" role="status"><div class="spin" aria-hidden="true"></div><div class="t">Chargement des répliques…</div><div class="rail indet"><i></i></div><div class="m"></div>
      <p hidden>Premier lancement : plus de 33 000 répliques sont téléchargées une seule fois, puis l’app s’ouvre sans attendre, même hors ligne.</p></div>`;
    // l'explication n'apparaît que si l'attente dure (jamais de clignotement quand les répliques sortent du cache)
    setTimeout(() => { const p = document.querySelector('.boot p'); if (p) p.hidden = false; }, 1500);
  }
  try {
    await loadData();
  } catch (e) {
    booting = false;
    endLaunch();                           // l'écran d'erreur doit se voir
    if (e.acces) { renderAcces(); return; }
    console.error('Chargement des répliques :', e);
    const offline = navigator.onLine === false;
    setMast('Répliques');
    main.innerHTML = `
      <div class="empty err"><span class="ei">${icon(offline ? 'offline' : 'warn')}</span><span class="err-k">${offline ? 'Hors ligne' : 'Serveur indisponible'}</span>${offline
        ? 'Les répliques n’ont pas encore été téléchargées sur cet appareil.<small>Elles le seront dès le retour du réseau, sans rien faire. Il faut une seule connexion, ensuite l’app fonctionne hors ligne.</small>'
        : `Impossible de charger les répliques pour le moment.<small>Le site est peut-être en cours de mise à jour.${autoRetried ? '' : ' Nouvel essai automatique dans 10 s.'}</small>`}
        <div class="row2"><button class="pill" id="btn-retry">Réessayer</button><button class="pill gray" id="btn-myfav">Mes favoris</button></div>
      </div>`;
    // les favoris sont gardés sur l'appareil avec leur texte : ils restent consultables
    keepTabs(['favoris', 'citations']);
    document.getElementById('btn-retry').addEventListener('click', boot);
    document.getElementById('btn-myfav').addEventListener('click', () => setView('favoris'));
    if (offline && !waitingOnline) {         // un seul écouteur, quel que soit le nombre d'échecs
      waitingOnline = true;
      window.addEventListener('online', () => { waitingOnline = false; if (!allQuotes.length) boot(); }, { once: true });
    }
    else if (!offline && !autoRetried) { autoRetried = true; retryTimer = setTimeout(() => { if (!allQuotes.length && currentView === 'citations') boot(); }, 10000); }
    return;
  }
  booting = false;
  quoteIdx = pickRandom();
  randHistory = []; randPos = -1; pushHistory(quoteIdx);
  setTabsEnabled(true);
  // après un rechargement de mise à jour, on rouvre la vue que l'utilisateur avait demandée
  let after = null;
  try { after = sessionStorage.getItem('kaam_after_reload'); sessionStorage.removeItem('kaam_after_reload'); } catch {}
  try {
    setView(after && after in VIEWS ? after : 'citations');
  } catch (e) {
    // un bug d'affichage n'est pas une panne du serveur : on le dit, sans retélécharger les répliques
    console.error('Affichage :', e);
    showRenderError();
  }
  endLaunch();
  sendAvis();
  buildIndexSoon();
}
const VIEWS = { citations: 1, quiz: 1, personnages: 1, recherche: 1, favoris: 1 };
// Fin de l'écran de lancement : aucune durée minimale ; fondu de 250 ms une fois la première vue peinte dessous
let launchSlowT = null;
function endLaunch() {
  const l = document.getElementById('launch');
  if (!l) return;
  clearTimeout(launchSlowT);
  // deux images : la vue est peinte sous le noir avant que le fondu commence, donc jamais d'écran vide
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('launching');
    document.documentElement.style.removeProperty('background');           // sinon noir sous le rebond du défilement en clair
    document.getElementById('meta-cs')?.setAttribute('content', 'light dark');
    l.classList.add('out');
    l.addEventListener('transitionend', () => l.remove(), { once: true });
    setTimeout(() => l.remove(), 400);      // filet si transitionend ne vient pas
  }));
}
function showRenderError() {
  const main = document.getElementById('main-content');
  setMast('Répliques');
  main.innerHTML = `<div class="empty err"><span class="ei">${icon('warn')}</span><span class="err-k">Erreur d’affichage</span>Une réplique n’a pas pu s’afficher.<small>Les répliques sont bien chargées : essayez-en une autre.</small>
    <div class="row2"><button class="pill" id="btn-retry">Autre réplique</button><button class="pill gray" id="btn-myfav">Mes favoris</button></div></div>`;
  document.getElementById('btn-retry').addEventListener('click', () => {
    quoteIdx = pickRandom();
    try { setView('citations'); } catch (e) { console.error('Affichage :', e); showRenderError(); }
  });
  document.getElementById('btn-myfav').addEventListener('click', () => setView('favoris'));
}
// Point d'accès stable pour le banc de test (tests/e2e) : lecture de l'état et fonctions existantes, rien de nouveau.
// Le banc ne dépend que de ce pont : les noms internes peuvent changer sans le casser.
window.__kaam = {
  get avisTous() { return avisTous; }, fpOf, loadAvisTous,
  get avisCoupes() { return avisCoupes; }, set avisCoupes(v) { avisCoupes = v; },
  get avisDemandes() { return avisDemandes; }, set avisDemandes(v) { avisDemandes = v; },
  get mesCoupes() { return mesCoupes; }, get mesDemandes() { return mesDemandes; },
  fenetre, openCoupe, get cardVideo() { return cardVideo; },
  get allQuotes() { return allQuotes; },
  get quoteIdx() { return quoteIdx; }, set quoteIdx(v) { quoteIdx = v; },
  get verifyIdx() { return verifyIdx; },
  get avisFaits() { return avisFaits; },
  get avisFile() { return avisFile; },
  get quizState() { return quizState; },
  get favorites() { return favorites; },
  get player() { return player; },
  get perso() { return PERSO; }, set perso(v) { PERSO = v; },
  get sel() { return sel; },
  get media() { return media; },
  get counts() { return partCounts(); },
  scopeLabel: s => scopeLabel(s),
  poolEmpty: () => poolEmpty(),
  pool: () => pool(),
  render: dir => renderCitations(dir),
  random: () => randomQuote(),
  rebuildVerify: () => rebuildVerify(),
  sendAvis: () => sendAvis(),
};
// ===== ÉCOUTEURS GLOBAUX (tous ici ; l'ordre des écouteurs en capture compte pour le déblocage du son iOS) =====
function bindGlobalEvents() {
  // iOS n'autorise le son qu'après un toucher : le premier toucher, clic ou touche, où que ce soit, le débloque
  ['touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, unlockSound, { capture: true }));
  // dernière interaction : clavier (focus visible sur « Retour », « Question suivante ») ou toucher
  document.addEventListener('keydown', e => { if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Enter') usingKeyboard = true; }, true);
  ['pointerdown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { usingKeyboard = false; }, { capture: true, passive: true }));
  document.addEventListener('touchstart', () => {}, { passive: true });   // iOS n'applique :active qu'avec un écouteur tactile
  document.addEventListener('error', onImgError, true);                       // portrait introuvable : l'initiale reste
  document.addEventListener('load', onImgLoad, true);                         // portrait vide (hors ligne) : de même
  document.addEventListener('keydown', onArrowKeys);                         // flèches : réplique suivante / précédente
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });
  // réseau : « Hors ligne » dans l'en-tête ; au retour du réseau, envoi des avis en attente
  ['online', 'offline'].forEach(ev => window.addEventListener(ev, refreshMast));
  window.addEventListener('online', sendAvis);
  setInterval(() => { if (document.visibilityState === 'visible') loadAvisTous(); }, 180e3);   // ce que les autres ont vérifié
  // arrière-plan : envoi des avis ; premier plan : nouvelle version éventuelle
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendAvis(); else onVisible(); });
  if (window.visualViewport) ['resize', 'scroll'].forEach(ev => visualViewport.addEventListener(ev, fitSheetToKeyboard));
}
document.addEventListener('DOMContentLoaded', () => {
  bindGlobalEvents();
  loadFavorites();
  registerSW();
  bindNav();
  bindMini();
  watchMast();
  watchResize();
  bindHistory();
  document.getElementById('mast-set').addEventListener('click', openSettings);
  document.getElementById('mast-back').addEventListener('click', goBack);
  document.getElementById('mast-scope').addEventListener('click', () => showSelection('scope'));
  boot();
});
