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
// ===== ICÔNES (SVG au trait, à la place des emojis) =====
const ICONS = {
  play: '<polygon points="7 4 19 12 7 20 7 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  order: '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  autoplay: '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
  check: '<path d="M21.8 10A10 10 0 1 1 17 3.3"/><path d="m9 11 3 3L22 4"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  mute: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
};
function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

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
  if (verifyMode) return bySource(verifyIdx);
  if (videoOnly && videoIdx.length) return bySource(videoIdx);
  if (audioOnly && audioIdx.length) return bySource(audioIdx);
  return source === 'all' ? null : bySource(null);
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
  const todo = allQuotes.reduce((acc, q, i) => ((q.audio || q.video) && !avisFaits[q.i] && acc.push(i), acc), []);
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

function audioBtnHTML(id, big, approx) {
  // approx : son placé par l'écart entre les répliques voisines (peut déborder un peu sur elles)
  return `<button class="audio-btn${big ? ' audio-btn-big' : ''}" id="${id}" aria-label="Écouter la réplique"${approx ? ' title="Son estimé : peut déborder un peu sur les répliques voisines"' : ''}>
    <span class="audio-icon-play">${icon('play')}</span><span class="audio-icon-stop">${icon('stop')}</span>
    <span class="audio-label">Écouter</span>${approx ? '<span class="approx-tag">estimé</span>' : ''}
  </button>`;
}

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
  let raw = null;
  for (let essai = 0; essai < 3 && !raw; essai++) {
    if (essai) await new Promise(r => setTimeout(r, 2500));
    try {
      const res = await fetch('data.json', { cache: essai ? 'reload' : 'default' });
      if (res.ok) raw = await res.json();
    } catch {}
  }
  if (!raw) throw new Error('data.json indisponible');
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
function fmtEp(q) {
  if (q.film) return `Film · ${q.film}`;
  if (q.inedit) return `${q.inedit} · jamais tourné`;
  if (!q.livre && !q.episode) return '';
  let s = '';
  if (q.livre)   s += `Livre ${q.livre}`;
  if (q.episode) s += ` · Épisode ${q.episode}`;
  if (q.title)   s += ` : ${q.title}`;
  return s;
}
function getCharList() {
  const map = {};
  allQuotes.forEach(q => { map[q.name] = (map[q.name] || 0) + 1; });
  return Object.entries(map).sort((a,b) => b[1] - a[1]);
}
// ===== CHARACTER AVATARS (SVG généré — couleur par perso, teinte par livre) =====

// Teinte (hue) spécifique à chaque personnage
const CHAR_HUE = {
  'ARTHUR':          42,   // or royal
  'PERCEVAL':        110,  // vert forêt
  'LÉODAGAN':        4,    // rouge sang
  'LANCELOT':        215,  // bleu acier
  'GUENIÈVRE':       290,  // violet
  'KARADOC':         28,   // orange
  'SÉLI':            325,  // rose
  'MERLIN':          265,  // violet foncé
  'PÈRE BLAISE':     175,  // teal
  'BOHORT':          200,  // bleu ciel
  'YVAIN':           155,  // vert menthe
  'GAUVAIN':         90,   // vert lime
  'LA DAME DU LAC':  190,  // bleu océan
  'PENDRAGON':       235,  // bleu nuit
  'ATTILA':          15,   // rouge-orange
  'GUETHENOC':       75,   // vert olive
  'LE TAVERNIER':    35,   // brun chaud
  'DEMETRA':         50,   // jaune doré
  'VENEC':           130,  // vert clair
  'GALESSIN':        170,  // turquoise
  'ARTURUS':         42,   // même qu'Arthur (version latine)
};

// Luminosité de fond selon le livre (de I clair → VI sombre)
const LIVRE_LIGHTNESS = { 'I': 32, 'II': 30, 'III': 27, 'IV': 24, 'V': 21, 'VI': 18 };

function getInitials(name) {
  if (name.startsWith('LA ') || name.startsWith('LE ') || name.startsWith("L'")) {
    const parts = name.split(/\s+/);
    return parts[parts.length - 1].charAt(0);
  }
  const parts = name.split(/\s+/);
  return parts[0].charAt(0);
}

