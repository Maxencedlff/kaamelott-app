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
const MEDIA_CACHE_MAX = 16;
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
cardVideo.addEventListener('click', e => { e.stopPropagation(); replayVideo(cardVideo); });              // toucher = rejouer, avec le son
['loadeddata', 'playing'].forEach(ev => cardVideo.addEventListener(ev, () => cardVideo.parentElement?.classList.remove('loading')));
cardVideo.addEventListener('volumechange', () => cardVideo.parentElement?.classList.toggle('muted', cardVideo.muted));
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
function playCardVideo(q, slot) {
  const url = videoURL(q);
  const src = mediaSrc(url);
  slot.classList.toggle('loading', !src.startsWith('blob:'));
  slot.appendChild(cardVideo);
  if (cardVideo.src !== src) cardVideo.src = src;
  else if (cardVideo.readyState >= 2) slot.classList.remove('loading');
  cardVideo.currentTime = 0;
  // son activé par défaut ; si le navigateur refuse (aucun toucher encore), lecture sans son, signalée
  cardVideo.muted = false;
  slot.classList.remove('muted');
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

function setPlayingBtn(btn) {
  if (playingBtn && playingBtn !== btn) playingBtn.classList.remove('playing');
  playingBtn = btn;
  if (btn) btn.classList.add('playing');
}
function stopAudio() {
  player.pause();
  cardVideo.pause();
  document.querySelectorAll('video').forEach(v => v.pause());
  setPlayingBtn(null);
}
function playAudio(src, btn) {
  if (!src) return;
  // Re-tap sur le bouton en cours de lecture = stop
  if (btn && btn === playingBtn && !player.paused) { stopAudio(); return; }
  player.src = mediaSrc(audioURL(src));
  player.currentTime = 0;
  setPlayingBtn(btn || null);
  player.play().catch(() => setPlayingBtn(null));
}
player.addEventListener('ended', () => setPlayingBtn(null));

// Historique des citations vues en mode aléatoire
let randHistory = [];   // liste des quoteIdx visités
let randPos = -1;       // position courante dans l'historique

// ===== PARSE DATA =====
function parseQuote(item, i) {
  const raw = item.character || '';
  const commaIdx = raw.indexOf(',');
  const name = commaIdx > -1
    ? raw.slice(0, commaIdx).trim().replace(/\s+/g, ' ').toUpperCase()
    : raw.trim().replace(/\s+/g, ' ').toUpperCase();
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
      if (res.ok) raw = await res.json();
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
function isFav(q) { return favorites.some(f => f.quote === q.quote && f.name === q.name); }
function toggleFav(q) {
  if (isFav(q)) favorites = favorites.filter(f => !(f.quote === q.quote && f.name === q.name));
  else favorites.unshift(q);
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
// Titres d'épisode tout en capitales dans les scripts (« AU BONHEUR DES DAMES ») : remis en casse de phrase
function titleCase(t) {
  if (t === t.toUpperCase()) { const s = t.toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }
  // « Guenièvre Et L’Orage » → « Guenièvre et l’Orage » : petits mots en bas de casse après le premier
  return t.split(' ').map((w, k) => {
    if (!k) return w;
    if (/^(Et|De|Du|Des|La|Le|Les|Aux|Au|En|À|Sur|Un|Une)$/.test(w)) return w.toLowerCase();
    return w.replace(/^(L|D)(['’])/, (m, a, b) => a.toLowerCase() + b);
  }).join(' ');
}
// Typographie française : apostrophe courbe, espace fine insécable avant ; : ! ? et dans les guillemets
function typo(s) {
  return esc(s).replace(/'/g, '’')
    .replace(/[  ]+([!?;:»])/g, ' $1')
    .replace(/([^\s ])([!?;»])/g, '$1 $2')
    .replace(/«[  ]*/g, '« ');
}
function quoteHTML(s) { return `<span class="g">«</span> ${typo(s)} <span class="g">»</span>`; }
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
function highlight(text, query) {
  const t = typo(text);
  if (!query) return t;
  // surlignage insensible aux accents : on cherche dans la version sans accents et on reporte les positions
  const plain = text.replace(/'/g, '’'), f = fold(plain), qf = fold(query);
  if (!qf || f.indexOf(qf) < 0) return t;
  let out = '', from = 0, at;
  while ((at = f.indexOf(qf, from)) >= 0) {
    out += typo(plain.slice(from, at)) + '<mark>' + typo(plain.slice(at, at + qf.length)) + '</mark>';
    from = at + qf.length;
  }
  return out + typo(plain.slice(from));
}
function getCharList() {
  const map = {};
  allQuotes.forEach(q => { map[q.name] = (map[q.name] || 0) + 1; });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
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
function renderCitations() {
  const main = document.getElementById('main-content');
  if (!allQuotes.length) return;
  stopAudio();
  if (!allQuotes[quoteIdx]) quoteIdx = pickRandom();          // index périmé (filtres, données changées)
  const q = allQuotes[quoteIdx];
  currentQuote = q;
  setMast(verifyMode ? 'Vérification' : 'Répliques');
  const P = pool();
  const counter = verifyMode
    ? `${nf(verifyIdx.length)} à vérifier · ${nf(Object.keys(avisFaits).length)} vérifiées${avisFile.length ? ` · ${avisFile.length} en attente d’envoi` : ''}`
    : P
    ? `${nf(P.indexOf(quoteIdx) + 1)} / ${nf(P.length)}${videoOnly ? ' avec vidéo' : audioOnly ? ' avec son' : ''}`
    : `${nf(quoteIdx + 1)} / ${nf(allQuotes.length)}`;
  const sep = '<span class="sep">·</span>';
  const summary = verifyMode
    ? [verifyApprox ? 'Sons estimés d’abord' : 'Toutes les répliques', source === 'all' ? '' : SRC_LABEL[source]].filter(Boolean).join(sep)
    : [SRC_LABEL[source], { text: 'Texte', audio: 'Son', video: 'Vidéo' }[mediaMode()], inOrder ? 'Dans l’ordre' : 'Aléatoire', autoPlay ? 'Lecture auto' : '']
        .filter(Boolean).join(sep);
  const inlineVideo = (videoOnly || verifyMode) && q.video;
  const reviewable = verifyMode && (q.audio || q.video);
  const fav = isFav(q);
  const long = q.quote.length > 320;   // réplique longue : la source passe sous le nom pour rester visible
  const what = q.audio && q.video ? 'Son et vidéo OK' : q.video ? 'Vidéo OK' : 'Son OK';

  main.innerHTML = `
    <button class="bar${verifyMode ? ' verify' : ''}" id="btn-settings" aria-label="Réglages">
      <span class="bar-sum">${summary}</span><span class="bar-btn"><i></i>Réglages</span>
    </button>
    <div class="stage swap-in" id="quote-card">
      ${inlineVideo ? `<div class="frame" id="qvideo-slot"><div class="spin"></div><div class="hint"><i></i>Touchez l’écran pour activer le son</div></div>` : ''}
      <div class="qblock">
        <button class="who" id="btn-who">${esc(q.name)}</button>
        ${long && fmtEp(q) ? `<div class="src src-top">${esc(fmtEp(q))}</div>` : ''}
        <div class="quote" style="font-size:${inlineVideo ? Math.min(quoteSize(q.quote), window.innerWidth < 360 ? 21 : 26) : quoteSize(q.quote)}px">${quoteHTML(q.quote)}</div>
        ${!long && fmtEp(q) ? `<div class="src">${esc(fmtEp(q))}</div>` : ''}
      </div>
    </div>
    <div class="stage-foot"><span class="quote-counter">${counter}</span>
      <span class="quote-hint">${verifyMode ? 'Glissez pour passer' : inOrder ? 'Touchez pour la suivante' : 'Touchez pour changer'}</span></div>
    <div class="acts">
      ${q.audio ? `<button class="cell" id="btn-audio"><span class="tri"></span><span class="stop"></span><span class="lp">Écouter</span><span class="ls">Arrêter</span>${q.approx ? '<span class="x">*</span>' : ''}</button>` : ''}
      ${q.video && !inlineVideo ? `<button class="cell" id="btn-video"><span class="frm"></span>Scène</button>` : ''}
      <button class="cell" id="btn-fav" aria-pressed="${fav}"><span class="sq${fav ? ' on' : ''}"></span>Favori</button>
      <button class="cell" id="btn-share" aria-label="Partager"><span class="arr">↗</span><span class="t">Partager</span></button>
    </div>
    ${q.audio && q.approx ? `<p class="est-note"><b>*</b> Son estimé<span class="est-long"> : découpe calculée automatiquement, il peut déborder un peu sur les répliques voisines</span><span class="est-short"> : peut déborder un peu</span>.</p>` : ''}
    ${reviewable
      ? `<div class="vrow"><button class="ok" id="avis-ok"><i></i>${what}</button><button class="ko" id="avis-ko">Problème</button></div>`
      : `<div class="nav"><button id="btn-prev"><span class="arr">←</span>Préc.</button><button class="mid" id="btn-random">Au hasard</button><button class="nx" id="btn-next">Suiv.<span class="arr">→</span></button></div>`}`;

  const $ = id => document.getElementById(id);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-who').addEventListener('click', e => { e.stopPropagation(); openPersonnage(q.name); });
  $('btn-fav').addEventListener('click', () => {
    toggleFav(q);
    const on = isFav(q);
    $('btn-fav').innerHTML = `<span class="sq${on ? ' on' : ''}"></span>Favori`;
    $('btn-fav').setAttribute('aria-pressed', on);
  });
  $('btn-share').addEventListener('click', () => shareQuote(q));
  if (reviewable) {
    $('avis-ok').addEventListener('click', () => recordAvis(q, true, [], ''));
    $('avis-ko').addEventListener('click', () => openProblem(q));
  } else {
    $('btn-prev').addEventListener('click', () => prevQuote());
    $('btn-next').addEventListener('click', () => nextQuote());
    $('btn-random').addEventListener('click', () => randomQuote());
  }
  const slot = $('qvideo-slot');
  if (slot) playCardVideo(q, slot);
  else cardVideo.pause();
  prefetchAround();
  const btnVideo = $('btn-video');
  if (btnVideo) btnVideo.addEventListener('click', () => showVideo(q));
  const audioBtn = $('btn-audio');
  if (audioBtn) {
    audioBtn.addEventListener('click', () => playAudio(q.audio, audioBtn));
    // Lecture auto : renderCitations est appelé dans le geste (tap/swipe/bouton), donc le navigateur l'autorise
    if (autoPlay && !inlineVideo) playAudio(q.audio, audioBtn);
  }

  const card = $('quote-card');
  const hint = document.querySelector('.stage-foot .quote-hint');
  const hintText = hint ? hint.textContent : '';
  const fit = () => {
    const more = card.scrollHeight > card.clientHeight + 4 && card.scrollTop + card.clientHeight < card.scrollHeight - 4;
    card.classList.toggle('more', more);
    if (hint) hint.textContent = more ? 'Faites défiler pour la suite ↓' : hintText;
  };
  card.addEventListener('scroll', fit, { passive: true });
  requestAnimationFrame(fit);
  card.addEventListener('click', e => { if (!e.target.closest('button')) swipeForward(); });
  // Glisser horizontalement : réplique suivante / précédente (le défilement vertical reste libre)
  let sx = 0, sy = 0;
  card.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  card.addEventListener('touchmove', e => {
    const dx = Math.abs(e.touches[0].clientX - sx), dy = Math.abs(e.touches[0].clientY - sy);
    if (dx > dy && dx > 8) e.preventDefault();
  }, { passive: false });
  card.addEventListener('touchend', e => {
    const dx = sx - e.changedTouches[0].clientX, dy = Math.abs(sy - e.changedTouches[0].clientY);
    if (Math.abs(dx) > 50 && Math.abs(dx) > dy) { if (dx > 0) swipeForward(); else swipeBack(); }
  }, { passive: true });
}

// ===== AVIS DE VÉRIFICATION =====
// tableau Son / Scène / Texte × Faux / Coupé / Déborde
const PB_GRID = [
  ['Faux',    { audio: 'son_faux',    video: 'video_fausse', texte: 'texte_faux' }],
  ['Coupé',   { audio: 'son_coupe',   video: 'video_coupee' }],
  ['Déborde', { audio: 'son_deborde' }],
];
function openProblem(q) {
  const cols = [['audio', 'Son'], ['video', 'Scène'], ['texte', 'Texte']];
  const has = k => k === 'texte' || !!q[k];
  const sheet = openSheet(`
    <p class="sh-ctx">${esc(nameCase(q.name))}${fmtEp(q) ? ' · ' + esc(fmtEp(q)) : ''}</p>
    <div class="sh-head">
      <div><h2>Signaler un problème</h2></div>
      <button class="sh-close" id="sheet-close">✕ Fermer</button>
    </div>
    <div class="tbl">
      <div class="th"></div>${cols.map(([, l]) => `<div class="th">${l}</div>`).join('')}
      ${PB_GRID.map(([row, ids]) => `<div class="rh">${row}</div>` + cols.map(([k]) =>
        ids[k] && has(k) ? `<button class="tc" data-pb="${ids[k]}" aria-label="${row} : ${k}"><span class="box"></span></button>` : `<div class="tc nil">—</div>`).join('')).join('')}
    </div>
    <label class="note"><span>Précision (facultatif)</span><textarea id="avis-note" maxlength="500"></textarea></label>
    <div class="sh-acts"><button id="avis-cancel">Annuler</button><button class="go" id="avis-send" disabled>Consigner et passer</button></div>
    <p class="sh-help" id="avis-help">Cochez au moins une case, ou écrivez une précision.</p>`);
  const picked = new Set();
  const send = sheet.querySelector('#avis-send'), note = sheet.querySelector('#avis-note');
  const upd = () => { send.disabled = !picked.size && !note.value.trim(); sheet.querySelector('#avis-help').hidden = !send.disabled; };
  sheet.querySelectorAll('[data-pb]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.pb;
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    b.classList.toggle('on', picked.has(id)); upd();
  }));
  note.addEventListener('input', upd);
  sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
  sheet.querySelector('#avis-cancel').addEventListener('click', closeSheet);
  send.addEventListener('click', () => { closeSheet(); recordAvis(q, false, [...picked], note.value.trim()); });
}
function recordAvis(q, ok, problemes, note) {
  avisFaits[q.i] = 1;
  avisFile.push({ i: q.i, quote: q.quote, name: q.name, audio: q.audio, video: q.video, approx: q.approx, ok, problemes, note, ts: Date.now() });
  writeJSON('kaam_avis_faits', avisFaits);
  writeJSON('kaam_avis_file', avisFile);
  if (avisFile.length >= 5) sendAvis();
  rebuildVerify();
  if (!verifyIdx.length) { renderCitations(); return; }
  if (inOrder) stepQuote(1); else randomQuote();
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
  renderCitations();
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
  renderCitations();
}
// Toucher / glisser : selon le mode, réplique suivante dans l'ordre ou au hasard (avec historique)
function swipeForward() { if (inOrder) stepQuote(1); else historyForward(); }
function swipeBack()    { if (inOrder) stepQuote(-1); else historyBack(); }
function historyBack() {
  if (randPos > 0) { randPos--; quoteIdx = randHistory[randPos]; renderCitations(); }
}
function historyForward() {
  if (randPos < randHistory.length - 1) { randPos++; quoteIdx = randHistory[randPos]; renderCitations(); }
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
let quizPool = null;
function initQuiz() {
  let best = 0;
  try { best = +localStorage.getItem('kaam_quiz_best') || 0; } catch {}
  quizState = { correct: 0, total: 0, streak: 0, best, answered: false };
}
function renderQuiz() {
  if (!quizState) initQuiz();
  if (!quizPool) quizPool = allQuotes.filter(x => TOP_CHARS.includes(x.name) && x.quote.length > 12);
  stopAudio();
  setMast('Qui a dit ça ?');
  const main = document.getElementById('main-content');
  const q = rand(quizPool);
  quizState.current = q;
  quizState.answered = false;
  const others = TOP_CHARS.filter(c => c !== q.name);
  const wrong = [];
  while (wrong.length < 3) { const p = rand(others); if (!wrong.includes(p)) wrong.push(p); }
  const choices = [q.name, ...wrong].sort(() => Math.random() - .5);

  main.innerHTML = `
    <div class="score">
      <div><span>Score</span><b>${quizState.correct}<em>/${quizState.total}</em></b></div>
      <div><span>Série</span><b>${quizState.streak}</b></div>
      <div><span>Record</span><b>${quizState.best}</b></div>
    </div>
    <div class="scroll" id="quiz-stage">
      <div class="quiz-q">
        <div class="q-ask">Qui a dit ça ?</div>
        <div class="quote" style="font-size:${Math.min(quoteSize(q.quote), 30)}px">${quoteHTML(q.quote)}</div>
        <div id="quiz-after"></div>
      </div>
      <div class="choices">
        ${choices.map((c, k) => `<button class="choice" data-choice="${esc(c)}"><span class="l">${'ABCD'[k]}</span><span class="n">${esc(nameCase(c))}</span><span class="v"></span></button>`).join('')}
      </div>
      <div id="quiz-scene" class="q-scene"></div>
    </div>
    <div class="nav one" id="quiz-nav"><button id="quiz-next">Passer<span class="arr">→</span></button></div>`;

  document.getElementById('quiz-next').addEventListener('click', () => renderQuiz());
  document.querySelectorAll('.choice').forEach(btn => btn.addEventListener('click', () => {
    if (quizState.answered) return;
    quizState.answered = true;
    quizState.total++;
    const correct = btn.dataset.choice === q.name;
    if (correct) {
      quizState.correct++; quizState.streak++;
      if (quizState.streak > quizState.best) {
        quizState.best = quizState.streak;
        try { localStorage.setItem('kaam_quiz_best', String(quizState.best)); } catch {}
      }
    } else quizState.streak = 0;
    document.querySelectorAll('.choice').forEach(b => {
      b.disabled = true;
      if (b.dataset.choice === q.name) { b.classList.add('right'); b.querySelector('.v').textContent = 'Juste'; }
      else if (b === btn) { b.classList.add('wrong'); b.querySelector('.v').textContent = 'Faux'; }
      else b.classList.add('dim', 'hidden');   // on ne garde que la bonne réponse (et l'erreur) : place pour la scène
    });
    const sc = document.querySelector('.score');
    sc.children[0].querySelector('b').innerHTML = `${quizState.correct}<em>/${quizState.total}</em>`;
    sc.children[1].querySelector('b').textContent = quizState.streak;
    sc.children[2].querySelector('b').textContent = quizState.best;
    // la récompense : la scène, projetée dans le geste (donc avec le son)
    if (q.video) {
      const scene = document.getElementById('quiz-scene');
      scene.innerHTML = `<div class="frame" id="quiz-frame"><div class="spin"></div><div class="hint"><i></i>Touchez l’écran pour activer le son</div></div>`;
      playCardVideo(q, document.getElementById('quiz-frame'));
    } else if (q.audio) playAudio(q.audio, null);
    document.getElementById('quiz-after').innerHTML = `<p class="src"><b>${esc(nameCase(q.name))}</b>${fmtEp(q) ? ' · ' + esc(fmtEp(q)) : ''}</p>`;
    document.getElementById('quiz-stage').scrollTop = 0;
    const nav = document.getElementById('quiz-nav');
    nav.innerHTML = `<button id="quiz-next">Question suivante<span class="arr">→</span></button>`;
    document.getElementById('quiz-next').addEventListener('click', () => renderQuiz());
  }));
}

// ===== ENTRÉES DE LISTE (fiche, recherche, favoris) =====
function entHTML(q, k, opts = {}) {
  const fav = isFav(q);
  return `<div class="ent" data-k="${k}">
    <div class="ent-m">${opts.name === false ? '' : `<b>${opts.query ? highlight(nameCase(q.name), opts.query) : esc(nameCase(q.name))}</b>`}${esc(fmtEp(q))}</div>
    <div class="ent-q" data-act="goto">${opts.query ? highlight(q.quote, opts.query) : typo(q.quote)}</div>
    <div class="ent-a">
      ${q.audio ? `<button class="cell" data-act="audio"><span class="tri"></span><span class="stop"></span><span class="lp">Écouter</span><span class="ls">Arrêter</span></button>` : ''}
      ${q.video ? `<button class="cell" data-act="video"><span class="frm"></span>Scène</button>` : ''}
      <button class="cell" data-act="fav"><span class="sq${fav ? ' on' : ''}"></span>${opts.remove ? 'Retirer' : fav ? 'En favori' : 'Favori'}</button>
    </div>
  </div>`;
}
// Délégation des actions d'une liste d'entrées ; list(k) rend la réplique de l'entrée k
function bindEntries(container, list, onFavChange) {
  container.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const ent = a.closest('.ent');
    const q = list(+ent.dataset.k);
    if (!q) return;
    if (a.dataset.act === 'audio') playAudio(q.audio, a);
    else if (a.dataset.act === 'video') showVideo(q);
    else if (a.dataset.act === 'goto') gotoQuote(q);
    else if (a.dataset.act === 'fav') {
      toggleFav(q);
      if (onFavChange) onFavChange();
      else { const on = isFav(q); a.innerHTML = `<span class="sq${on ? ' on' : ''}"></span>${on ? 'En favori' : 'Favori'}`; }
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
  const list = persSort === 'alpha' ? [...chars].sort((a, b) => a[0].localeCompare(b[0], 'fr')) : chars;
  let rows = '', letter = '';
  list.forEach(([name, count]) => {
    if (persSort === 'alpha') {
      const l = fold(name.replace(/^(LE|LA|LES|L')\s*/, '')).charAt(0).toUpperCase();
      if (l !== letter) { letter = l; rows += `<div class="idx-l">${l}</div>`; }
    }
    rows += `<button class="idx-row" data-char="${esc(name)}"><span class="n">${esc(nameCase(name))}</span><span class="c">${nf(count)}</span>
      <span class="bar-c" style="width:calc((100% - 2 * var(--pad)) * ${Math.max(.02, count / max).toFixed(3)})"></span></button>`;
  });
  main.innerHTML = `
    <div class="scroll">
      <div class="page-h"><h1>Personnages</h1><p>${nf(chars.length)} personnages · ${nf(allQuotes.length)} répliques</p></div>
      <div class="sort"><button class="${persSort === 'count' ? 'on' : ''}" data-sort="count">Par nombre de répliques</button><button class="${persSort === 'alpha' ? 'on' : ''}" data-sort="alpha">De A à Z</button></div>
      <div class="perso-list">${rows}</div>
    </div>`;
  main.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => { persSort = b.dataset.sort; renderPersonnages(); }));
  main.querySelectorAll('.idx-row').forEach(row => row.addEventListener('click', () => openPersonnage(row.dataset.char)));
}

function closeOverlay() {
  const overlay = document.getElementById('detail-overlay');
  overlay.querySelectorAll('video').forEach(v => v.pause());
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}
function openPersonnage(name) {
  stopAudio();
  detailChar = name;
  const quotes = allQuotes.filter(q => q.name === name);
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.remove('hidden');
  let shown = 0;
  overlay.innerHTML = `
    <button class="back" id="detail-back"><span class="arr">←</span>Personnages</button>
    <div class="scroll" id="fiche-scroll">
      <div class="fiche-h"><h1>${esc(nameCase(name))}</h1>
        <div class="stats">
          <div><span>Répliques</span><b>${nf(quotes.length)}</b></div>
          <div><span>Avec son</span><b>${nf(quotes.filter(q => q.audio).length)}</b></div>
          <div><span>Avec scène</span><b>${nf(quotes.filter(q => q.video).length)}</b></div>
        </div>
      </div>
      <div id="fiche-list"></div>
    </div>`;
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
let searchTimeout = null, foldCache = null;
function renderRecherche() {
  stopAudio();
  setMast('Chercher');
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="search">
      <input type="search" id="search-input" placeholder="Un mot, une réplique, un nom" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      <button class="clr" id="search-clear">Effacer</button>
    </div>
    <div class="scroll" id="search-results"></div>`;
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const idle = () => { results.innerHTML = `<div class="empty">Cherchez parmi les ${nf(allQuotes.length)} répliques.<small>Les accents sont facultatifs : « leodagan » trouve Léodagan.</small></div>`; };
  idle();
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const v = input.value.trim();
    if (v.length < 2) { idle(); return; }
    searchTimeout = setTimeout(() => doSearch(v, results), 180);
  });
  document.getElementById('search-clear').addEventListener('click', () => { input.value = ''; idle(); input.focus(); });
  input.focus();
}
function doSearch(query, container) {
  if (!foldCache) foldCache = allQuotes.map(x => fold(`${x.quote} ${x.name} ${x.title}`));
  const qf = fold(query);
  const hits = [];
  for (let i = 0; i < allQuotes.length; i++) if (foldCache[i].includes(qf)) hits.push(allQuotes[i]);
  if (!hits.length) {
    container.innerHTML = `<div class="empty">Aucune réplique ne contient « ${esc(query)} ».<small>Essayez un seul mot, ou le nom d’un personnage.</small></div>`;
    return;
  }
  let shown = 0;
  container.innerHTML = `<div class="res-n">${nf(hits.length)} réplique${hits.length > 1 ? 's' : ''}</div><div id="res-list"></div>`;
  const listEl = container.querySelector('#res-list');
  const more = () => {
    listEl.querySelector('.more')?.remove();
    const next = hits.slice(shown, shown + 40);
    listEl.insertAdjacentHTML('beforeend', next.map((q, j) => entHTML(q, shown + j, { query })).join(''));
    shown += next.length;
    if (shown < hits.length) {
      listEl.insertAdjacentHTML('beforeend', `<button class="more">Afficher la suite (${nf(hits.length - shown)} restantes)</button>`);
      listEl.querySelector('.more').addEventListener('click', more);
    }
  };
  more();
  bindEntries(listEl, k => hits[k]);
}

// ===== FAVORIS =====
// Les favoris sont gardés tels qu'enregistrés ; on retrouve la réplique à jour (son, scène) quand elle existe
function liveQuote(f) { return allQuotes.find(x => x.quote === f.quote && x.name === f.name) || f; }
function renderFavoris() {
  stopAudio();
  setMast('Favoris');
  const main = document.getElementById('main-content');
  if (!favorites.length) {
    main.innerHTML = `<div class="scroll"><div class="page-h"><h1>Favoris</h1><p>Aucune réplique enregistrée</p></div>
      <div class="empty">Vos répliques préférées se rangent ici.<small>Touchez « Mettre en favori » sous une réplique pour la garder.</small></div></div>`;
    return;
  }
  const list = favorites.map(liveQuote);
  main.innerHTML = `<div class="scroll"><div class="page-h"><h1>Favoris</h1><p>${nf(list.length)} réplique${list.length > 1 ? 's' : ''} enregistrée${list.length > 1 ? 's' : ''}</p></div>
    <div id="fav-list">${list.map((q, k) => entHTML(q, k, { remove: true })).join('')}</div></div>`;
  bindEntries(main.querySelector('#fav-list'), k => list[k], () => renderFavoris());
}

// Lecteur sans commandes : toucher la vidéo la rejoue depuis le début, son activé
function replayVideo(v) {
  v.muted = false; v.currentTime = 0;
  v.play().catch(() => {});
}

// ===== SCÈNE EN GRAND (« Voir la scène ») =====
function showVideo(q) {
  stopAudio();
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <button class="back" id="detail-back"><span class="arr">←</span>Retour</button>
    <div class="scroll scene-page">
      <div class="frame" id="mframe"><video class="quote-video" id="mvideo" src="${mediaSrc(videoURL(q))}" playsinline autoplay></video>
        <div class="hint"><i></i>Touchez l’écran pour activer le son</div></div>
      <div class="body">
        <div class="who">${esc(q.name)}</div>
        <div class="quote" style="font-size:${Math.min(quoteSize(q.quote), 28)}px">${quoteHTML(q.quote)}</div>
        ${fmtEp(q) ? `<div class="src">${esc(fmtEp(q))}</div>` : ''}
      </div>
    </div>`;
  const v = document.getElementById('mvideo'), frame = document.getElementById('mframe');
  v.addEventListener('volumechange', () => frame.classList.toggle('muted', v.muted));
  v.muted = false;
  v.play().catch(e => { if (e.name === 'NotAllowedError') { v.muted = true; v.play().catch(() => {}); } });
  frame.addEventListener('click', () => replayVideo(v));
  document.getElementById('detail-back').addEventListener('click', closeOverlay);
}

// ===== NAVIGATION ENTRE ONGLETS =====
function bindNav() {
  document.getElementById('bottom-nav').querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view !== currentView || !document.getElementById('detail-overlay').classList.contains('hidden')) setView(btn.dataset.view);
    });
  });
}
function setView(view) {
  stopAudio();
  closeSheet();
  closeOverlay();
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if      (view === 'citations')   renderCitations();
  else if (view === 'quiz')        renderQuiz();
  else if (view === 'personnages') renderPersonnages();
  else if (view === 'recherche')   renderRecherche();
  else if (view === 'favoris')     renderFavoris();
}

// ===== SERVICE WORKER =====
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Rechargement automatique quand le SW signale une nouvelle version
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'SW_UPDATED') window.location.reload();
  });
}

// ===== DÉMARRAGE =====
document.addEventListener('DOMContentLoaded', async () => {
  loadFavorites();
  registerSW();
  try {
    await loadData();
    quoteIdx = pool() ? rand(pool()) : Math.floor(Math.random() * allQuotes.length);
    randHistory = [quoteIdx];
    randPos = 0;
    renderCitations();
    bindNav();
    sendAvis();
  } catch (e) {
    console.error('Chargement des répliques :', e);
    document.getElementById('main-content').innerHTML = `
      <div class="empty">Impossible de charger les répliques pour le moment.
        <small>Vérifiez la connexion, puis réessayez.</small>
        <button id="btn-retry">Réessayer</button>
      </div>`;
    document.getElementById('btn-retry').addEventListener('click', () => location.reload());
  }
});
