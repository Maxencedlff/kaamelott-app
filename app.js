'use strict';

// ===== STATE =====
let allQuotes = [];       // parsed quotes
let favorites = [];       // saved quotes
let currentView = 'citations';
let currentQuote = null;
let quoteIdx = 0;
let quizState = null;
let detailChar = null;

// ===== SONS =====
// Seules certaines répliques ont un extrait sonore (champ "audio" de data.json)
let audioIdx = [];        // index (dans allQuotes) des répliques avec son
let audioOnly = readPref('kaam_audio_only');   // n'afficher que les répliques avec son
// ===== VIDÉOS (extraits hébergés sur Hugging Face) =====
const VIDEO_BASE = 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/v/';   // v/<2 premiers caractères>/<clé>.mp4
let videoIdx = [];        // index des répliques avec extrait vidéo
let videoOnly = readPref('kaam_video_only');   // mode vidéo : seulement ces répliques, scène jouée dans la carte
// Sons automatiques (sons/auto/<clé>.m4a) : hébergés sur Hugging Face, dans s/<2 premiers caractères>/ ;
// les quelques sons manuels (sons/*.mp3) restent sur le site
const AUDIO_BASE = 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/s/';
// Extrait refait (champs "v" pour le son, "vv" pour la vidéo, dans data.json) : ?v=<n> dans l'URL pour ne pas resservir l'ancienne version en cache
function audioURL(src) {
  const m = /^sons\/auto\/([^?]+\.m4a)(\?.*)?$/.exec(src || '');
  return m ? `${AUDIO_BASE}${m[1].slice(0, 2)}/${m[1]}${m[2] || ''}` : src;
}
function videoURL(q) { return q.video ? `${VIDEO_BASE}${q.video.slice(0, 2)}/${q.video}.mp4${q.vv ? `?v=${q.vv}` : ''}` : null; }

// ===== SOURCE : toute la série, ou seulement la série, ou seulement le film =====
let source = (() => { try { return localStorage.getItem('kaam_source') || 'all'; } catch { return 'all'; } })();
const poolCache = new Map();
function bySource(arr) {
  if (source === 'all') return arr;
  const key = `${source}|${arr === null ? 'all' : arr === audioIdx ? 'a' : arr === videoIdx ? 'v' : 'x' + arr.length}`;
  if (arr !== verifyIdx && poolCache.has(key)) return poolCache.get(key);
  const base = arr || allQuotes.map((_, i) => i);
  const out = base.filter(i => !!allQuotes[i].film === (source === 'film'));
  if (arr !== verifyIdx) poolCache.set(key, out);
  return out;
}

// ===== PRÉCHARGEMENT =====
// Hugging Face met ~1 s à servir chaque extrait : on télécharge à l'avance ceux des répliques suivantes
// (fichiers de 30 à 200 Ko) et on les lit depuis la mémoire, ce qui rend le passage d'une réplique à l'autre immédiat.
const mediaCache = new Map();   // url distante → téléchargement en cours ou terminé
const mediaReady = new Map();   // url distante → url blob (extrait déjà en mémoire)
const MEDIA_CACHE_MAX = 24;   // extraits de 30 à 650 Ko
function cachedMedia(url) {
  if (!url || mediaCache.has(url)) return;
  mediaCache.set(url, fetch(url).then(r => r.ok ? r.blob() : Promise.reject())
    .then(b => { if (mediaCache.has(url)) mediaReady.set(url, URL.createObjectURL(b)); })
    .catch(() => mediaCache.delete(url)));
  while (mediaCache.size > MEDIA_CACHE_MAX) {             // les plus anciens sont libérés
    const old = mediaCache.keys().next().value;
    mediaCache.delete(old);
    const u = mediaReady.get(old);
    if (u && cardVideo.src !== u && player.src !== u) URL.revokeObjectURL(u);
    mediaReady.delete(old);
  }
}
// source à lire : la copie en mémoire si elle est prête, sinon le fichier distant (et on le garde pour la suite)
function mediaSrc(url) { const u = mediaReady.get(url); if (!u) cachedMedia(url); return u || url; }
// Répliques probables après celle-ci : on précharge leur vidéo (modes vidéo / vérification) et leur son
function prefetchAround() {
  const P = pool();
  const next = [];
  // suivante dans l'ordre (boutons ◀ ▶, mode « Dans l'ordre ») et, en aléatoire, la prochaine tirée à l'avance
  if (P) { const pos = P.indexOf(quoteIdx); if (pos !== -1) next.push(P[(pos + 1) % P.length], P[(pos + 2) % P.length]); }
  else next.push((quoteIdx + 1) % allQuotes.length);
  if (!inOrder) { if (nextRand === null) nextRand = pickRandom(); next.push(nextRand); }
  if (randPos > 0) next.push(randHistory[randPos - 1]);
  if (randPos < randHistory.length - 1) next.push(randHistory[randPos + 1]);
  next.filter(i => i != null && allQuotes[i]).forEach(i => {
    const q = allQuotes[i];
    if ((videoOnly || verifyMode) && q.video) cachedMedia(videoURL(q));
    if (q.audio && (autoPlay || verifyMode || audioOnly)) cachedMedia(audioURL(q.audio));
  });
}
let nextRand = null;      // prochaine réplique aléatoire, tirée à l'avance pour être préchargée
function pickRandom() { return pool() ? rand(pool()) : Math.floor(Math.random() * allQuotes.length); }

// Un seul lecteur vidéo pour toutes les cartes : une fois le son autorisé par un toucher (iOS), il le reste
const cardVideo = document.createElement('video');
cardVideo.className = 'quote-video';
cardVideo.id = 'qvideo';
cardVideo.playsInline = true;
cardVideo.setAttribute('playsinline', '');
cardVideo.preload = 'auto';
['touchstart', 'touchend'].forEach(ev => cardVideo.addEventListener(ev, e => e.stopPropagation()));   // les gestes sur le lecteur ne changent pas de réplique