function generateAvatar(name, livre) {
  const h  = CHAR_HUE[name] ?? 45;
  const l  = LIVRE_LIGHTNESS[livre?.toUpperCase()] ?? 26;
  const s  = 55;
  const bg1 = `hsl(${h},${s}%,${l + 9}%)`;
  const bg2 = `hsl(${h},${s}%,${l}%)`;
  const ring = `hsl(${h},${s + 15}%,${l + 28}%)`;
  const text = `hsl(${h},${Math.min(s + 20, 88)}%,${l + 58}%)`;
  const init = getInitials(name);
  const fs   = init.length > 1 ? 34 : 44;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${bg1}"/>
    <stop offset="100%" stop-color="${bg2}"/>
  </linearGradient>
</defs>
<circle cx="50" cy="50" r="50" fill="url(#bg)"/>
<circle cx="50" cy="50" r="46" fill="none" stroke="${ring}" stroke-width="1" opacity=".4"/>
<text x="50" y="64" text-anchor="middle"
  font-family="Georgia,serif" font-size="${fs}" font-weight="bold"
  fill="${text}" opacity=".95">${init}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Purger les anciennes images Wikipedia du localStorage
(function clearOldWikiCache() {
  try {
    Object.keys(localStorage).filter(k => k.startsWith('kaam_img_')).forEach(k => localStorage.removeItem(k));
  } catch {}
})();

function loadAvatars() {
  document.querySelectorAll('[data-name]').forEach(el => {
    if (el.querySelector('img')) return;
    const name  = el.dataset.name;
    const livre = el.dataset.livre || '';
    el.innerHTML = `<img src="${generateAvatar(name, livre)}" alt="${esc(name)}">`;
    el.classList.add('has-img');
  });
}
function highlight(text, query) {
  if (!query) return esc(text);
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}

// ===== CITATIONS =====
function renderCitations() {
  const main = document.getElementById('main-content');
  if (!allQuotes.length) return;

  stopAudio();
  const q = allQuotes[quoteIdx];
  currentQuote = q;
  const favActive = isFav(q);
  const ep = fmtEp(q);
  const P = pool();
  const counter = verifyMode
    ? `${verifyIdx.length} ${verifyApprox ? 'sons estimés (≈) à vérifier en premier' : 'à vérifier'} · ${Object.keys(avisFaits).length} vérifiées${avisFile.length ? ` · ${avisFile.length} en attente d'envoi` : ''}`
    : P
    ? `${(P.indexOf(quoteIdx) + 1).toLocaleString('fr-FR')} / ${P.length.toLocaleString('fr-FR')} répliques${videoOnly ? ' avec vidéo' : audioOnly ? ' avec son' : ''}${source === 'film' ? ' du film' : source === 'serie' ? ' de la série' : ''}`
    : `${(quoteIdx + 1).toLocaleString('fr-FR')} / ${allQuotes.length.toLocaleString('fr-FR')}`;
  const media = videoOnly ? 'video' : audioOnly ? 'audio' : 'text';
  const inlineVideo = (videoOnly || verifyMode) && q.video;
  const reviewable = verifyMode && (q.audio || q.video);

  main.innerHTML = `
    <div class="citations-view">
      <div class="filters">
        <div class="seg" role="group" aria-label="Source">
          <button class="${source === 'all' ? 'on' : ''}" data-src="all">Tout</button>
          <button class="${source === 'serie' ? 'on' : ''}" data-src="serie">Série</button>
          <button class="${source === 'film' ? 'on' : ''}" data-src="film" id="chip-film">Film</button>
        </div>
        <div class="seg" role="group" aria-label="Affichage">
          <button class="${media === 'text' ? 'on' : ''}" id="chip-text">Texte</button>
          <button class="${media === 'audio' ? 'on' : ''}" id="chip-audio-only">Son</button>
          ${videoIdx.length ? `<button class="${media === 'video' ? 'on' : ''}" id="chip-video-only">Vidéo</button>` : ''}
        </div>
        <div class="toggles">
          <button class="tgl" id="chip-order">${icon(inOrder ? 'order' : 'shuffle')}<span>${inOrder ? 'Dans l\'ordre' : 'Aléatoire'}</span></button>
          <button class="tgl ${autoPlay ? 'on' : ''}" id="chip-autoplay">${icon('autoplay')}<span>Lecture auto</span></button>
          <button class="tgl ${verifyMode ? 'on' : ''}" id="chip-verify">${icon('check')}<span>Vérifier</span></button>
        </div>
      </div>
      <div class="quote-counter">${counter}</div>

      <div class="quote-card" id="quote-card">
        ${inlineVideo
          ? `<div class="video-slot" id="qvideo-slot"><div class="video-spinner"></div><div class="video-muted">${icon('mute')}Touchez la vidéo pour le son</div></div>
             <div class="quote-text quote-text-small">${esc(q.quote)}</div>`
          : `<div class="quote-text">${esc(q.quote)}</div>`}
        <div class="quote-char">
          <div class="char-avatar" data-name="${esc(q.name)}" data-livre="${esc(q.livre)}">${esc(q.name.charAt(0))}</div>
          <div class="quote-char-name">${esc(q.name)}</div>
          ${ep ? `<div class="quote-char-ep">${esc(ep)}</div>` : ''}
        </div>
        ${verifyMode && inlineVideo && q.audio ? `<div class="quote-audio">${audioBtnHTML('btn-audio', true, q.approx)}</div>` : ''}
        ${!inlineVideo && (q.audio || q.video) ? `<div class="quote-audio">
          ${q.audio ? audioBtnHTML('btn-audio', true, q.approx) : ''}
          ${q.video ? `<button class="audio-btn audio-btn-big" id="btn-video">${icon('film')}<span class="audio-label">Voir la scène</span></button>` : ''}
        </div>` : ''}
      </div>
      ${reviewable ? avisHTML(q) : ''}

      <div class="quote-actions">
        <button class="quote-action-btn" id="btn-prev" title="Précédente" aria-label="Précédente">${icon('prev')}</button>
        <button class="quote-action-btn ${favActive ? 'active' : ''}" id="btn-fav" title="Favori" aria-label="Favori">${icon('heart')}</button>
        <button class="quote-action-btn" id="btn-random" title="Au hasard" aria-label="Au hasard">${icon('shuffle')}</button>
        <button class="quote-action-btn" id="btn-share" title="Partager" aria-label="Partager">${icon('share')}</button>
        <button class="quote-action-btn" id="btn-next" title="Suivante" aria-label="Suivante">${icon('next')}</button>
      </div>
      <div class="quote-hint">${inOrder ? 'Glisser ou toucher pour la suivante' : 'Glisser ou toucher pour une autre réplique'}</div>
    </div>`;

  loadAvatars();
  document.getElementById('btn-prev').addEventListener('click', () => prevQuote());
  document.getElementById('btn-next').addEventListener('click', () => nextQuote());
  document.getElementById('btn-random').addEventListener('click', () => randomQuote());
  document.getElementById('btn-fav').addEventListener('click', () => {
    toggleFav(currentQuote);
    document.getElementById('btn-fav').classList.toggle('active', isFav(currentQuote));
  });
  document.getElementById('btn-share').addEventListener('click', () => shareQuote(q));

  document.getElementById('chip-verify').addEventListener('click', () => {
    verifyMode = !verifyMode;
    writePref('kaam_verify', verifyMode);
    rebuildVerify();
    const P = pool();
    if (verifyMode && P.length && !P.includes(quoteIdx)) randomQuote(); else renderCitations();
  });
  if (reviewable) bindAvis(q);

  // Texte / Son / Vidéo : un seul à la fois ; retoucher le choix actif revient à « Texte »
  const setMedia = m => {
    if ((m === 'audio' && audioOnly) || (m === 'video' && videoOnly)) m = 'text';
    audioOnly = m === 'audio'; videoOnly = m === 'video';
    writePref('kaam_audio_only', audioOnly); writePref('kaam_video_only', videoOnly);
    const P = pool();
    if (P && P.length && !P.includes(quoteIdx)) randomQuote(); else renderCitations();
  };
  document.getElementById('chip-text').addEventListener('click', () => setMedia('text'));
  const chipVideo = document.getElementById('chip-video-only');
  if (chipVideo) chipVideo.addEventListener('click', () => setMedia('video'));
  document.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => {
    source = b.dataset.src;
    try { localStorage.setItem('kaam_source', source); } catch {}
    nextRand = null;
    const P = pool();
    if (P && P.length && !P.includes(quoteIdx)) randomQuote(); else renderCitations();
  }));
  const slot = document.getElementById('qvideo-slot');
  if (slot) playCardVideo(q, slot);
  else cardVideo.pause();
  prefetchAround();
  const btnVideo = document.getElementById('btn-video');
  if (btnVideo) btnVideo.addEventListener('click', e => { e.stopPropagation(); showVideo(q); });
  document.getElementById('chip-audio-only').addEventListener('click', () => setMedia('audio'));
  document.getElementById('chip-order').addEventListener('click', () => {
    inOrder = !inOrder;
    writePref('kaam_in_order', inOrder);
    renderCitations();
  });
  document.getElementById('chip-autoplay').addEventListener('click', e => {
    autoPlay = !autoPlay;
    writePref('kaam_autoplay', autoPlay);
    e.currentTarget.classList.toggle('on', autoPlay);
    if (autoPlay && q.audio) playAudio(q.audio, document.getElementById('btn-audio'));
  });
  const audioBtn = document.getElementById('btn-audio');
  if (audioBtn) {
    audioBtn.addEventListener('click', e => { e.stopPropagation(); playAudio(q.audio, audioBtn); });
    audioBtn.addEventListener('touchend', e => e.stopPropagation());
    // Lecture auto : renderCitations est appelé dans le geste (tap/swipe/bouton), donc le navigateur l'autorise
    if (autoPlay) playAudio(q.audio, audioBtn);
  }

  const card = document.getElementById('quote-card');
  card.addEventListener('click', () => swipeForward());

  // Swipe — bloque le scroll vertical pendant un geste horizontal
  let sx = 0, sy = 0, swiping = false;
  card.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });
  card.addEventListener('touchmove', e => {
    const dx = Math.abs(e.touches[0].clientX - sx);
    const dy = Math.abs(e.touches[0].clientY - sy);
    if (dx > dy && dx > 8) {
      swiping = true;
      e.preventDefault(); // bloque le scroll de la page
    }
  }, { passive: false });
  card.addEventListener('touchend', e => {
    const dx = sx - e.changedTouches[0].clientX;
    const dy = Math.abs(sy - e.changedTouches[0].clientY);
    if (Math.abs(dx) > 50 && Math.abs(dx) > dy) {
      if (dx > 0) swipeForward(); else swipeBack();
    }
    swiping = false;
  }, { passive: true });
}

