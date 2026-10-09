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
function audioURL(src) {
  const m = /^sons\/auto\/(.+\.m4a)$/.exec(src || '');
  return m ? `${AUDIO_BASE}${m[1].slice(0, 2)}/${m[1]}` : src;
}
function videoURL(q) { return q.video ? `${VIDEO_BASE}${q.video.slice(0, 2)}/${q.video}.mp4` : null; }
// Répliques parcourues (aléatoire / ordre) selon les filtres actifs
function pool() {
  if (verifyMode) return verifyIdx;
  if (videoOnly && videoIdx.length) return videoIdx;
  if (audioOnly && audioIdx.length) return audioIdx;
  return null;
}
// ===== VÉRIFICATION (avis son / vidéo justes ou non, envoyés à /api/avis) =====
let verifyMode = readPref('kaam_verify');      // ne montrer que les répliques avec son/vidéo pas encore vérifiées
let verifyIdx = [];
let avisFaits = readJSON('kaam_avis_faits', {});   // index de réplique → 1 (déjà vérifiée sur cet appareil)
let avisFile  = readJSON('kaam_avis_file', []);    // avis pas encore envoyés
function readJSON(k, def) { try { return JSON.parse(localStorage.getItem(k)) || def; } catch { return def; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function rebuildVerify() {
  verifyIdx = allQuotes.reduce((acc, q, i) => ((q.audio || q.video) && !avisFaits[q.i] && acc.push(i), acc), []);
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
  document.querySelectorAll('video').forEach(v => v.pause());
  setPlayingBtn(null);
}
function playAudio(src, btn) {
  if (!src) return;
  // Re-tap sur le bouton en cours de lecture = stop
  if (btn && btn === playingBtn && !player.paused) { stopAudio(); return; }
  player.src = audioURL(src);
  player.currentTime = 0;
  setPlayingBtn(btn || null);
  player.play().catch(() => setPlayingBtn(null));
}
player.addEventListener('ended', () => setPlayingBtn(null));

function audioBtnHTML(id, big, approx) {
  // approx : son placé par l'écart entre les répliques voisines (peut déborder un peu sur elles)
  return `<button class="audio-btn${big ? ' audio-btn-big' : ''}" id="${id}" aria-label="Écouter la réplique"${approx ? ' title="Son estimé : peut déborder un peu sur les répliques voisines"' : ''}>
    <span class="audio-icon-play">▶</span><span class="audio-icon-stop">■</span>
    <span class="audio-label">${approx ? '≈ Écouter' : 'Écouter'}</span>
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
    ? raw.slice(0, commaIdx).trim().toUpperCase()
    : raw.trim().toUpperCase();
  const rest = commaIdx > -1 ? raw.slice(commaIdx + 1) : '';

  const livreM = rest.match(/livre\s+(I{1,3}V?|VI?)/i);
  const epM    = rest.match(/épisode\s+(\d+)\s*(?::\s*(.+))?/i);

  const livre   = livreM ? livreM[1].toUpperCase() : '';
  const episode = epM ? epM[1] : '';
  const title   = epM && epM[2] ? epM[2].trim() : '';
  const film    = /premier volet/i.test(rest) ? 'Kaamelott : Premier Volet' : '';

  return { i, quote: item.quote, name, livre, episode, title, film, audio: item.audio || null, video: item.video || null, approx: !!item.approx };
}

async function loadData() {
  const res  = await fetch('data.json');
  const raw  = await res.json();
  allQuotes  = raw.map(parseQuote).filter(q => q.quote && q.name);
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
    ? `${verifyIdx.length} à vérifier · ${Object.keys(avisFaits).length} vérifiées${avisFile.length ? ` · ${avisFile.length} en attente d'envoi` : ''}`
    : P
    ? `${P.indexOf(quoteIdx) + 1} / ${P.length} répliques ${P === videoIdx ? 'avec vidéo' : 'avec son'}`
    : `${quoteIdx + 1} / ${allQuotes.length}`;
  const inlineVideo = (videoOnly || verifyMode) && q.video;
  const reviewable = verifyMode && (q.audio || q.video);

  main.innerHTML = `
    <div class="citations-view">
      <div class="audio-toggles">
        <button class="audio-chip ${audioOnly ? 'on' : ''}" id="chip-audio-only">🔊 Seulement avec son <span class="chip-count">${audioIdx.length}</span></button>
        <button class="audio-chip ${autoPlay ? 'on' : ''}" id="chip-autoplay">▶ Lecture auto</button>
        ${videoIdx.length ? `<button class="audio-chip ${videoOnly ? 'on' : ''}" id="chip-video-only">🎬 Mode vidéo <span class="chip-count">${videoIdx.length}</span></button>` : ''}
        <button class="audio-chip ${verifyMode ? 'on' : ''}" id="chip-verify">✅ Vérifier <span class="chip-count">${verifyIdx.length}</span></button>
        <button class="audio-chip ${inOrder ? 'on' : ''}" id="chip-order">${inOrder ? '➡️ Dans l\'ordre' : '🔀 Aléatoire'}</button>
      </div>
      <div class="quote-counter">${counter}</div>

      <div class="quote-card" id="quote-card">
        <div class="quote-card-line-top"></div>
        <div class="quote-card-line-bottom"></div>
        ${inlineVideo
          ? `<video class="quote-video" id="qvideo" src="${videoURL(q)}" playsinline preload="auto"></video>
             <div class="quote-text quote-text-small">${esc(q.quote)}</div>`
          : `<div class="quote-mark">"</div>
             <div class="quote-text">${esc(q.quote)}</div>`}
        <div class="quote-char">
          <div class="char-avatar" data-name="${esc(q.name)}" data-livre="${esc(q.livre)}">${esc(q.name.charAt(0))}</div>
          <div class="quote-char-name">${esc(q.name)}</div>
          ${ep ? `<div class="quote-char-ep">${esc(ep)}</div>` : ''}
        </div>
        ${verifyMode && inlineVideo && q.audio ? `<div class="quote-audio">${audioBtnHTML('btn-audio', true, q.approx)}</div>` : ''}
        ${!inlineVideo && (q.audio || q.video) ? `<div class="quote-audio">
          ${q.audio ? audioBtnHTML('btn-audio', true, q.approx) : ''}
          ${q.video ? `<button class="audio-btn audio-btn-big" id="btn-video">🎬 <span class="audio-label">Voir la scène</span></button>` : ''}
        </div>` : ''}
      </div>
      ${reviewable ? avisHTML(q) : ''}

      <div class="quote-actions">
        <button class="quote-action-btn" id="btn-prev" title="Précédente">◀</button>
        <button class="quote-action-btn ${favActive ? 'active' : ''}" id="btn-fav" title="Favoris">❤️</button>
        <button class="quote-action-btn" id="btn-random" title="Aléatoire">🎲</button>
        <button class="quote-action-btn" id="btn-share" title="Partager">📤</button>
        <button class="quote-action-btn" id="btn-next" title="Suivante">▶</button>
      </div>
      <div class="quote-hint">${inOrder ? 'Swipe ← suivante · Swipe → précédente · Tap suivante' : 'Swipe → retour · Swipe ← aléatoire · Tap aléatoire'}</div>
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
    if (verifyMode && !verifyIdx.includes(quoteIdx) && verifyIdx.length) randomQuote(); else renderCitations();
  });
  if (reviewable) bindAvis(q);

  const chipVideo = document.getElementById('chip-video-only');
  if (chipVideo) chipVideo.addEventListener('click', () => {
    videoOnly = !videoOnly;
    writePref('kaam_video_only', videoOnly);
    if (videoOnly && !q.video) randomQuote(); else renderCitations();
  });
  const vid = document.getElementById('qvideo');
  if (vid) {
    // les gestes sur le lecteur ne doivent pas changer de réplique
    ['touchstart', 'touchend'].forEach(ev => vid.addEventListener(ev, e => e.stopPropagation()));
    vid.addEventListener('click', e => { e.stopPropagation(); replayVideo(vid); });   // toucher = rejouer (avec le son)
    vid.play().catch(() => { vid.muted = true; vid.play().catch(() => {}); });   // son coupé si le navigateur l'exige
  }
  const btnVideo = document.getElementById('btn-video');
  if (btnVideo) btnVideo.addEventListener('click', e => { e.stopPropagation(); showVideo(q); });
  document.getElementById('chip-audio-only').addEventListener('click', () => {
    audioOnly = !audioOnly;
    writePref('kaam_audio_only', audioOnly);
    // En passant en « avec son », on saute sur une réplique qui en a un
    if (audioOnly && !q.audio) randomQuote(); else renderCitations();
  });
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
  quoteIdx = pool() ? rand(pool()) : Math.floor(Math.random() * allQuotes.length);
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
        <div class="quiz-streak">🔥 Série : <strong>${quizState.streak}</strong></div>
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
          <button class="perso-quote-fav ${isFav(q) ? 'active' : ''}" data-idx="${i}">❤️</button>
          <div class="perso-quote-text">"${esc(q.quote)}"</div>
          ${q.audio ? `<button class="audio-mini" data-idx="${i}" aria-label="Écouter">▶</button>` : ''}
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
        <span class="search-icon">🔍</span>
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
        <div class="search-result-char">${esc(x.name)}${x.audio ? ' <span class="has-audio">🔊</span>' : ''}</div>
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
          <div class="icon">❤️</div>
          <p>Aucune réplique sauvegardée.<br>Appuyez sur ❤️ dans les citations.</p>
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
            <div class="fav-item-char">${esc(q.name)}${audioOf(q) ? ' <span class="has-audio">🔊</span>' : ''}</div>
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
      <video class="quote-video" id="mvideo" src="${videoURL(q)}" playsinline autoplay></video>
      <div class="quote-text quote-text-small">"${esc(q.quote)}"</div>
      ${fmtEp(q) ? `<div class="quote-char-ep">${esc(fmtEp(q))}</div>` : ''}
    </div>`;
  const v = document.getElementById('mvideo');
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
      <button class="perso-quote-fav ${isFav(q) ? 'active' : ''}" id="modal-fav" style="background:none;border:none;font-size:22px;cursor:pointer;padding:4px;">❤️</button>
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
        <button id="modal-share" style="background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:12px 24px;border-radius:4px;font-size:13px;cursor:pointer;">📤 Partager</button>
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
        <p style="font-family:Georgia,serif;font-style:italic;">Erreur de chargement des données.</p>
      </div>`;
  }
});