// ===== SCÈNE : figure du registre (image 16:9, repères de coupe, filet d'avancement, légende d'état) =====
// Rien n'est écrit sur l'image : l'état (chargement, sans le son, durée, fin, échec) est dans la légende dessous.
function sceneHTML(q, id) {
  return `<figure class="scene"${id ? ` id="${id}"` : ''} data-s="loading"><div class="frame"><span class="cm" aria-hidden="true"></span><div class="prog" aria-hidden="true"><b></b></div></div>`
    + `<figcaption class="leg"><span class="cote">${esc(coteEp(q))}</span><span class="st"></span></figcaption></figure>`;
}
const mmss = t => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function setScene(v, st) {
  const f = v.closest('.scene');
  v.parentElement?.classList.toggle('muted', v.muted);
  if (!f) return;
  clearTimeout(v._guard);
  if (st === 'loading') v._guard = setTimeout(() => { if (f.dataset.s === 'loading' && v.closest('.scene') === f) setScene(v, 'error'); }, 8000);
  f.dataset.s = st;
  const el = f.querySelector('.st');
  if (!el) return;
  const T = {
    loading: ['mono', 'Chargement…'],
    muted:   ['red', '<i aria-hidden="true"></i>Touchez l’image pour le son'],
    playing: ['mono', `${mmss(v.currentTime)} / ${mmss(v.duration)}`],
    ended:   ['ink', '<span aria-hidden="true">↻</span> Revoir'],
    error:   ['red', 'Scène indisponible · Réessayer'],
  }[st];
  el.className = 'st ' + T[0];
  el.innerHTML = T[1];
}
function tickScene(v) {
  const f = v.closest('.scene');
  if (!f) return;
  const p = v.duration ? Math.min(100, v.currentTime / v.duration * 100) : 0;
  f.style.setProperty('--p', p.toFixed(1) + '%');
  if (f.dataset.s === 'playing') { const el = f.querySelector('.st'); if (el) el.textContent = `${mmss(v.currentTime)} / ${mmss(v.duration)}`; }
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
    if (fig.dataset.s === 'error') { setScene(v, 'loading'); v.load(); v.play().catch(() => {}); return; }
    replayVideo(v);
  });
}
wireScene(cardVideo);
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
['touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, unlockSound, { capture: true }));
function playCardVideo(q, fig) {
  const url = videoURL(q);
  const src = mediaSrc(url);
  const frame = fig.querySelector('.frame');
  frame.prepend(cardVideo);
  if (cardVideo.src !== src) { cardVideo.src = src; setScene(cardVideo, 'loading'); }
  cardVideo.currentTime = 0;
  // son activé par défaut ; si le navigateur refuse (aucun toucher encore), lecture sans son, signalée
  cardVideo.muted = false;
  cardVideo.play().catch(e => {
    if (e.name !== 'NotAllowedError') return;            // lecture interrompue par la réplique suivante : rien à faire
    cardVideo.muted = true; cardVideo.play().catch(() => {});
  });
}

// Répliques parcourues (aléatoire / ordre) selon les filtres actifs
function pool() {
  let P;
  if (verifyMode) P = verifyIdx;
  else if (videoOnly && videoIdx.length) P = bySource(videoIdx);
  else if (audioOnly && audioIdx.length) P = bySource(audioIdx);
  else P = source === 'all' ? null : bySource(null);
  // filtres sans aucune réplique (ex. tout vérifié) : on retombe sur la source seule, jamais sur une liste vide
  if (P && !P.length) P = source === 'all' ? null : bySource(null);
  return P && P.length ? P : null;
}
// ===== VÉRIFICATION (avis son / vidéo justes ou non, envoyés à /api/avis) =====
let verifyMode = readPref('kaam_verify');      // ne montrer que les répliques avec son/vidéo pas encore vérifiées
let verifyIdx = [];
let avisFaits = readJSON('kaam_avis_faits', {});   // index de réplique → 1 (déjà vérifiée sur cet appareil)
let avisFile  = readJSON('kaam_avis_file', []);    // avis pas encore envoyés
function readJSON(k, def) { try { return JSON.parse(localStorage.getItem(k)) || def; } catch { return def; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
// Les sons estimés (≈), les moins sûrs, passent en premier ; les autres ensuite
let verifyApprox = false;
function rebuildVerify() {
  // dans la source choisie (Tout / Série / Film)
  const todo = allQuotes.reduce((acc, q, i) => ((q.audio || q.video) && !avisFaits[q.i]
    && (source === 'all' || !!q.film === (source === 'film')) && acc.push(i), acc), []);
  const approx = todo.filter(i => allQuotes[i].approx);
  verifyApprox = approx.length > 0;
  verifyIdx = verifyApprox ? approx : todo;
}
let autoPlay  = readPref('kaam_autoplay');     // jouer le son dès qu'on tombe sur la réplique
let inOrder   = readPref('kaam_in_order');     // swipe/tap : réplique suivante dans l'ordre au lieu d'aléatoire
const player = new Audio();
player.preload = 'auto';
let playingBtn = null;

function readPref(k) { try { return localStorage.getItem(k) === '1'; } catch { return false; } }
function writePref(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch {} }

// Les favoris enregistrés avant l'ajout des sons n'ont pas le champ audio : on le retrouve
function audioOf(q) {
  if (q.audio) return q.audio;
  const hit = audioIdx.map(i => allQuotes[i]).find(x => x.quote === q.quote && x.name === q.name);
  return hit ? hit.audio : null;
}

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
  if (r && player.duration) r.style.setProperty('--p', Math.min(1, player.currentTime / player.duration).toFixed(3));
  if (playingBtn && !player.paused) requestAnimationFrame(tickAudio);
}
function audioFailed() {
  const b = playingBtn;
  setPlayingBtn(null);
  const lp = b?.querySelector('.lp');
  if (lp) { lp.textContent = 'Réessayer'; setTimeout(() => { lp.textContent = 'Écouter'; }, 2500); }
}
function stopAudio() {
  player.pause();
  cardVideo.pause();
  document.querySelectorAll('video').forEach(v => v.pause());
  setPlayingBtn(null);
}
function playAudio(src, btn) {
  if (!src) return;
  if (btn && btn === playingBtn) {
    if (btn.classList.contains('wait')) return;          // second toucher pendant le chargement : ignoré
    if (!player.paused) { stopAudio(); return; }         // toucher pendant la lecture = arrêter
  }
  // jamais deux sons à la fois : la scène (carte ou fenêtre) s'arrête
  cardVideo.pause();
  document.getElementById('mvideo')?.pause();
  switching = true;
  player.src = mediaSrc(audioURL(src));
  player.currentTime = 0;
  setPlayingBtn(btn || null);
  player.play().catch(e => { if (e.name !== 'AbortError') audioFailed(); });
  switching = false;
}
player.addEventListener('playing', () => { playingBtn?.classList.remove('wait'); tickAudio(); });
player.addEventListener('ended', () => setPlayingBtn(null));
player.addEventListener('pause', () => { if (!switching && !player.ended && playingBtn && !playingBtn.classList.contains('wait')) setPlayingBtn(null); });
player.addEventListener('error', () => { if (playingBtn) audioFailed(); });

// Historique des citations vues en mode aléatoire
let randHistory = [];   // liste des quoteIdx visités
let randPos = -1;       // position courante dans l'historique

// ===== PARSE DATA =====
// Coquilles des scripts sur les noms : corrigées à la lecture (data.json n'est pas réécrit, l'index i est conservé)
const NAME_FIX = {
  'DAME DU LAC': 'LA DAME DU LAC', 'LA DAME OU LAC': 'LA DAME DU LAC', 'IA DAME DU LAC': 'LA DAME DU LAC',
  'LE MAITRE D’ARMES': 'LE MAÎTRE D’ARMES', 'LE MAÎTRE D’ARMÉS': 'LE MAÎTRE D’ARMES', 'LE MAÎTRE D’ARME': 'LE MAÎTRE D’ARMES',
  "LE MAITRE D'ARMES": 'LE MAÎTRE D’ARMES', "LE MAÎTRE D'ARMES": 'LE MAÎTRE D’ARMES',
  'LÉODAGANR': 'LÉODAGAN', 'PÈRE BIAISE': 'PÈRE BLAISE',
};
function parseQuote(item, i) {
  const raw = item.character || '';
  const commaIdx = raw.indexOf(',');
  const n0 = commaIdx > -1
    ? raw.slice(0, commaIdx).trim().replace(/\s+/g, ' ').toUpperCase()
    : raw.trim().replace(/\s+/g, ' ').toUpperCase();
  const name = NAME_FIX[n0] || n0;
  const rest = commaIdx > -1 ? raw.slice(commaIdx + 1) : '';

  const livreM = rest.match(/livre\s+(I{1,3}V?|VI?)/i);
  const epM    = rest.match(/épisode\s+(\d+)\s*(?::\s*(.+))?/i);

  const livre   = livreM ? livreM[1].toUpperCase() : '';
  const episode = epM ? epM[1] : '';
  const title   = epM && epM[2] ? epM[2].trim() : '';
  const film    = /premier volet/i.test(rest) ? 'Kaamelott : Premier Volet' : '';
  // scénarios inédits jamais tournés (« Inédit 3 : Dolor ») : affichés comme tels, jamais de son
  const inedM   = rest.match(/Inédit\s+(\d)\s*:\s*(.+)/i);
  const inedit  = item.inedit ? (inedM ? `Inédit ${inedM[1]} : ${inedM[2].trim()}` : 'Inédit') : '';

  return { i, quote: item.quote, name, livre, episode, title, film, inedit, hide: !!item.hide, audio: item.audio ? item.audio + (item.v ? `?v=${item.v}` : '') : null, video: item.video || null, vv: item.vv || 0, approx: !!item.approx };
}

async function loadData() {
  // jusqu'à 3 essais : le premier peut tomber sur la page de contrôle anti-robot de Vercel (403), qui se lève seule
  let raw = null, detail = '';
  for (let essai = 0; essai < 3 && !raw; essai++) {
    if (essai) await new Promise(r => setTimeout(r, 2500));
    try {
      const res = await fetch('data.json', { cache: essai ? 'reload' : 'default' });
      detail = `HTTP ${res.status} ${res.headers.get('content-type') || ''} ${res.headers.get('x-vercel-mitigated') || ''}`;
      if (res.ok) {
        // premier lancement (aucun service worker aux commandes) : la page range elle-même les répliques dans le cache
        // que le service worker servira ensuite, pour ne jamais les télécharger deux fois
        if (window.caches && !navigator.serviceWorker?.controller) {
          const copy = res.clone();
          caches.open('kaamelott-data').then(c => c.put('/data.json', copy)).catch(() => {});
        }
        raw = await res.json();
      }
    } catch (e) { detail += ` · ${e.name}: ${e.message}`; }
  }
  if (!raw) throw new Error(`data.json : ${detail}`);
  allQuotes  = raw.map(parseQuote).filter(q => q.quote && q.name && !q.hide);   // hide : doublon masqué (index i conservé)
  audioIdx   = allQuotes.reduce((acc, q, i) => (q.audio && acc.push(i), acc), []);
  videoIdx   = allQuotes.reduce((acc, q, i) => (q.video && acc.push(i), acc), []);
  rebuildVerify();
  if (!audioIdx.length) audioOnly = false;
  if (!videoIdx.length) videoOnly = false;
}

// ===== STORAGE =====
function loadFavorites() {
  try { favorites = JSON.parse(localStorage.getItem('kaam_fav') || '[]'); } catch { favorites = []; }
}
function saveFavorites() {
  try { localStorage.setItem('kaam_fav', JSON.stringify(favorites)); } catch {}
}
// même réplique : même texte et même personnage (nom corrigé par NAME_FIX pour les favoris anciens)
function sameQuote(f, q) { return f.quote === q.quote && (NAME_FIX[f.name] || f.name) === q.name; }
function isFav(q) { return favorites.some(f => sameQuote(f, q)); }
function toggleFav(q) {
  if (isFav(q)) favorites = favorites.filter(f => !sameQuote(f, q));
  else { const { live, ...keep } = q; favorites.unshift(keep); }   // la réplique entière, avec son index stable i
  saveFavorites();
}

// ===== UTILS =====
function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ===== MISE EN FORME =====
const nf = n => n.toLocaleString('fr-FR');
function fmtEp(q) {
  if (q.film) return `Film · ${q.film}`;
  if (q.inedit) return `${q.inedit} · jamais tourné`;
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
  if (q.inedit) { const m = /Inédit (\d)/.exec(q.inedit); return m ? `Inédit ${m[1]}` : 'Inédit'; }
  if (!q.livre && !q.episode) return '';
  return [q.livre ? `L.${q.livre}` : '', q.episode ? `É.${q.episode}` : ''].filter(Boolean).join(' · ');
}
// Titres d'épisode tout en capitales dans les scripts (« AU BONHEUR DES DAMES ») : remis en casse de phrase,
// en gardant les chiffres romains (« Vox populi III ») et la capitale des noms de personnages (« Le monde d’Arthur »)
let KNOWN = null;   // noms de personnages d'un seul mot, sans accents ni casse
function knownNames() {
  if (!KNOWN && allQuotes.length) KNOWN = new Set(getCharList().map(([n]) => n).filter(n => !/[\s’']/.test(n) && n.length > 2 && n !== 'TOUS').map(fold));
  return KNOWN || new Set();
}
function titleCase(t) {
  if (t === t.toUpperCase()) {
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
function typo(s) { return typoHTML(esc(s)); }
function quoteHTML(s) { return `<span class="g" aria-hidden="true">«</span> ${typo(s)} <span class="g" aria-hidden="true">»</span>`; }
// Source d'une réplique, prête à insérer en HTML (typographie appliquée)
function epHTML(q) { return typo(fmtEp(q)); }
// Nom en casse de titre pour les listes (« PÈRE BLAISE » → « Père Blaise », « LA DAME DU LAC » → « La Dame du Lac »)
const PETITS = new Set(['de', 'du', 'des', 'et', 'le', 'la', 'les', 'aux', 'au', 'à', 'en', 'sur']);
function nameCase(n) {
  return n.toLowerCase().split(/(\s+|-)/).map((w, k) => {
    if (!w.trim() || w === '-') return w;
    if (k > 0 && PETITS.has(w)) return w;
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
function fold(s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'"); }
// Recherche : texte plié (sans accents, minuscules, toute ponctuation → une espace, bordé d'espaces).
// La longueur est conservée caractère par caractère (hors espace ajoutée en tête), pour reporter les positions du surlignage.
const fold2 = s => ' ' + (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ') + ' ';
const fold2Len = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').length === (s || '').length;
// surligne chaque mot cherché à partir d'un début de mot ; la typographie est appliquée une seule fois, sur le HTML découpé
function highlight(text, query) {
  const plain = text.replace(/'/g, '’');
  const toks = fold2(query).trim().split(/\s+/).filter(Boolean);
  if (!toks.length || !fold2Len(plain)) return typo(text);
  const f = fold2(plain).slice(1, -1);
  const marks = new Uint8Array(plain.length);
  for (const t of toks) { let at = -1; while ((at = f.indexOf(t, at + 1)) >= 0) if (at === 0 || f[at - 1] === ' ') marks.fill(1, at, at + t.length); }
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
function setMast(t) { const el = document.getElementById('mast-sub'); if (el) el.textContent = t; }

// ===== FEUILLE (réglages, signalement) =====
function openSheet(html) {
  const sheet = document.getElementById('sheet'), back = document.getElementById('sheet-back');
  sheet.innerHTML = html;
  sheet.hidden = false; back.hidden = false;
  back.onclick = closeSheet;
  return sheet;
}
function closeSheet() {
  document.getElementById('sheet').hidden = true;
  document.getElementById('sheet-back').hidden = true;
  document.getElementById('sheet').innerHTML = '';
}
function sheetOpen() { return !document.getElementById('sheet').hidden; }

// ===== RÉGLAGES =====
const SRC_LABEL = { all: 'Tout', serie: 'Série', film: 'Film' };
function inSrc(q, s) { return s === 'all' || !!q.film === (s === 'film'); }
function countFor(s, m) {
  if (m === 'video') return videoIdx.reduce((n, i) => n + inSrc(allQuotes[i], s), 0);
  if (m === 'audio') return audioIdx.reduce((n, i) => n + inSrc(allQuotes[i], s), 0);
  return s === 'all' ? allQuotes.length : allQuotes.reduce((n, q) => n + inSrc(q, s), 0);
}
function toVerifyCount() {
  return allQuotes.reduce((n, q) => n + ((q.audio || q.video) && !avisFaits[q.i] && inSrc(q, source) ? 1 : 0), 0);
}
function mediaMode() { return videoOnly ? 'video' : audioOnly ? 'audio' : 'text'; }
function settingsHTML() {
  const m = mediaMode();
  const opt = (on, attrs, label, small, red) =>
    `<button class="opt${on ? ' on' : ''}${red && on ? ' red' : ''}" ${attrs}>${label}<small>${small}</small></button>`;
  return `
    <div class="sh-head">
      <div><h2>Réglages</h2></div>
      <button class="sh-close" id="sheet-close"><span class="arr">↓</span>Fermer</button>
    </div>
    <div class="set"><div class="set-lab">Source</div><div class="opts">
      ${['all', 'serie', 'film'].map(s => opt(source === s, `data-src="${s}"`, SRC_LABEL[s], nf(countFor(s, m)))).join('')}
    </div></div>
    <div class="set"><div class="set-lab">Affichage</div><div class="opts">
      ${opt(m === 'text', 'id="chip-text"', 'Texte', nf(countFor(source, 'text')))}
      ${opt(m === 'audio', 'id="chip-audio-only"', 'Son', nf(countFor(source, 'audio')))}
      ${videoIdx.length ? opt(m === 'video', 'id="chip-video-only"', 'Vidéo', nf(countFor(source, 'video'))) : ''}
    </div></div>
    <div class="set"><div class="set-lab">Ordre</div><div class="opts">
      ${opt(!inOrder, 'data-order="random"', 'Aléatoire', 'au hasard')}
      ${opt(inOrder, 'data-order="seq"', 'Dans l’ordre', 'épisode par épisode')}
    </div></div>
    <div class="set"><div class="set-lab">Lecture auto</div><div class="opts">
      ${opt(!autoPlay, 'data-auto="0"', 'Non', 'son à la demande')}
      ${opt(autoPlay, 'data-auto="1"', 'Oui', 'son joué d’office')}
    </div></div>
    <div class="set"><div class="set-lab">Vérifier</div><div class="opts">
      ${opt(!verifyMode, 'data-verify="0"', 'Non', 'lecture normale')}
      ${opt(verifyMode, 'data-verify="1" id="chip-verify"', 'Oui', `${nf(toVerifyCount())} à contrôler`, true)}
    </div></div>
    <p class="set-note">Chaque nombre indique combien de répliques ce choix vous présentera, avec les autres réglages actuels. Vérifier : vous validez ou signalez chaque son et chaque scène, les sons estimés d’abord.</p>`;
}
function openSettings() {
  const sheet = openSheet(settingsHTML());
  bindSettings(sheet);
}
function refreshAfterSetting() {
  const P = pool();
  if (P && P.length && !P.includes(quoteIdx)) randomQuote(); else renderCitations();
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = settingsHTML();
  bindSettings(sheet);
}
function bindSettings(sheet) {
  sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
  sheet.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => {
    source = b.dataset.src;
    try { localStorage.setItem('kaam_source', source); } catch {}
    rebuildVerify(); nextRand = null;
    refreshAfterSetting();
  }));
  const setMedia = m => {
    audioOnly = m === 'audio'; videoOnly = m === 'video';
    writePref('kaam_audio_only', audioOnly); writePref('kaam_video_only', videoOnly);
    nextRand = null;
    refreshAfterSetting();
  };
  sheet.querySelector('#chip-text').addEventListener('click', () => setMedia('text'));
  sheet.querySelector('#chip-audio-only').addEventListener('click', () => setMedia('audio'));
  const v = sheet.querySelector('#chip-video-only');
  if (v) v.addEventListener('click', () => setMedia('video'));
  sheet.querySelectorAll('[data-order]').forEach(b => b.addEventListener('click', () => {
    inOrder = b.dataset.order === 'seq'; writePref('kaam_in_order', inOrder); nextRand = null;
    refreshAfterSetting();
  }));
  sheet.querySelectorAll('[data-auto]').forEach(b => b.addEventListener('click', () => {
    autoPlay = b.dataset.auto === '1'; writePref('kaam_autoplay', autoPlay);
    refreshAfterSetting();
  }));
  sheet.querySelectorAll('[data-verify]').forEach(b => b.addEventListener('click', () => {
    verifyMode = b.dataset.verify === '1'; writePref('kaam_verify', verifyMode);
    rebuildVerify(); nextRand = null;
    refreshAfterSetting();
  }));
}

// ===== RÉPLIQUES =====
// Plafonds du corps de la réplique quand une scène occupe le haut de l'écran (ailleurs, fitQuote calcule le corps)
const Q_MAX = { video: 26, videoSE: 21, quiz: 30, quizSE: 24, scene: 28 };
const fitMemo = new Map();      // taille trouvée par fitQuote, par réplique et par place disponible
// Corps de la réplique calculé sur la place réelle : le bloc vise les deux tiers de la hauteur, jamais plus petit
// que le barème quoteSize() sauf pour tenir à l'écran ; la scène défile au-delà du plancher.
function fitQuote(card, qt, qb, q) {
  const avail = card.clientHeight - 28 - (card.querySelector('.cote')?.offsetHeight || 0) - 14;
  const key = `${q.i}|${card.clientWidth}x${avail}|${textScale()}`;
  const set = fs => { qt.style.fontSize = fs + 'px'; };
  if (fitMemo.has(key)) { set(fitMemo.get(key)); return; }
  const small = innerWidth < 360, k = textScale();
  const MAX = Math.round((small ? 44 : 56) * Math.max(1, k)), MIN = Math.round((small ? 17 : 19) * k);
  const fit = r => {
    let lo = MIN, hi = MAX; set(hi);
    if (qb.offsetHeight <= avail * r) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; set(m); if (qb.offsetHeight <= avail * r) lo = m; else hi = m; }
    return lo;
  };
  const fs = Math.max(fit(.66), Math.min(Math.round(quoteSize(q.quote) * k), fit(.96)));
  set(fs);
  fitMemo.set(key, fs);
}
// Taille du texte choisie dans iOS (Réglages › Luminosité › Taille du texte) : 1 = taille par défaut (17 px)
function textScale() {
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 17;
  return Math.min(1.6, Math.max(.85, fs / 17));
}
function swipeCount() { try { return +localStorage.getItem('kaam_swipes') || 0; } catch { return 0; } }
function countSwipe() { try { localStorage.setItem('kaam_swipes', String(swipeCount() + 1)); } catch {} }
let firstRender = true;
function renderCitations(dir = 0) {
  const main = document.getElementById('main-content');
  if (!allQuotes.length) return;
  if (verifyMode && !verifyIdx.length) { renderVerifyDone(); return; }   // tout est vérifié : on s'arrête
  const fid = main.contains(document.activeElement) ? document.activeElement.id : '';
  stopAudio();
  if (!allQuotes[quoteIdx]) quoteIdx = pickRandom();          // index périmé (filtres, données changées)
  const q = allQuotes[quoteIdx];
  currentQuote = q;
  setMast(verifyMode ? 'Vérification' : 'Répliques');
  const P = pool();
  const pl = (n, w) => `${nf(n)} ${w}${n > 1 ? 's' : ''}`;
  // le rang n'a de sens que dans l'ordre ; en aléatoire, la cote le remplace
  const counter = verifyMode
    ? `${pl(Object.keys(avisFaits).length, 'vérifiée')}${avisFile.length ? ` · ${nf(avisFile.length)} à envoyer` : ''}`
    : inOrder
    ? (P ? `${nf(P.indexOf(quoteIdx) + 1)} / ${nf(P.length)}${videoOnly ? ' avec vidéo' : audioOnly ? ' avec son' : ''}` : `${nf(quoteIdx + 1)} / ${nf(allQuotes.length)}`)
    : '';
  const sep = '<span class="sep" aria-hidden="true">·</span>';
  const summary = verifyMode
    ? [verifyApprox ? 'Sons estimés' : 'Tout', `${nf(verifyIdx.length)} restante${verifyIdx.length > 1 ? 's' : ''}`, source === 'all' ? '' : SRC_LABEL[source]].filter(Boolean).join(sep)
    : [SRC_LABEL[source], { text: 'Texte', audio: 'Son', video: 'Vidéo' }[mediaMode()], inOrder ? 'Dans l’ordre' : 'Aléatoire', autoPlay ? 'Lecture auto' : '']
        .filter(Boolean).join(sep);
  const inlineVideo = !!((videoOnly || verifyMode) && q.video);
  const reviewable = verifyMode && (q.audio || q.video);
  const fav = isFav(q);
  const what = q.audio && q.video ? 'Son et vidéo OK' : q.video ? 'Vidéo OK' : 'Son OK';
  const no = String(q.i + 1).padStart(5, '0').replace(/^(\d{2})/, '$1 ');
  const hint = !verifyMode && !((videoOnly || verifyMode) && q.video) && swipeCount() < 5 ? (inOrder ? 'Touchez ou glissez pour la suivante' : 'Touchez ou glissez pour changer') : '';
  const small = innerWidth < 360;
  const atStart = !inOrder && randPos <= 0;
  // Rangée d'actions : toujours 4 cellules, toujours dans le même ordre ; une pièce absente reste en place, grisée
  const listen = inlineVideo && !verifyMode
    ? `<button class="cell" id="btn-replay"><span class="tri" aria-hidden="true"></span>Revoir</button>`
    : q.audio
    ? `<button class="cell" id="btn-audio"><span class="tri" aria-hidden="true"></span><span class="stop" aria-hidden="true"></span><span class="lp">Écouter</span><span class="ls">Arrêter</span>${q.approx ? '<span class="x" aria-hidden="true">*</span>' : ''}</button>`
    : `<button class="cell" disabled aria-label="Écouter : pas de son pour cette réplique"><span class="tri" aria-hidden="true"></span>Écouter</button>`;
  const scene = q.video
    ? `<button class="cell" id="btn-video"><span class="frm" aria-hidden="true"></span>Scène</button>`
    : `<button class="cell" disabled aria-label="Scène : pas de scène pour cette réplique"><span class="frm" aria-hidden="true"></span>Scène</button>`;

  main.innerHTML = `
    <button class="bar${verifyMode ? ' verify' : ''}" id="btn-settings">
      <span class="bar-sum">${summary}</span><span class="bar-btn"><i aria-hidden="true"></i>Réglages</span>
    </button>
    ${inlineVideo ? sceneHTML(q, 'qvideo-slot') : ''}
    <div class="stage swap-in${dir < 0 ? ' back' : dir > 0 ? '' : ' rand'}" id="quote-card">
      ${inlineVideo ? '' : `<div class="cote" aria-hidden="true"><span>N° ${no}</span><span>${esc(coteEp(q))}</span></div>`}
      <figure class="qblock">
        <button class="who" id="btn-who" aria-label="${esc(nameCase(q.name))}, voir la fiche du personnage">${esc(nameCase(q.name))}</button>
        <blockquote class="quote" lang="fr"${inlineVideo ? ` style="font-size:${Math.round(Math.min(quoteSize(q.quote), small ? Q_MAX.videoSE : Q_MAX.video) * textScale())}px"` : ''}>${quoteHTML(q.quote)}</blockquote>
        ${fmtEp(q) ? `<figcaption class="src">${epHTML(q)}</figcaption>` : ''}
        ${hint ? `<p class="quote-hint" aria-hidden="true">${hint}</p>` : ''}
      </figure>
    </div>
    ${counter || verifyMode ? `<div class="stage-foot${verifyMode ? ' vf' : ''}"><span class="quote-counter">${counter}</span>${reviewable ? `<button class="skip" id="avis-skip">Passer<span class="arr" aria-hidden="true">→</span></button>` : ''}</div>` : ''}
    <div class="done-slot"></div>
    <div class="acts">${listen}${scene}
      <button class="cell" id="btn-fav" aria-pressed="${fav}"><span class="sq${fav ? ' on' : ''}" aria-hidden="true"></span>Favori</button>
      <button class="cell" id="btn-share"><span class="arr" aria-hidden="true">↗</span><span class="t">Partager</span></button>
    </div>
    ${q.audio && q.approx && !inlineVideo ? `<p class="est-note"><b>*</b> Son estimé<span class="est-long"> : découpe calculée automatiquement, il peut déborder un peu sur les répliques voisines</span><span class="est-short"> : peut déborder un peu</span>.</p>` : ''}
    ${reviewable
      ? `<div class="vrow"><button class="ok" id="avis-ok"><i aria-hidden="true"></i>${what}</button><button class="ko" id="avis-ko">Problème</button></div>`
      : inOrder
      ? `<div class="nav"><button id="btn-prev" aria-label="Réplique précédente"><span class="arr" aria-hidden="true">←</span>Préc.</button><button class="mid" id="btn-random">Au hasard</button><button class="nx" id="btn-next" aria-label="Réplique suivante">Suiv.<span class="arr" aria-hidden="true">→</span></button></div>`
      : `<div class="nav"><button id="btn-prev" aria-label="Revenir à la réplique précédente"${atStart ? ' disabled' : ''}><span class="arr" aria-hidden="true">←</span>Retour</button><button class="mid" id="btn-random">Au hasard</button><button class="nx" id="btn-next" aria-label="Autre réplique">Autre<span class="arr" aria-hidden="true">→</span></button></div>`}`;

  const $ = id => document.getElementById(id);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-who').addEventListener('click', e => { e.stopPropagation(); openPersonnage(q.name); });
  $('btn-fav').addEventListener('click', () => {
    toggleFav(q);
    const on = isFav(q);
    $('btn-fav').innerHTML = `<span class="sq${on ? ' on' : ''}" aria-hidden="true"></span>Favori`;
    $('btn-fav').setAttribute('aria-pressed', on);
  });
  $('btn-share').addEventListener('click', () => shareQuote(q, $('btn-share')));
  if (reviewable) {
    $('avis-ok').addEventListener('click', () => recordAvis(q, true, [], ''));
    $('avis-ko').addEventListener('click', () => openProblem(q));
    $('avis-skip')?.addEventListener('click', () => { if (inOrder) stepQuote(1); else randomQuote(); });
  } else {
    // en aléatoire, les boutons font comme les gestes (historique) ; dans l'ordre, voisines dans le corpus
    $('btn-prev').addEventListener('click', () => swipeBack());
    $('btn-next').addEventListener('click', () => swipeForward());
    $('btn-random').addEventListener('click', () => randomQuote());
  }
  const fig = $('qvideo-slot');
  if (fig) { bindScene(fig, cardVideo); playCardVideo(q, fig); }
  else cardVideo.pause();
  prefetchAround();
  const btnVideo = $('btn-video');
  if (btnVideo) {
    btnVideo.addEventListener('touchstart', () => cachedMedia(videoURL(q)), { passive: true });
    btnVideo.addEventListener('click', () => showVideo(q));
  }
  $('btn-replay')?.addEventListener('click', () => replayVideo(cardVideo));
  const audioBtn = $('btn-audio');
  if (audioBtn) {
    audioBtn.addEventListener('click', () => playAudio(q.audio, audioBtn));
    // Lecture auto : renderCitations est appelé dans le geste (tap/swipe/bouton), donc le navigateur l'autorise
    if (autoPlay && !inlineVideo) playAudio(q.audio, audioBtn);
  }

  const card = $('quote-card');
  if (!inlineVideo) {
    fitQuote(card, card.querySelector('.quote'), card.querySelector('.qblock'), q);
    if (firstRender && document.fonts?.ready) document.fonts.ready.then(() => {
      fitMemo.clear();
      if (card.isConnected) { fitQuote(card, card.querySelector('.quote'), card.querySelector('.qblock'), q); fit(); }
    });
  }
  firstRender = false;
  // la réplique continue plus bas : fondu et « Suite ↓ », retirés une fois en bas
  const fit = () => {
    const more = card.scrollHeight > card.clientHeight + 4 && card.scrollTop + card.clientHeight < card.scrollHeight - 4;
    card.classList.toggle('ovf', more);
    let h = card.parentElement.querySelector('.more-h');
    if (more && !h) { card.insertAdjacentHTML('afterend', '<span class="more-h" aria-hidden="true">Suite ↓</span>'); h = card.nextElementSibling; h.style.top = (card.offsetTop + card.offsetHeight - 26) + 'px'; }
    else if (!more && h) h.remove();
  };
  let lastScroll = 0;
  card.addEventListener('scroll', () => { lastScroll = Date.now(); fit(); }, { passive: true });
  requestAnimationFrame(fit);
  card.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (getSelection().toString().length) return;           // on sélectionnait du texte pour le copier
    if (Date.now() - lastScroll < 250) return;              // on faisait défiler une réplique longue
    countSwipe(); swipeForward();
  });
  // Glisser horizontalement : réplique suivante / précédente (le défilement vertical reste libre)
  let sx = 0, sy = 0, st = 0;
  card.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }, { passive: true });
  card.addEventListener('touchmove', e => {
    const dx = Math.abs(e.touches[0].clientX - sx), dy = Math.abs(e.touches[0].clientY - sy);
    if (dx > dy && dx > 8) e.preventDefault();
  }, { passive: false });
  card.addEventListener('touchend', e => {
    const dx = sx - e.changedTouches[0].clientX, dy = Math.abs(sy - e.changedTouches[0].clientY);
    const fast = Date.now() - st < 250 && Math.abs(dx) > 30;
    if ((Math.abs(dx) > 50 || fast) && Math.abs(dx) > dy) { countSwipe(); if (dx > 0) swipeForward(); else swipeBack(); }
  }, { passive: true });

  // VoiceOver : la nouvelle réplique est annoncée (pas au premier affichage), le focus reste sur le bouton touché
  if (renderCitations.announce) document.getElementById('sr-live').textContent = `${nameCase(q.name)} : ${q.quote.slice(0, 280)}`;
  renderCitations.announce = true;
  if (fid && $(fid) && !$(fid).disabled) $(fid).focus({ preventScroll: true });
}

// ===== AVIS DE VÉRIFICATION =====
// tableau Son / Scène / Texte × Faux / Coupé / Déborde
const PB_GRID = [
  ['Faux',    'pas la bonne', { audio: 'son_faux',    video: 'video_fausse', texte: 'texte_faux' }],
  ['Coupé',   'incomplet',    { audio: 'son_coupe',   video: 'video_coupee' }],
  ['Déborde', 'trop long',    { audio: 'son_deborde' }],
];
function openProblem(q) {
  const cols = [['audio', 'Son', 'son'], ['video', 'Scène', 'scène'], ['texte', 'Texte', 'texte']];
  const has = k => k === 'texte' || !!q[k];
  const ctx = [nameCase(q.name), q.film ? 'Film' : q.inedit ? q.inedit.replace(/ :.*/, '') : [q.livre && `Livre ${q.livre}`, q.episode && `Épisode ${q.episode}`].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  const sheet = openSheet(`
    <div class="sh-head">
      <div><h2 id="sh-title">Problème</h2><p>${esc(ctx)}</p></div>
      <button class="sh-close" id="sheet-close">Fermer</button>
    </div>
    <div class="tbl">
      <div class="th"></div>${cols.map(([, l]) => `<div class="th">${l}</div>`).join('')}
      ${PB_GRID.map(([row, sub, ids]) => `<div class="rh">${row}<small>${sub}</small></div>` + cols.map(([k, , lab]) =>
        ids[k] && has(k) ? `<button class="tc" data-pb="${ids[k]}" role="checkbox" aria-checked="false" aria-label="${row} : ${lab}"><span class="box"></span></button>` : `<div class="tc nil" aria-hidden="true">—</div>`).join('')).join('')}
    </div>
    <label class="note"><span>Précision (facultatif)</span><textarea id="avis-note" maxlength="500"></textarea></label>
    <div class="sh-acts one"><button class="go" id="avis-send" disabled>Signaler et passer<span class="arr" aria-hidden="true">→</span></button></div>
    <p class="sh-help" id="avis-help">Cochez au moins une case, ou écrivez une précision.</p>`);
  const picked = new Set();
  const send = sheet.querySelector('#avis-send'), note = sheet.querySelector('#avis-note');
  const upd = () => { send.disabled = !picked.size && !note.value.trim(); sheet.querySelector('#avis-help').hidden = !send.disabled; };
  sheet.querySelectorAll('[data-pb]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.pb;
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    b.classList.toggle('on', picked.has(id)); b.setAttribute('aria-checked', picked.has(id)); upd();
  }));
  // note qui s'agrandit avec le texte (jusqu'à 4 lignes)
  note.addEventListener('input', () => { upd(); note.style.height = 'auto'; note.style.height = Math.min(Math.max(note.scrollHeight, 72), 96) + 'px'; });
  note.addEventListener('focus', () => setTimeout(() => note.scrollIntoView({ block: 'center' }), 300));
  sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
  send.addEventListener('click', () => { closeSheet(); recordAvis(q, false, [...picked], note.value.trim()); });
}
function recordAvis(q, ok, problemes, note) {
  if (avisFaits[q.i]) return;                   // jamais deux avis pour la même réplique
  avisFaits[q.i] = ok ? 1 : 2;                  // 1 = validée, 2 = signalée
  avisFile.push({ i: q.i, quote: q.quote, name: q.name, audio: q.audio, video: q.video, approx: q.approx, ok, problemes, note, ts: Date.now() });
  writeJSON('kaam_avis_faits', avisFaits);
  writeJSON('kaam_avis_file', avisFile);
  if (avisFile.length >= 5) sendAvis();
  rebuildVerify();
  if (!verifyIdx.length) { renderCitations(); return; }
  if (inOrder) stepQuote(1); else randomQuote();
}
// Écran de fin : plus rien à vérifier dans cette source
function renderVerifyDone() {
  stopAudio();
  cardVideo.pause();
  setMast('Vérification');
  const total = allQuotes.reduce((n, q) => n + ((q.audio || q.video) && inSrc(q, source) ? 1 : 0), 0);
  const vals = Object.values(avisFaits);
  const sep = '<span class="sep" aria-hidden="true">·</span>';
  document.getElementById('main-content').innerHTML = `
    <button class="bar verify" id="btn-settings"><span class="bar-sum">Vérification${sep}Terminé</span><span class="bar-btn"><i></i>Réglages</span></button>
    <div class="scroll"><div class="fin"><span class="no">${nf(total)} / ${nf(total)}</span><h1>Tout est vérifié.</h1>
      <p>Chaque son et chaque scène de cette source a reçu un avis depuis cet appareil.</p>
      <dl><dt>Validés</dt><dd>${nf(vals.filter(v => v !== 2).length)}</dd><dt>Signalés</dt><dd>${nf(vals.filter(v => v === 2).length)}</dd><dt>En attente d’envoi</dt><dd>${nf(avisFile.length)}</dd></dl></div></div>
    <div class="nav one"><button id="verify-leave">Revenir à la lecture<span class="arr" aria-hidden="true">→</span></button></div>`;
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('verify-leave').addEventListener('click', () => {
    verifyMode = false; writePref('kaam_verify', false); nextRand = null;
    quoteIdx = pickRandom(); renderCitations();
  });
}
// Envoi par lots ; les avis restent dans l'appareil tant que l'envoi n'a pas réussi
let sending = false;
function sendAvis() {
  if (sending || !avisFile.length) return;
  sending = true;
  const lot = avisFile.slice(0, 100);
  fetch('/api/avis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avis: lot }), keepalive: true })
    .then(r => {
      if (!r.ok) return;
      avisFile = avisFile.slice(lot.length);
      writeJSON('kaam_avis_file', avisFile);
    })
    .catch(() => {})
    .finally(() => { sending = false; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendAvis(); });

// ===== NAVIGATION ENTRE RÉPLIQUES =====
function stepQuote(dir) {
  const P = pool();
  if (P) {
    const pos = P.indexOf(quoteIdx);
    quoteIdx = pos === -1
      ? (dir > 0 ? P.find(i => i > quoteIdx) ?? P[0] : [...P].reverse().find(i => i < quoteIdx) ?? P[P.length - 1])
      : P[(pos + dir + P.length) % P.length];
  } else {
    quoteIdx = (quoteIdx + dir + allQuotes.length) % allQuotes.length;
  }
  renderCitations(dir);
}
function nextQuote() { stepQuote(1); }
function prevQuote() { stepQuote(-1); }
function randomQuote() {
  if (randPos < randHistory.length - 1) randHistory = randHistory.slice(0, randPos + 1);   // on coupe l'historique si on était en arrière
  const P = pool();
  quoteIdx = nextRand !== null && (!P || P.includes(nextRand)) && nextRand !== quoteIdx ? nextRand : pickRandom();
  nextRand = null;
  randHistory.push(quoteIdx);
  randPos = randHistory.length - 1;
  renderCitations(0);
}
// Toucher / glisser : selon le mode, réplique suivante dans l'ordre ou au hasard (avec historique)
function swipeForward() { if (inOrder) stepQuote(1); else historyForward(); }
function swipeBack()    { if (inOrder) stepQuote(-1); else historyBack(); }
function historyBack() {
  if (randPos > 0) { randPos--; quoteIdx = randHistory[randPos]; renderCitations(-1); }
}
function historyForward() {
  if (randPos < randHistory.length - 1) { randPos++; quoteIdx = randHistory[randPos]; renderCitations(1); }
  else randomQuote();
}
// Ouvre une réplique précise (recherche, favoris, fiche) dans la page Répliques
function gotoQuote(q) {
  let idx = allQuotes.indexOf(q);
  if (idx < 0) idx = allQuotes.findIndex(x => x.quote === q.quote && x.name === q.name);
  if (idx < 0) return;
  closeOverlay();
  quoteIdx = idx;
  if (randPos < randHistory.length - 1) randHistory = randHistory.slice(0, randPos + 1);
  randHistory.push(idx); randPos = randHistory.length - 1;
  setView('citations');
}
async function shareQuote(q) {
  const text = `« ${q.quote} »\n${q.name}${fmtEp(q) ? ', ' + fmtEp(q) : ''}\n\nKaamelott`;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch {}
  } else {
    await navigator.clipboard.writeText(text).catch(() => {});
    alert('Réplique copiée.');
  }
}

// ===== QUIZ =====
const TOP_CHARS = [
  'ARTHUR', 'PERCEVAL', 'LÉODAGAN', 'LANCELOT', 'GUENIÈVRE',
  'KARADOC', 'BOHORT', 'SÉLI', 'MERLIN', 'PÈRE BLAISE',
  'DEMETRA', 'LE TAVERNIER', 'GUETHENOC', 'YVAIN', 'YGERNE',
  'LE RÉPURGATEUR', 'CALOGRENANT', 'ATTILA', 'VENEC', 'GALESSIN',
];
function initQuiz() {
  let best = 0;
  try { best = +localStorage.getItem('kaam_quiz_best') || 0; } catch {}
  quizState = { correct: 0, total: 0, streak: 0, best, answered: false };
}
// Tirage juste : personnage d'abord (uniforme), puis une de ses répliques. Chaque nom affiché a ainsi 1 chance sur 4
// d'être le bon (plus de « réflexe Arthur »). Pool : réplique avec scène, 25 signes au moins, sans le nom de celui qui parle.
const QUIZ_RECENT = [];                      // 80 dernières questions : pas de redite
let quizByChar = null;
function quizPick() {
  if (!quizByChar || quizByChar.src !== allQuotes) {
    quizByChar = { src: allQuotes, m: {} };
    allQuotes.forEach((q, i) => {
      if (!TOP_CHARS.includes(q.name) || !q.video || q.quote.length < 25) return;
      const own = fold(q.name.replace(/^(LE|PÈRE) /, ''));
      if (fold(q.quote).includes(own)) return;
      (quizByChar.m[q.name] ||= []).push(i);
    });
  }
  const names = Object.keys(quizByChar.m);
  for (let t = 0; t < 20; t++) {
    const i = rand(quizByChar.m[rand(names)]);
    if (!QUIZ_RECENT.includes(i)) { QUIZ_RECENT.push(i); if (QUIZ_RECENT.length > 80) QUIZ_RECENT.shift(); return allQuotes[i]; }
  }
  return allQuotes[rand(quizByChar.m[rand(names)])];
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function renderQuiz() {
  if (!quizState) initQuiz();
  stopAudio();
  setMast('Quiz');
  const main = document.getElementById('main-content');
  const q = quizPick();
  quizState.current = q;
  quizState.answered = false;
  cachedMedia(videoURL(q));                  // la scène se télécharge pendant que l'on réfléchit
  const wrong = shuffle(TOP_CHARS.filter(c => c !== q.name)).slice(0, 3);
  const choices = shuffle([q.name, ...wrong]);
  const short = innerHeight < 620;
  const fs = Math.round(Math.min(quoteSize(q.quote), short ? Q_MAX.quizSE : Q_MAX.quiz) * textScale());

  main.innerHTML = `
    <div class="score">
      <div><span>Justes</span><b>${quizState.correct}<em>/${quizState.total}</em></b></div>
      <div><span>Série</span><b>${quizState.streak}</b></div>
      <div><span>Record</span><b>${quizState.best}</b></div>
    </div>
    <div class="scroll" id="quiz-stage">
      <div id="quiz-scene" class="q-scene"></div>
      <figure class="quiz-q">
        <blockquote class="quote" lang="fr" style="font-size:${fs}px">${quoteHTML(q.quote)}</blockquote>
        <figcaption class="src" id="quiz-after" hidden></figcaption>
      </figure>
    </div>
    <div class="choices" role="group" aria-label="Qui a dit ça ?">
      ${choices.map((c, k) => `<button class="choice" data-choice="${esc(c)}"><span class="l" aria-hidden="true">${'ABCD'[k]}</span><span class="n">${esc(nameCase(c))}</span><span class="v"></span></button>`).join('')}
    </div>
    <div class="nav one" id="quiz-nav"><button id="quiz-next">Passer<span class="arr" aria-hidden="true">→</span></button></div>`;

  const stage = document.getElementById('quiz-stage');
  const fade = () => stage.classList.toggle('q-more', stage.scrollHeight - stage.scrollTop - stage.clientHeight > 4);
  stage.addEventListener('scroll', fade, { passive: true });
  fade();
  document.getElementById('quiz-next').addEventListener('click', () => renderQuiz());
  document.querySelectorAll('.choice').forEach(btn => btn.addEventListener('click', () => {
    if (quizState.answered) return;
    quizState.answered = true;
    quizState.total++;
    const correct = btn.dataset.choice === q.name;
    const lost = quizState.streak;
    let record = false;
    if (correct) {
      quizState.correct++; quizState.streak++;
      if (quizState.streak > quizState.best) {
        quizState.best = quizState.streak; record = true;
        try { localStorage.setItem('kaam_quiz_best', String(quizState.best)); } catch {}
      }
    } else quizState.streak = 0;
    // les 4 lignes restent en place : rien ne bouge sous le doigt
    document.querySelectorAll('.choice').forEach(b => {
      b.setAttribute('aria-disabled', 'true');
      if (b.dataset.choice === q.name) { b.classList.add('right'); b.querySelector('.v').textContent = 'Juste'; }
      else if (b === btn) { b.classList.add('wrong'); b.querySelector('.v').textContent = 'Faux'; }
      else b.classList.add('dim');
    });
    const sc = document.querySelector('.score').children;
    sc[0].querySelector('b').innerHTML = `${quizState.correct}<em>/${quizState.total}</em>`;
    sc[1].querySelector('b').textContent = quizState.streak;
    sc[2].querySelector('b').textContent = quizState.best;
    if (record && quizState.best > 1) { sc[2].classList.add('rec'); sc[2].querySelector('span').textContent = 'Nouveau record'; }
    // source : l'épisode seulement (le nom est déjà dans la ligne « Juste »)
    const after = document.getElementById('quiz-after');
    after.innerHTML = epHTML(q); after.hidden = !fmtEp(q);
    document.getElementById('sr-live').textContent = correct
      ? `Juste, c’est ${nameCase(q.name)}.${record ? ' Nouveau record.' : ''}`
      : `Faux, c’était ${nameCase(q.name)}.${lost > 1 ? ` Série de ${lost} perdue.` : ''}`;
    // la récompense : la scène, projetée dans le geste (donc avec le son), en tête de la zone
    const scene = document.getElementById('quiz-scene');
    scene.innerHTML = sceneHTML(q, 'quiz-fig');
    const fig = document.getElementById('quiz-fig');
    bindScene(fig, cardVideo);
    playCardVideo(q, fig);
    stage.classList.add('answered');
    stage.scrollTop = 0; fade();
    const nav = document.getElementById('quiz-nav');
    nav.innerHTML = `<button id="quiz-next">Question suivante<span class="arr" aria-hidden="true">→</span></button>`;
    const nx = document.getElementById('quiz-next');
    nx.addEventListener('click', () => renderQuiz());
    if (btn.matches(':focus-visible')) nx.focus({ preventScroll: true });   // clavier : on enchaîne sur « Question suivante »
  }));
}

// ===== ENTRÉES DE LISTE (fiche, recherche, favoris) =====
// Rangée d'actions à colonnes fixes : Écouter · Scène · Favori (· Partager hors fiche) ; une pièce absente reste une cellule grisée
function entActs(q, opts) {
  const fav = isFav(q);
  const nil = t => `<span class="cell nil" aria-disabled="true">${t}</span>`;
  return `<div class="ent-a${opts.fiche ? ' f3' : ''}">
      ${q.audio ? `<button class="cell" data-act="audio"><span class="tri" aria-hidden="true"></span><span class="stop" aria-hidden="true"></span><span class="lp">Écouter</span><span class="ls">Arrêter</span></button>` : nil(opts.fiche ? 'Sans son' : '—')}
      ${q.video ? `<button class="cell" data-act="video"><span class="frm" aria-hidden="true"></span>Scène</button>` : nil(opts.fiche ? 'Sans scène' : '—')}
      <button class="cell" data-act="fav" aria-pressed="${fav}"><span class="sq${fav ? ' on' : ''}" aria-hidden="true"></span>${opts.remove ? 'Retirer' : 'Favori'}</button>
      ${opts.fiche ? '' : `<button class="cell shr" data-act="share" aria-label="Partager"><span class="arr" aria-hidden="true">↗</span></button>`}
    </div>`;
}
function entHTML(q, k, opts = {}) {
  const meta = opts.fiche ? '' : `<div class="ent-m">${opts.name === false ? '' : `<b>${esc(nameCase(q.name))}</b>`}${epHTML(q)}</div>`;
  const lost = opts.remove && !q.live;                   // favori dont la réplique n'existe plus telle quelle
  return `<div class="ent" data-k="${k}">
    ${lost ? `<div class="ent-m">${esc(nameCase(q.name))} · réplique modifiée depuis : touchez Retirer</div>` : meta}
    ${lost ? `<div class="ent-q">${typo(q.quote)}</div>` : `<button class="ent-q" data-act="goto">${opts.query ? highlight(q.quote, opts.query) : typo(q.quote)}</button>`}
    ${entActs(q, opts)}
  </div>`;
}
// Délégation des actions d'une liste d'entrées ; list(k) rend la réplique de l'entrée k
function bindEntries(container, list, opts = {}) {
  container.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const ent = a.closest('.ent');
    const q = list(+ent.dataset.k);
    if (!q) return;
    const act = a.dataset.act;
    if (act === 'audio') playAudio(q.audio, a);
    else if (act === 'video') showVideo(q);
    else if (act === 'goto') gotoQuote(q);
    else if (act === 'share') shareQuote(q, a);
    else if (act === 'fav' && opts.remove) {
      // Favoris : retirée tout de suite, mais l'entrée reste en place, barrée, avec « Remettre »
      const at = favorites.findIndex(f => sameQuote(f, q));
      const saved = favorites[at];
      if (at < 0) return;
      favorites.splice(at, 1); saveFavorites();
      const row = ent.querySelector('.ent-a');
      const rowHTML = row.outerHTML;
      ent.classList.add('off');
      row.outerHTML = `<div class="ent-a undo"><span class="lab">Retirée des favoris</span><button class="cell" data-act="undo">Remettre</button></div>`;
      ent._undo = { at, saved, rowHTML };
      opts.onCount?.();
      ent.querySelector('[data-act="undo"]').focus({ preventScroll: true });
    }
    else if (act === 'undo' && ent._undo) {
      const { at, saved, rowHTML } = ent._undo;
      if (!isFav(saved)) { favorites.splice(Math.min(at, favorites.length), 0, saved); saveFavorites(); }
      ent.classList.remove('off');
      ent.querySelector('.ent-a').outerHTML = rowHTML;
      ent._undo = null;
      opts.onCount?.();
    }
    else if (act === 'fav') {
      toggleFav(q);
      const on = isFav(q);
      a.innerHTML = `<span class="sq${on ? ' on' : ''}" aria-hidden="true"></span>Favori`;
      a.setAttribute('aria-pressed', on);
    }
  });
}

// ===== PERSONNAGES =====
let persSort = 'count';
function renderPersonnages() {
  stopAudio();
  setMast('Personnages');
  const main = document.getElementById('main-content');
  const chars = getCharList();
  const max = chars[0] ? chars[0][1] : 1;
  // tri A→Z sur le nom sans article (« La Dame du Lac » sous D), lettres et tri calculés sur la même clé
  const sortKey = n => fold(n.replace(/^(LE|LA|LES)\s+|^L['’]\s*/, ''));
  const duo = n => / ET /.test(n);                // répliques dites à plusieurs voix : en fin de liste
  const solo = chars.filter(([n]) => !duo(n)), duos = chars.filter(([n]) => duo(n));
  const list = persSort === 'alpha' ? [...solo].sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0]), 'fr')) : solo;
  const row = ([name, count]) => `<button class="idx-row" data-char="${esc(name)}"><span class="n">${esc(nameCase(name))}</span><span class="c">${nf(count)}</span>
      ${count / max >= .005 ? `<span class="bar-c" style="width:calc((100% - 2 * var(--pad)) * ${(count / max).toFixed(3)})"></span>` : ''}</button>`;
  let rows = '', letter = '';
  list.forEach(c => {
    if (persSort === 'alpha') {
      const l = sortKey(c[0]).charAt(0).toUpperCase();
      if (l !== letter) { letter = l; rows += `<div class="idx-l">${l}</div>`; }
    }
    rows += row(c);
  });
  if (duos.length) rows += `<div class="idx-l voix">À plusieurs voix</div>` + duos.map(row).join('');
  main.innerHTML = `
    <div class="scroll">
      <div class="page-h"><h1>Personnages</h1><p>${nf(solo.length)} personnages · ${nf(allQuotes.length)} répliques</p></div>
      <div class="sort"><button class="${persSort === 'count' ? 'on' : ''}" data-sort="count" aria-pressed="${persSort === 'count'}">Par répliques</button><button class="${persSort === 'alpha' ? 'on' : ''}" data-sort="alpha" aria-pressed="${persSort === 'alpha'}">De A à Z</button></div>
      <div class="perso-list">${rows}</div>
    </div>`;
  main.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => { persSort = b.dataset.sort; renderPersonnages(); }));
  main.querySelectorAll('.idx-row').forEach(row => row.addEventListener('click', () => openPersonnage(row.dataset.char)));
}

// Page superposée (fiche personnage, scène) : l'en-tête reste visible, le reste de l'app est inerte dessous
let overlayFocus = null;
function openOverlay(html) {
  const overlay = document.getElementById('detail-overlay');
  if (overlay.classList.contains('hidden')) overlayFocus = document.activeElement;
  overlay.querySelectorAll('video').forEach(v => v.pause());
  overlay.innerHTML = html;
  overlay.classList.remove('hidden');
  document.getElementById('main-content').inert = true;
  overlay.querySelector('#detail-back')?.focus({ preventScroll: true });
  return overlay;
}
function closeOverlay() {
  const overlay = document.getElementById('detail-overlay');
  overlay.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
  const was = !overlay.classList.contains('hidden');
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
  document.getElementById('main-content').inert = false;
  if (was) setMast({ citations: verifyMode ? 'Vérification' : 'Répliques', quiz: 'Quiz', personnages: 'Personnages', recherche: 'Chercher', favoris: 'Favoris' }[currentView]);
  if (was && overlayFocus?.isConnected) overlayFocus.focus({ preventScroll: true });
  overlayFocus = null;
}
function openPersonnage(name) {
  stopAudio();
  detailChar = name;
  setMast('Personnages');
  const quotes = allQuotes.filter(q => q.name === name);
  let shown = 0;
  const overlay = openOverlay(`
    <div class="back"><button id="detail-back"><span class="arr" aria-hidden="true">←</span>Personnages</button></div>
    <div class="scroll" id="fiche-scroll">
      <div class="fiche-h"><h1>${esc(nameCase(name))}</h1>
        <div class="stats">
          <div><span>Répliques</span><b>${nf(quotes.length)}</b></div>
          <div><span>Avec son</span><b>${nf(quotes.filter(q => q.audio).length)}</b></div>
          <div><span>Avec scène</span><b>${nf(quotes.filter(q => q.video).length)}</b></div>
        </div>
      </div>
      <div id="fiche-list"></div>
    </div>`);
  const listEl = overlay.querySelector('#fiche-list');
  const more = () => {
    overlay.querySelector('.more')?.remove();
    const next = quotes.slice(shown, shown + 50);
    listEl.insertAdjacentHTML('beforeend', next.map((q, j) => entHTML(q, shown + j, { name: false })).join(''));
    shown += next.length;
    if (shown < quotes.length) {
      listEl.insertAdjacentHTML('beforeend', `<button class="more">Afficher la suite (${nf(quotes.length - shown)} restantes)</button>`);
      listEl.querySelector('.more').addEventListener('click', more);
    }
  };
  more();
  bindEntries(listEl, k => quotes[k]);
  overlay.querySelector('#detail-back').addEventListener('click', () => { stopAudio(); closeOverlay(); });
}

// ===== RECHERCHE =====
// Débuts de mot, dans l'ordre d'abord, puis tous les mots dans n'importe quel ordre ; ni titres ni noms (un résultat montre toujours pourquoi il est là)
const foldIx = s => ' ' + (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
let IX = null;
function buildIndex() { if (!IX || IX.src !== allQuotes) IX = { src: allQuotes, q: allQuotes.map(x => foldIx(x.quote)) }; }
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
  const who = getCharList().filter(([n]) => !/ ET /.test(n) && foldIx(n).startsWith(phrase)).slice(0, 3);
  return { text: text.concat(loose), who };
}
// Ce qu'on cherchait reste là quand on revient sur l'onglet (texte, nombre d'entrées affichées, défilement)
const searchState = { q: '', top: 0, shown: 40 };
let searchTimeout = null;
function renderRecherche() {
  stopAudio();
  setMast('Chercher');
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="search">
      <input type="search" id="search-input" placeholder="Un mot, un nom" aria-label="Chercher une réplique" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <button class="clr" id="search-clear">Effacer</button>
    </div>
    <div class="scroll" id="search-results"></div>`;
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const clr = document.getElementById('search-clear');
  const idle = () => {
    results.innerHTML = `<div class="res-n" role="status">${nf(allQuotes.length)} répliques. Les accents et la ponctuation sont facultatifs.</div>`;
  };
  const run = (v, keep) => {
    clr.hidden = !input.value;
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
  results.addEventListener('scroll', () => { searchState.top = results.scrollTop; }, { passive: true });
  clr.addEventListener('click', () => { input.value = ''; searchState.q = ''; searchState.top = 0; searchState.shown = 40; run('', false); input.focus(); });
  if (!searchState.q) input.focus();       // jamais le clavier par-dessus des résultats qu'on venait chercher
}
function doSearch(query, container, keep) {
  const res = searchHits(query);
  const hits = res ? res.text : [];
  if (!hits.length) {
    container.innerHTML = `<div class="empty">Rien pour « ${esc(query)} ».<small>Vérifiez l’orthographe, ou essayez le début d’un mot.</small></div>`;
    return;
  }
  let shown = 0;
  container.innerHTML = `<div class="res-n" role="status">${nf(hits.length)} réplique${hits.length > 1 ? 's' : ''}</div><div id="res-list"></div>`;
  const listEl = container.querySelector('#res-list');
  const more = n => {
    listEl.querySelector('.more')?.remove();
    const next = hits.slice(shown, shown + (n || 40));
    listEl.insertAdjacentHTML('beforeend', next.map((q, j) => entHTML(q, shown + j, { query })).join(''));
    shown += next.length;
    searchState.shown = shown;
    if (shown < hits.length) {
      listEl.insertAdjacentHTML('beforeend', `<button class="more">Afficher la suite · ${nf(hits.length - shown)} restantes</button>`);
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
function liveQuote(f) {
  if (!allQuotes.length) return { ...f, live: true };
  if (!byI || byI.src !== allQuotes) byI = { src: allQuotes, m: new Map(allQuotes.map(q => [q.i, q])) };
  const hit = (f.i != null && byI.m.get(f.i)) || null;
  if (hit && hit.quote === f.quote) return { ...hit, live: true };
  const t = allQuotes.find(x => sameQuote(f, x));
  return t ? { ...t, live: true } : { ...f, live: false };
}
function renderFavoris() {
  stopAudio();
  setMast('Favoris');
  const main = document.getElementById('main-content');
  if (!favorites.length) {
    main.innerHTML = `<div class="scroll"><div class="page-h"><h1>Favoris</h1><p>Aucune réplique enregistrée</p></div>
      <div class="empty">Vos répliques préférées se rangent ici.<small>Touchez « Favori » sous une réplique pour la ranger ici.</small>${allQuotes.length ? '<button id="fav-open">Ouvrir une réplique au hasard</button>' : ''}</div></div>`;
    document.getElementById('fav-open')?.addEventListener('click', () => { quoteIdx = pickRandom(); setView('citations'); });
    return;
  }
  const list = favorites.map(liveQuote);
  const sub = () => { const n = favorites.length; return `${nf(n)} réplique${n > 1 ? 's' : ''} enregistrée${n > 1 ? 's' : ''}${n > 1 ? ' · la plus récente en tête' : ''}`; };
  main.innerHTML = `<div class="scroll"><div class="page-h"><h1>Favoris</h1><p id="fav-count">${sub()}</p></div>
    <div id="fav-list">${list.map((q, k) => entHTML(q, k, { remove: true })).join('')}</div></div>`;
  bindEntries(main.querySelector('#fav-list'), k => list[k], { remove: true, onCount: () => { document.getElementById('fav-count').textContent = sub(); } });
}

// Lecteur sans commandes : toucher la vidéo la rejoue depuis le début, son activé
function replayVideo(v) {
  player.pause(); setPlayingBtn(null);          // jamais deux sons à la fois
  v.muted = false; v.currentTime = 0;
  v.play().catch(() => {});
}

// ===== SCÈNE EN GRAND (« Scène ») =====
function showVideo(q) {
  stopAudio();
  setMast('Scène');
  const overlay = openOverlay(`
    <div class="back"><button id="detail-back"><span class="arr" aria-hidden="true">←</span>Retour</button><span class="back-t">Scène</span></div>
    <div class="scroll scene-page">
      ${sceneHTML(q, 'mfig')}
      <figure class="body">
        <button class="who" id="m-who" aria-label="${esc(nameCase(q.name))}, voir la fiche du personnage">${esc(nameCase(q.name))}</button>
        <blockquote class="quote" lang="fr" style="font-size:${Math.round(Math.min(quoteSize(q.quote), Q_MAX.scene) * textScale())}px">${quoteHTML(q.quote)}</blockquote>
        ${fmtEp(q) ? `<figcaption class="src">${epHTML(q)}</figcaption>` : ''}
      </figure>
      <div class="acts a3">
        <button class="cell" id="m-fav" aria-pressed="${isFav(q)}"><span class="sq${isFav(q) ? ' on' : ''}" aria-hidden="true"></span>Favori</button>
        <button class="cell" id="m-share"><span class="arr" aria-hidden="true">↗</span><span class="t">Partager</span></button>
        <button class="cell" id="m-goto">Voir la réplique</button>
      </div>
    </div>`);
  const fig = document.getElementById('mfig');
  const v = document.createElement('video');
  v.className = 'quote-video'; v.id = 'mvideo';
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  wireScene(v);
  fig.querySelector('.frame').prepend(v);
  v.src = mediaSrc(videoURL(q));
  setScene(v, 'loading');
  bindScene(fig, v);
  v.muted = false;
  v.play().catch(e => { if (e.name === 'NotAllowedError') { v.muted = true; v.play().catch(() => {}); } });
  const fav = document.getElementById('m-fav');
  fav.addEventListener('click', () => {
    toggleFav(q); const on = isFav(q);
    fav.innerHTML = `<span class="sq${on ? ' on' : ''}" aria-hidden="true"></span>Favori`; fav.setAttribute('aria-pressed', on);
  });
  document.getElementById('m-share').addEventListener('click', e => shareQuote(q, e.currentTarget));
  document.getElementById('m-goto').addEventListener('click', () => gotoQuote(q));
  document.getElementById('m-who').addEventListener('click', () => openPersonnage(q.name));
  document.getElementById('detail-back').addEventListener('click', closeOverlay);
  return overlay;
}

// ===== NAVIGATION ENTRE ONGLETS =====
function bindNav() {
  document.getElementById('bottom-nav').querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (document.getElementById('bottom-nav').getAttribute('aria-disabled') === 'true' && !btn.classList.contains('keep')) return;
      if (btn.dataset.view !== currentView || !document.getElementById('detail-overlay').classList.contains('hidden')) setView(btn.dataset.view);
    });
  });
}
function setTabsEnabled(on) {
  const nav = document.getElementById('bottom-nav');
  if (on) { nav.removeAttribute('aria-disabled'); nav.querySelectorAll('.keep').forEach(b => b.classList.remove('keep')); }
  else nav.setAttribute('aria-disabled', 'true');
}
function setView(view) {
  if (!allQuotes.length && view !== 'favoris') {         // répliques pas encore chargées : seuls les favoris s'ouvrent
    if (view === 'citations' && !booting) { currentView = 'citations'; boot(); }
    return;
  }
  reloadIfIdle();
  stopAudio();
  closeSheet();
  closeOverlay();
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if      (view === 'citations')   renderCitations();
  else if (view === 'quiz')        renderQuiz();
  else if (view === 'personnages') renderPersonnages();
  else if (view === 'recherche')   renderRecherche();
  else if (view === 'favoris')     renderFavoris();
}

// ===== SERVICE WORKER ET MISES À JOUR =====
// Une nouvelle version n'est jamais appliquée en plein geste : on recharge seulement à un moment neutre
// (retour au premier plan, changement d'onglet, aucune feuille ni page superposée ouverte), et jamais au tout premier lancement.
let updatePending = false;
function reloadIfIdle() {
  if (updatePending && !sheetOpen() && document.getElementById('detail-overlay').classList.contains('hidden')) {
    updatePending = false;
    location.reload();
  }
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadCtrl = !!navigator.serviceWorker.controller;   // une version tournait déjà
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type !== 'SW_UPDATED' || !hadCtrl) return;
    updatePending = true;
  });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reloadIfIdle(); });

// ===== DÉMARRAGE =====
let retryTimer = null, autoRetried = false, booting = false;
async function boot() {
  clearTimeout(retryTimer);
  booting = true;
  currentView = 'citations';
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'citations'));
  const main = document.getElementById('main-content');
  setTabsEnabled(false);
  main.innerHTML = `<div class="boot"><div class="t">Chargement des répliques…</div></div>`;
  try {
    await loadData();
    quoteIdx = pool() ? rand(pool()) : Math.floor(Math.random() * allQuotes.length);
    randHistory = [quoteIdx];
    randPos = 0;
    setTabsEnabled(true);
    setView('citations');
    sendAvis();
    booting = false;
  } catch (e) {
    booting = false;
    console.error('Chargement des répliques :', e);
    const offline = navigator.onLine === false;
    setMast('Répliques');
    main.innerHTML = `
      <div class="empty"><span class="err-k">${offline ? 'Hors ligne' : 'Serveur indisponible'}</span>${offline
        ? 'Les répliques n’ont pas encore été téléchargées sur cet appareil.<small>Elles le seront dès le retour du réseau, sans rien faire. Il faut une seule connexion, ensuite l’app fonctionne hors ligne.</small>'
        : `Impossible de charger les répliques pour le moment.<small>Le site est peut-être en cours de mise à jour.${autoRetried ? '' : ' Nouvel essai automatique dans 10 s.'}</small>`}
        <div class="row2"><button id="btn-retry">Réessayer</button><button id="btn-myfav">Mes favoris</button></div>
      </div>`;
    // les favoris sont gardés sur l'appareil avec leur texte : ils restent consultables
    document.querySelectorAll('.nav-btn[data-view="favoris"], .nav-btn[data-view="citations"]').forEach(b => b.classList.add('keep'));
    document.getElementById('btn-retry').addEventListener('click', boot);
    document.getElementById('btn-myfav').addEventListener('click', () => setView('favoris'));
    if (offline) window.addEventListener('online', boot, { once: true });
    else if (!autoRetried) { autoRetried = true; retryTimer = setTimeout(() => { if (!allQuotes.length && currentView === 'citations') boot(); }, 10000); }
  }
}
document.addEventListener('touchstart', () => {}, { passive: true });   // iOS n'applique :active qu'avec un écouteur tactile
document.addEventListener('DOMContentLoaded', () => {
  loadFavorites();
  registerSW();
  bindNav();
  boot();
});