// ===== AVIS DE VÉRIFICATION =====
const PROBLEMES = [
  ['son_faux', 'Son : mauvaise réplique', 'audio'],
  ['son_coupe', 'Son : coupé / incomplet', 'audio'],
  ['son_deborde', 'Son : déborde sur les voisines', 'audio'],
  ['video_fausse', 'Vidéo : mauvaise scène', 'video'],
  ['video_coupee', 'Vidéo : coupée / décalée', 'video'],
  ['texte_faux', 'Texte ou personnage faux', ''],
];
function avisHTML(q) {
  const what = q.audio && q.video ? 'Son et vidéo OK' : q.video ? 'Vidéo OK' : 'Son OK';
  return `<div class="avis">
    <div class="avis-bar">
      <button class="avis-btn avis-ok" id="avis-ok">✓ ${what}</button>
      <button class="avis-btn avis-ko" id="avis-ko">✗ Problème</button>
    </div>
    <div class="avis-form hidden" id="avis-form">
      <div class="avis-choix">
        ${PROBLEMES.filter(([, , k]) => !k || q[k]).map(([id, label]) =>
          `<button class="audio-chip" data-pb="${id}">${label}</button>`).join('')}
      </div>
      <input class="avis-note" id="avis-note" maxlength="500" placeholder="Précision (facultatif)">
      <button class="avis-btn avis-send" id="avis-send" disabled>Envoyer</button>
    </div>
  </div>`;
}
function bindAvis(q) {
  const form = document.getElementById('avis-form');
  const send = document.getElementById('avis-send');
  const picked = new Set();
  document.getElementById('avis-ok').addEventListener('click', () => recordAvis(q, true, [], ''));
  document.getElementById('avis-ko').addEventListener('click', e => {
    form.classList.toggle('hidden');
    e.currentTarget.classList.toggle('on', !form.classList.contains('hidden'));
  });
  form.querySelectorAll('[data-pb]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.pb;
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    b.classList.toggle('on', picked.has(id));
    send.disabled = !picked.size && !document.getElementById('avis-note').value.trim();
  }));
  document.getElementById('avis-note').addEventListener('input', e => {
    send.disabled = !picked.size && !e.target.value.trim();
  });
  send.addEventListener('click', () => recordAvis(q, false, [...picked], document.getElementById('avis-note').value.trim()));
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

// Pas suivant/précédent : dans toutes les répliques, ou seulement celles avec son
function stepQuote(dir) {
  const P = pool();
  if (P) {
    const pos = P.indexOf(quoteIdx);
    const next = pos === -1
      ? (dir > 0 ? P.find(i => i > quoteIdx) ?? P[0] : [...P].reverse().find(i => i < quoteIdx) ?? P[P.length - 1])
      : P[(pos + dir + P.length) % P.length];
    quoteIdx = next;
  } else {
    quoteIdx = (quoteIdx + dir + allQuotes.length) % allQuotes.length;
  }
  renderCitations();
}
function nextQuote() { stepQuote(1); }
function prevQuote() { stepQuote(-1); }
function randomQuote() {
  // Coupe l'historique si on était en arrière
  if (randPos < randHistory.length - 1) {
    randHistory = randHistory.slice(0, randPos + 1);
  }
  const P = pool();
  quoteIdx = nextRand !== null && (!P || P.includes(nextRand)) && nextRand !== quoteIdx ? nextRand : pickRandom();
  nextRand = null;
  randHistory.push(quoteIdx);
  randPos = randHistory.length - 1;
  renderCitations();
}
// Swipe / tap : selon le mode choisi, réplique suivante dans l'ordre ou aléatoire (avec historique)
function swipeForward() { if (inOrder) stepQuote(1); else historyForward(); }
function swipeBack()    { if (inOrder) stepQuote(-1); else historyBack(); }

function historyBack() {
  if (randPos > 0) {
    randPos--;
    quoteIdx = randHistory[randPos];
    renderCitations();
  }
}
function historyForward() {
  if (randPos < randHistory.length - 1) {
    // Il reste des citations dans l'historique → on y retourne
    randPos++;
    quoteIdx = randHistory[randPos];
    renderCitations();
  } else {
    // On est au bout → nouvelle citation aléatoire
    randomQuote();
  }
}
async function shareQuote(q) {
  const text = `"${q.quote}" — ${q.name}${fmtEp(q) ? '\n' + fmtEp(q) : ''}\n\nKaamelott`;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch {}
  } else {
    await navigator.clipboard.writeText(text).catch(() => {});
    alert('Réplique copiée !');
  }
}

// ===== QUIZ =====
const TOP_CHARS = [
  'ARTHUR','PERCEVAL','LÉODAGAN','LANCELOT','GUENIÈVRE',
  'KARADOC','BOHORT','SÉLI','MERLIN','PÈRE BLAISE',
  'DEMETRA','LE TAVERNIER','GUETHENOC','YVAIN','YGERNE',
  'LE RÉPURGATEUR','CALOGRENANT','ATTILA','VENEC','GALESSIN',
];

function initQuiz() {
  quizState = { correct: 0, total: 0, streak: 0, best: 0, answered: false };
}

function renderQuiz() {
  if (!quizState) initQuiz();
  const main = document.getElementById('main-content');

  const q = rand(allQuotes.filter(x => TOP_CHARS.includes(x.name)));
  quizState.current = q;
  quizState.answered = false;

  // 3 wrong answers from TOP_CHARS, excluding correct
  const pool = TOP_CHARS.filter(c => c !== q.name);
  const wrong = [];
  while (wrong.length < 3) {
    const pick = rand(pool);
    if (!wrong.includes(pick)) wrong.push(pick);
  }
  const choices = [q.name, ...wrong].sort(() => Math.random() - .5);
  quizState.choices = choices;

  const ep = fmtEp(q);

  main.innerHTML = `
    <div class="quiz-view">
      <div class="quiz-header">
        <div class="quiz-score">Score : <strong>${quizState.correct}/${quizState.total}</strong></div>
        <div class="quiz-streak">Série : <strong>${quizState.streak}</strong></div>
      </div>

      <div class="quiz-question">
        <div class="quiz-label">Qui a dit cette réplique ?</div>
        <div class="quiz-quote">"${esc(q.quote)}"</div>
      </div>

      <div class="quiz-choices">
        ${choices.map(c => `
          <button class="quiz-choice" data-choice="${esc(c)}">
            <div class="quiz-choice-avatar" data-name="${esc(c)}" data-livre="${esc(q.livre)}">${esc(c.charAt(0))}</div>
            <span>${esc(c)}</span>
          </button>
        `).join('')}
      </div>

      <div class="quiz-feedback" id="quiz-feedback"></div>
      <button class="quiz-next-btn hidden" id="quiz-next">Réplique suivante →</button>
    </div>`;

  loadAvatars();
  document.querySelectorAll('.quiz-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      if (quizState.answered) return;
      quizState.answered = true;
      quizState.total++;
      const chosen = btn.dataset.choice;
      const correct = chosen === q.name;

      if (correct) {
        quizState.correct++;
        quizState.streak++;
        if (quizState.streak > quizState.best) quizState.best = quizState.streak;
      } else {
        quizState.streak = 0;
      }

      document.querySelectorAll('.quiz-choice').forEach(b => {
        b.disabled = true;
        if (b.dataset.choice === q.name) b.classList.add('correct');
        else if (b === btn && !correct) b.classList.add('wrong');
      });

      const fb = document.getElementById('quiz-feedback');
      if (correct) {
        fb.className = 'quiz-feedback correct';
        fb.textContent = ['Bien joué !', 'C\'est exact !', 'Parfait !', 'Tu connais bien ta série !'][Math.floor(Math.random()*4)];
      } else {
        fb.className = 'quiz-feedback wrong';
        fb.innerHTML = `Raté ! C'était <strong>${esc(q.name)}</strong>${ep ? `<br><em>${esc(ep)}</em>` : ''}`;
      }

      document.getElementById('quiz-next').classList.remove('hidden');
      document.getElementById('quiz-next').addEventListener('click', () => renderQuiz());
    });
  });
}

// ===== PERSONNAGES =====
function renderPersonnages() {
  const main = document.getElementById('main-content');
  const chars = getCharList();

  main.innerHTML = `
    <div class="personnages-view">
      <div class="section-header">
        <span class="section-title">${chars.length} personnages</span>
        <span class="section-line"></span>
      </div>
      <div class="perso-list">
        ${chars.map(([name, count]) => `
          <div class="perso-row" data-char="${esc(name)}">
            <div class="perso-avatar" data-name="${esc(name)}">${esc(name.charAt(0))}</div>
            <div class="perso-info">
              <div class="perso-name">${esc(name)}</div>
              <div class="perso-count">${count} réplique${count > 1 ? 's' : ''}</div>
            </div>
            <div class="perso-arrow">›</div>
          </div>`).join('')}
      </div>
    </div>`;

  main.querySelectorAll('.perso-row').forEach(row => {
    row.addEventListener('click', () => openPersonnage(row.dataset.char));
  });
  loadAvatars();
}

function openPersonnage(name) {
  detailChar = name;
  const quotes = allQuotes.filter(q => q.name === name);
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.remove('hidden');
  overlay.scrollTop = 0;

  overlay.innerHTML = `
    <div class="detail-header">
      <button class="detail-back" id="detail-back">&#8592;</button>
      <div class="perso-avatar detail-avatar" data-name="${esc(name)}" data-livre="${esc(quotes[0]?.livre||'')}">${esc(name.charAt(0))}</div>
      <span class="detail-header-title">${esc(name)}</span>
      <span class="detail-count">${quotes.length} répliques</span>
    </div>
    <div class="perso-quotes-list">
      ${quotes.map((q, i) => `
        <div class="perso-quote-item" data-idx="${i}">
          <button class="perso-quote-fav ${isFav(q) ? 'active' : ''}" data-idx="${i}" aria-label="Favori">${icon('heart')}</button>
          <div class="perso-quote-text">"${esc(q.quote)}"</div>
          ${q.audio ? `<button class="audio-mini" data-idx="${i}" aria-label="Écouter">${icon('play')}</button>` : ''}
          ${fmtEp(q) ? `<div class="perso-quote-ep">${esc(fmtEp(q))}</div>` : ''}
        </div>`).join('')}
    </div>`;

  loadAvatars();
  document.getElementById('detail-back').addEventListener('click', () => {
    stopAudio();
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  });

  overlay.querySelectorAll('.audio-mini').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); playAudio(quotes[parseInt(btn.dataset.idx)].audio, btn); });
  });
  overlay.querySelectorAll('.perso-quote-fav').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const q = quotes[parseInt(btn.dataset.idx)];
      toggleFav(q);
      btn.classList.toggle('active', isFav(q));
    });
  });
}

// ===== RECHERCHE =====
let searchTimeout = null;

function renderRecherche() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="recherche-view">
      <div class="search-wrap">
        <input type="search" class="search-input" id="search-input"
          placeholder="Chercher une réplique, un personnage…"
          autocomplete="off" autocorrect="off" spellcheck="false">
        <span class="search-icon">${icon('search')}</span>
      </div>
      <div id="search-results">
        <div class="search-hint">Cherchez parmi les ${allQuotes.length.toLocaleString('fr-FR')} répliques</div>
      </div>
    </div>`;

  const input   = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = input.value.trim();
    if (q.length < 2) {
      results.innerHTML = `<div class="search-hint">Cherchez parmi les ${allQuotes.length.toLocaleString('fr-FR')} répliques</div>`;
      return;
    }
    searchTimeout = setTimeout(() => doSearch(q, results), 200);
  });
  input.focus();
}

function doSearch(query, container) {
  const q = query.toLowerCase();
  const hits = allQuotes.filter(x =>
    x.quote.toLowerCase().includes(q) ||
    x.name.toLowerCase().includes(q) ||
    x.title.toLowerCase().includes(q)
  ).slice(0, 60);

  if (!hits.length) {
    container.innerHTML = `<div class="search-hint">Aucun résultat pour « ${esc(query)} »</div>`;
    return;
  }

  container.innerHTML = `
    <div class="search-count">${hits.length}${hits.length === 60 ? '+' : ''} résultat${hits.length > 1 ? 's' : ''}</div>
    ${hits.map((x, i) => `
      <div class="search-result" data-idx="${i}">
        <div class="search-result-char">${esc(x.name)}${x.audio ? ` <span class="has-audio" title="Avec son">${icon('volume')}</span>` : ''}</div>
        <div class="search-result-quote">${highlight(x.quote, query)}</div>
        ${fmtEp(x) ? `<div class="search-result-meta">${esc(fmtEp(x))}</div>` : ''}
      </div>`).join('')}`;

  container.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      const q = hits[parseInt(el.dataset.idx)];
      showQuoteModal(q);
    });
  });
}

// ===== FAVORIS =====
function renderFavoris() {
  const main = document.getElementById('main-content');
  if (!favorites.length) {
    main.innerHTML = `
      <div class="favoris-view">
        <div class="section-header">
          <span class="section-title">Favoris</span>
          <span class="section-line"></span>
        </div>
        <div class="favoris-empty">
          <div class="icon">${icon('heart')}</div>
          <p>Aucune réplique enregistrée.<br>Touchez le cœur sous une citation pour la garder ici.</p>
        </div>
      </div>`;
    return;
  }

  main.innerHTML = `
    <div class="favoris-view">
      <div class="section-header">
        <span class="section-title">${favorites.length} favori${favorites.length > 1 ? 's' : ''}</span>
        <span class="section-line"></span>
      </div>
      ${favorites.map((q, i) => `
        <div class="fav-item" data-idx="${i}">
          <div class="fav-item-body">
            <div class="fav-item-char">${esc(q.name)}${audioOf(q) ? ` <span class="has-audio" title="Avec son">${icon('volume')}</span>` : ''}</div>
            <div class="fav-item-quote">"${esc(q.quote)}"</div>
            ${fmtEp(q) ? `<div class="fav-item-meta">${esc(fmtEp(q))}</div>` : ''}
          </div>
          <button class="fav-remove" data-idx="${i}" title="Retirer">✕</button>
        </div>`).join('')}
    </div>`;

  main.querySelectorAll('.fav-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const q = favorites[parseInt(btn.dataset.idx)];
      toggleFav(q);
      renderFavoris();
    });
  });
  main.querySelectorAll('.fav-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.fav-remove')) return;
      showQuoteModal(favorites[parseInt(el.dataset.idx)]);
    });
  });
}

// Lecteur sans commandes : toucher la vidéo la rejoue depuis le début, son activé
function replayVideo(v) {
  v.muted = false; v.currentTime = 0;
  v.play().catch(() => {});
}

// ===== VIDÉO EN PLEIN ÉCRAN (bouton « Voir la scène ») =====
function showVideo(q) {
  stopAudio();
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.remove('hidden'); overlay.scrollTop = 0;
  overlay.innerHTML = `
    <div class="detail-header">
      <button class="detail-back" id="detail-back">&#8592;</button>
      <span class="detail-header-title">${esc(q.name)}</span>
    </div>
    <div class="video-modal">
      <video class="quote-video" id="mvideo" src="${mediaSrc(videoURL(q))}" playsinline autoplay></video>
      <div class="quote-text quote-text-small">"${esc(q.quote)}"</div>
      ${fmtEp(q) ? `<div class="quote-char-ep">${esc(fmtEp(q))}</div>` : ''}
    </div>`;
  const v = document.getElementById('mvideo');
  v.muted = false;
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  v.addEventListener('click', () => replayVideo(v));
  document.getElementById('detail-back').addEventListener('click', () => {
    v.pause(); overlay.classList.add('hidden'); overlay.innerHTML = '';
  });
}

// ===== QUOTE MODAL (from search/fav) =====
function showQuoteModal(q) {
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.remove('hidden');
  overlay.scrollTop = 0;
  const ep = fmtEp(q);
  const audio = audioOf(q);

  overlay.innerHTML = `
    <div class="detail-header">
      <button class="detail-back" id="detail-back">&#8592;</button>
      <div class="perso-avatar detail-avatar" data-name="${esc(q.name)}" data-livre="${esc(q.livre||'')}">${esc(q.name.charAt(0))}</div>
      <span class="detail-header-title">${esc(q.name)}</span>
      <button class="perso-quote-fav ${isFav(q) ? 'active' : ''}" id="modal-fav" style="background:none;border:none;font-size:22px;cursor:pointer;padding:4px;">${icon('heart')}</button>
    </div>
    <div style="padding:32px 24px;">
      <div style="font-family:Georgia,serif;font-size:22px;line-height:1.7;color:var(--text);font-style:italic;text-align:center;margin-bottom:24px;">
        "${esc(q.quote)}"
      </div>
      <div style="text-align:center;">
        <div style="font-size:14px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--gold);margin-bottom:6px;">${esc(q.name)}</div>
        ${ep ? `<div style="font-size:12px;color:var(--text3);font-style:italic;">${esc(ep)}</div>` : ''}
      </div>
      ${audio ? `<div class="quote-audio">${audioBtnHTML('modal-audio', true)}</div>` : ''}
      <div style="margin-top:32px;display:flex;gap:12px;justify-content:center;">
        <button id="modal-share" style="background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:12px 24px;border-radius:4px;font-size:13px;cursor:pointer;">Partager</button>
        <button id="modal-perso" style="background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:12px 24px;border-radius:4px;font-size:13px;cursor:pointer;">👑 ${esc(q.name)}</button>
      </div>
    </div>`;

  loadAvatars();
  document.getElementById('detail-back').addEventListener('click', () => {
    stopAudio();
    overlay.classList.add('hidden'); overlay.innerHTML = '';
  });
  const modalAudio = document.getElementById('modal-audio');
  if (modalAudio) modalAudio.addEventListener('click', () => playAudio(audio, modalAudio));
  document.getElementById('modal-fav').addEventListener('click', () => {
    toggleFav(q);
    document.getElementById('modal-fav').classList.toggle('active', isFav(q));
    if (currentView === 'favoris') renderFavoris();
  });
  document.getElementById('modal-share').addEventListener('click', () => shareQuote(q));
  document.getElementById('modal-perso').addEventListener('click', () => {
    overlay.classList.add('hidden'); overlay.innerHTML = '';
    openPersonnage(q.name);
  });
}

// ===== NAV =====
function bindNav() {
  document.getElementById('bottom-nav').querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view !== currentView) setView(btn.dataset.view);
    });
  });
}
function setView(view) {
  stopAudio();
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if      (view === 'citations')   renderCitations();
  else if (view === 'quiz')        renderQuiz();
  else if (view === 'personnages') renderPersonnages();
  else if (view === 'recherche')   renderRecherche();
  else if (view === 'favoris')     renderFavoris();
}

// ===== SW =====
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});

  // Rechargement automatique quand le SW signale une nouvelle version
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'SW_UPDATED') {
      window.location.reload();
    }
  });
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  loadFavorites();
  registerSW();
  try {
    await loadData();
    // Démarrer sur une citation aléatoire et initialiser l'historique
    quoteIdx = pool() ? rand(pool()) : Math.floor(Math.random() * allQuotes.length);
    randHistory = [quoteIdx];
    randPos = 0;
    renderCitations();
    bindNav();
    sendAvis();
  } catch (e) {
    document.getElementById('main-content').innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text3);">
        <p>Impossible de charger les répliques pour le moment.</p>
        <button onclick="location.reload()" style="margin-top:16px;background:var(--bg3);border:1px solid var(--border2);color:var(--text);padding:10px 20px;border-radius:999px;font:500 14px var(--font-sans);cursor:pointer;">Réessayer</button>
      </div>`;
  }
});
