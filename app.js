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
// Préférences (clés localStorage inchangées)
let source = readStr('kaam_source', 'all');     // toute la série (all), seulement la série (serie) ou le film (film)
let audioOnly = readPref('kaam_audio_only');   // n'afficher que les répliques avec son
let videoOnly = readPref('kaam_video_only');   // mode vidéo : seulement ces répliques, scène jouée dans la carte
let autoPlay  = readPref('kaam_autoplay');     // jouer le son dès qu'on tombe sur la réplique
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
let verifyIdx = [];                                 // positions encore à vérifier dans la source choisie
let verifyApprox = false;                           // vrai si ce sont les sons les moins sûrs (passent en premier)
let verifyTodo = { approx: 0, others: 0 };
let avisFaits = readJSON('kaam_avis_faits', {});   // q.i → 1 validée, 2 signalée (sur cet appareil)
let avisFile  = readJSON('kaam_avis_file', []);    // avis pas encore envoyés
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

// ===== SOURCE : toute la série, ou seulement la série, ou seulement le film =====
const poolCache = new Map();
function bySource(arr) {
  if (source === 'all') return arr;
  const key = `${source}|${arr === null ? 'all' : arr === audioIdx ? 'a' : arr === videoIdx ? 'v' : 'x' + arr.length}`;
  if (arr !== verifyIdx && poolCache.has(key)) return poolCache.get(key);
  const base = arr || allQuotes.map((_, i) => i);
  const out = base.filter(i => inSrc(allQuotes[i], source));
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
  if (u) return u;
  if (mediaAbort.has(url)) { mediaAbort.get(url).abort(); mediaCache.delete(url); }
  streamed.add(url);
  if (streamed.size > 50) streamed.delete(streamed.values().next().value);
  return url;
}
// Répliques probables après celle-ci : on précharge leur vidéo (modes vidéo / vérification) et leur son
function prefetchAround() {
  const P = pool();
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
    if ((videoOnly || verifyMode) && q.video) cachedMedia(videoURL(q));
    if (q.audio && (autoPlay || verifyMode || audioOnly)) cachedMedia(audioURL(q.audio));
  });
}
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
    playing: ['num', `${mmss(v.currentTime)} / ${mmss(v.duration)}`],
    ended:   ['ink', '<span aria-hidden="true">↻</span> Revoir'],
    error:   ['red', navigator.onLine === false ? 'Hors ligne · Réessayer' : 'Scène indisponible · Réessayer'],
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
  const url = videoURL(q);
  const src = mediaSrc(url);
  const frame = fig.querySelector('.frame');
  frame.prepend(cardVideo);
  fig.dataset.src = url;   // « Réessayer » relance ce fichier
  if (offlineMiss(url)) { cardVideo.pause(); cardVideo.removeAttribute('src'); setScene(cardVideo, 'error'); return; }
  if (cardVideo.src !== src) { cardVideo.src = src; setScene(cardVideo, 'loading'); }
  cardVideo.currentTime = 0;
  // son activé par défaut ; si le navigateur refuse (aucun toucher encore), lecture sans son, signalée
  cardVideo.muted = false;
  cardVideo.play().catch(e => {
    if (e.name !== 'NotAllowedError') return;            // lecture interrompue par la réplique suivante : rien à faire
    if (playingBtn) return;                              // refus arrivé après « Écouter » : la scène ne repart pas sous le son
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
// lecture validée : une valeur abîmée (autre type que la valeur par défaut) est ignorée en mémoire, jamais réécrite
function readJSON(k, def) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' && Array.isArray(v) === Array.isArray(def) ? v : def; }
  catch { return def; }
}
// vrai si l'écriture a réussi (stockage plein ou refusé : faux, l'appelant le dit)
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
// Les sons estimés (≈), les moins sûrs, passent en premier ; les autres ensuite
function rebuildVerify() {
  // dans la source choisie (Tout / Série / Film)
  const todo = allQuotes.reduce((acc, q, i) => ((q.audio || q.video) && !avisFaits[q.i]
    && inSrc(q, source) && acc.push(i), acc), []);
  const approx = todo.filter(i => allQuotes[i].approx);
  verifyApprox = approx.length > 0;
  verifyIdx = verifyApprox ? approx : todo;
  verifyTodo = { approx: approx.length, others: todo.length - approx.length };
}
const player = new Audio();   // un seul lecteur de son pour toute l'app
player.preload = 'auto';

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
  if (r && player.duration) r.style.setProperty('--p', Math.min(1, player.currentTime / player.duration).toFixed(3));
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
  const url = audioURL(src);
  if (offlineMiss(url)) { player.pause(); setPlayingBtn(btn || null); audioFailed('Hors ligne'); return; }
  // jamais deux sons à la fois : la scène (carte ou fenêtre) s'arrête
  cardVideo.pause();
  document.getElementById('mvideo')?.pause();
  switching = true;
  player.src = mediaSrc(url);
  player.currentTime = 0;
  audioQ = q || null;
  setPlayingBtn(btn || null);
  clearTimeout(audioGuard);
  audioGuard = setTimeout(() => { if (playingBtn?.classList.contains('wait')) { player.pause(); audioFailed(); } }, 10000);
  player.play().catch(e => { if (e.name !== 'AbortError') audioFailed(); });
  switching = false;
  renderMini();
}
player.addEventListener('playing', () => { clearTimeout(audioGuard); playingBtn?.classList.remove('wait'); tickAudio(); tickScrub(); renderMini(); });
player.addEventListener('ended', () => { setPlayingBtn(null); tickScrub(); renderMini(); });
player.addEventListener('pause', () => { if (!switching && !player.ended && playingBtn && !playingBtn.classList.contains('wait')) setPlayingBtn(null); renderMini(); });
player.addEventListener('error', () => { if (playingBtn) audioFailed(); });

// ===== BARRE DE LECTURE (écran Répliques) : avancement du son ou de la scène, temps écoulé et restant =====
let scrubRaf = 0;
function tickScrub() {
  cancelAnimationFrame(scrubRaf);
  const sc = document.getElementById('scrub');
  if (!sc) return;
  const q = allQuotes[quoteIdx];
  const inline = cardVideo.closest('#qvideo-slot');
  const m = playingBtn?.id === 'btn-audio' || (audioQ && q && audioQ.i === q.i && !inline) ? player : inline ? cardVideo : null;
  const d = m ? m.duration : NaN, t = m ? m.currentTime || 0 : 0;
  sc.style.setProperty('--p', (isFinite(d) && d > 0 ? Math.min(100, t / d * 100) : 0).toFixed(2) + '%');
  sc.classList.toggle('on', !!m && t > 0);
  const [a, , b] = sc.querySelectorAll('.times > span');
  if (sc.classList.contains('none')) { a.textContent = ''; b.textContent = ''; }
  else { a.textContent = mmss(t); b.textContent = isFinite(d) && d > 0 ? '−' + mmss(Math.max(0, d - t)) : '--:--'; }
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
  const show = !!q && !!player.src && (currentView !== 'citations' || ov);
  if (el.hidden !== !show) el.hidden = !show;
  if (!show) { el.dataset.k = ''; return; }
  const on = !player.paused && !player.ended;
  const k = `${q.i}|${on}`;
  if (el.dataset.k === k) return;
  el.dataset.k = k;
  const sub = [nameCase(q.name), epLabel(q)].filter(Boolean).join(' · ');
  el.innerHTML = `<button class="mini-open" id="mini-open" aria-label="Ouvrir la réplique : ${esc(nameCase(q.name))}"><span class="tile" style="--c:${colorOf(q.name)}" aria-hidden="true">${initial(q.name)}</span>
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
      else { if (player.ended) player.currentTime = 0; cardVideo.pause(); player.play().catch(() => {}); }
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
  // scénarios inédits jamais tournés (« Inédit 3 : Dolor ») : affichés comme tels, jamais de son
  const inedM  = rest.match(/Inédit\s+(\d)\s*:\s*(.+)/i);
  c = {
    name: NAME_FIX[n0] || n0,
    livre: livreM ? livreM[1].toUpperCase() : '',
    episode: epM ? epM[1] : '',
    title: epM && epM[2] ? epM[2].trim() : '',
    film: /premier volet/i.test(rest) ? 'Kaamelott : Premier Volet' : '',
    inedTxt: inedM ? `Inédit ${inedM[1]} : ${inedM[2].trim()}` : 'Inédit',
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
    inedit: item.inedit ? c.inedTxt : '', hide: !!item.hide,
    audio: item.audio ? item.audio + (item.v ? `?v=${item.v}` : '') : null, video: item.video || null, vv: item.vv || 0, approx: !!item.approx };
}

const DATA_BYTES = 7000000;   // taille approximative de data.json (le serveur l'envoie compressé, sans longueur)
function bootProgress(got, total) {
  const rail = document.querySelector('.boot .rail');
  if (!rail) return;
  const pc = Math.min(99, Math.round(got / total * 100));
  rail.classList.remove('indet');
  rail.style.setProperty('--p', pc + '%');
  const m = document.querySelector('.boot .m');
  if (m) m.innerHTML = `<span>${(got / 1e6).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mo sur ${(Math.max(got, total) / 1e6).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mo</span><span>${pc} %</span>`;
}
async function loadData() {
  // jusqu'à 3 essais : le premier peut tomber sur la page de contrôle anti-robot de Vercel (403), qui se lève seule
  let raw = null, detail = '';
  for (let essai = 0; essai < 3 && !raw; essai++) {
    if (essai) await new Promise(r => setTimeout(r, 2500));
    try {
      const res = await fetch('data.json', { cache: essai ? 'reload' : 'default' });
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
  if (saveFavorites()) return true;
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

// ===== UTILS =====
// Échappement HTML de tout gabarit : accepte aussi les nombres (0 compris), apostrophe comprise
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, c => ESC[c]); }
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
// Pictogramme du jeu de symboles d'index.html (à la manière des SF Symbols)
const icon = (id, cls = '') => `<svg viewBox="0 0 28 28"${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${id}"/></svg>`;

// ===== COULEURS : chaque personnage a son aplat (toujours lisible en blanc, clair comme sombre), chaque Livre sa pochette =====
const PAL = ['#3b5b92', '#b4532a', '#2f7a6b', '#6a4c9c', '#8c6a2f', '#a8325e', '#2d6f9e', '#4f6b3a', '#5b5f97', '#7a4b3a'];
const FIXED = { 'ARTHUR': '#3b5b92', 'PERCEVAL': '#b4532a', 'KARADOC': '#8c6a2f', 'LÉODAGAN': '#7a4b3a', 'LANCELOT': '#2d6f9e',
  'GUENIÈVRE': '#a8325e', 'MERLIN': '#4f6b3a', 'BOHORT': '#6a4c9c', 'SÉLI': '#5b5f97', 'PÈRE BLAISE': '#2f7a6b' };
function colorOf(name) {
  if (FIXED[name]) return FIXED[name];
  let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PAL[h % PAL.length];
}
// Initiale du rond d'un personnage, sans l'article (« La Dame du Lac » → D)
function initial(n) { const s = nameCase(n || '').replace(/^(Le|La|Les)\s+|^L[’']\s*/, ''); return (s.match(/\p{L}/u) || ['?'])[0].toUpperCase(); }
const LCOL = { I: '#3b5b92', II: '#2f7a6b', III: '#b4532a', IV: '#6a4c9c', V: '#a8325e', VI: '#4a4a4f', Film: '#8c6a2f', Inédits: '#5b5f97' };
const livreNom = L => /^[IV]+$/.test(L) ? `Livre ${L}` : L === 'Film' ? 'Premier Volet' : L;

// ===== MISE EN FORME =====
const nf = n => n.toLocaleString('fr-FR');
const plural = (n, w, ws = w + 's') => `${nf(n)} ${n > 1 ? ws : w}`;   // « 1 réplique », « 2 537 répliques »
const SEP = '<span class="sep" aria-hidden="true">·</span>';          // séparateur des lignes de résumé
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
// noms propres des titres qui ne sont pas des personnages (lieux, objets, figures) ; les adjectifs (« romain ») restent en minuscule
const PROPRES = ['graal', 'aquitaine', 'tintagel', 'cornouailles', 'dieu', 'sainte', 'croix', 'silbury', 'hill', 'euripide', 'alexandre', 'gauvain', 'dagonet', 'caius', 'sloubi'];
function knownNames() {
  if (!KNOWN && allQuotes.length) KNOWN = new Set(getCharList().map(([n]) => n).filter(n => !/[\s’']/.test(n) && n.length > 2 && n !== 'TOUS').map(fold).concat(PROPRES));
  return KNOWN || new Set(PROPRES);
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
function typo(s) { return typoHTML(esc(s == null ? '' : String(s).replace(/'/g, '’'))); }   // apostrophe courbe avant l'échappement
function quoteHTML(s) { return `<span class="g" aria-hidden="true">«</span> ${typo(s)} <span class="g" aria-hidden="true">»</span>`; }
// Source d'une réplique, prête à insérer en HTML (typographie appliquée)
function epHTML(q) { return typo(fmtEp(q)); }
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
// Sous-titre de l'en-tête ; hors ligne, il le dit (sans bandeau ni fenêtre)
function setMast(t) {
  const el = document.getElementById('mast-sub');
  if (!el) return;
  el.dataset.t = t;
  el.innerHTML = `<span class="mt">${esc(t)}</span>` + (navigator.onLine === false ? ' <span class="off">Hors ligne</span>' : '');
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
  if (!main.querySelector('#quiz-stage.answered')) main.classList.remove('qpage');
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
const MAST = { quiz: 'Quiz', personnages: 'Personnages', recherche: 'Chercher', favoris: 'Favoris' };
function mastFor(view) { return view === 'citations' ? (verifyMode ? 'Vérification' : 'Répliques') : MAST[view]; }
function refreshMast() { const el = document.getElementById('mast-sub'); if (el) setMast(el.dataset.t || el.textContent); }
// bouton rond Réglages de l'en-tête : sur l'écran Répliques seulement
function showMastSet() { const b = document.getElementById('mast-set'); if (b) b.hidden = !(currentView === 'citations' && allQuotes.length && document.getElementById('detail-overlay').classList.contains('hidden')); }
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
  sheet.innerHTML = html;
  sheet.hidden = false; back.hidden = false;
  back.onclick = closeSheet;
  sheet.setAttribute('aria-labelledby', 'sh-title');
  document.getElementById('app').inert = true;
  const h = sheet.querySelector('h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  bindSheetGestures(sheet);
  return sheet;
}
function closeSheet() {
  const sheet = document.getElementById('sheet');
  if (sheet.hidden) return;
  sheet.hidden = true;
  document.getElementById('sheet-back').hidden = true;
  sheet.innerHTML = '';
  sheet.style.bottom = ''; sheet.style.maxHeight = '';
  document.getElementById('app').inert = false;
  if (sheetFocus?.isConnected) sheetFocus.focus({ preventScroll: true });
  sheetFocus = null;
}
function sheetOpen() { return !document.getElementById('sheet').hidden; }
// glisser la feuille vers le bas (plus de 80 px) la ferme, depuis n'importe où tant qu'elle n'a pas défilé
let sheetSwipe = false;
function bindSheetGestures(sheet) {
  if (sheetSwipe) return;                         // écouteurs posés une seule fois (la feuille est réutilisée)
  sheetSwipe = true;
  let y0 = null;
  sheet.addEventListener('touchstart', e => { y0 = sheet.scrollTop <= 0 && !e.target.closest('textarea') ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener('touchend', e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 80) closeSheet(); y0 = null; }, { passive: true });
}
// Clavier iOS : la feuille (position fixe en bas) remonte au-dessus du clavier tant qu'il est ouvert
function fitSheetToKeyboard() {
  const sheet = document.getElementById('sheet'), vv = window.visualViewport;
  if (sheet.hidden) return;
  const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  sheet.style.bottom = kb > 40 ? kb + 'px' : '';
  sheet.style.maxHeight = kb > 40 ? (vv.height - 12) + 'px' : '';
}

// ===== RÉGLAGES =====
const SRC_LABEL = { all: 'Tout', serie: 'Série', film: 'Film' };
function inSrc(q, s) { return s === 'all' || !!q.film === (s === 'film'); }   // la réplique appartient-elle à la source s
function mediaMode() { return videoOnly ? 'video' : audioOnly ? 'audio' : 'text'; }
function settingsHTML() {
  const m = mediaMode();
  // contrôle segmenté d'iOS : un bouton par valeur, coché ou non
  const seg = (lab, opts, off) => `<div class="seg" role="radiogroup" aria-label="${lab}"${off ? ' aria-disabled="true"' : ''}>${opts.map(([on, attrs, label]) =>
    `<button role="radio" class="${on ? 'on' : ''}" aria-checked="${on}" ${attrs}${off ? ' disabled' : ''}>${label}</button>`).join('')}</div>`;
  const { approx, others } = verifyTodo;
  const todoTxt = approx + others === 0
    ? 'Tout est vérifié sur ce téléphone pour cette source.'
    : approx
    ? `On commence par ${plural(approx, 'son')} ${approx > 1 ? 'les' : 'le'} moins sûr${approx > 1 ? 's' : ''}.`
    : `Il en reste ${nf(others)}.`;
  const P = verifyMode ? null : pool();
  const n = P ? P.length : allQuotes.length;
  return `
    <div class="grab" aria-hidden="true"></div>
    <div class="sh-nav"><span></span><h2 id="sh-title">Réglages</h2><button class="r" id="sheet-close">OK</button></div>
    <p class="gh">Source</p>
    <div class="g"><div class="gr">${seg('Source', ['all', 'serie', 'film'].map(s => [source === s, `data-src="${s}"`, SRC_LABEL[s]]))}</div></div>
    <p class="gh">Affichage</p>
    <div class="g"><div class="gr${verifyMode ? ' dis' : ''}">${seg('Affichage', [[m === 'text', 'id="chip-text"', 'Texte'], [m === 'audio', 'id="chip-audio-only"', 'Son']]
      .concat(videoIdx.length ? [[m === 'video', 'id="chip-video-only"', 'Vidéo']] : []), verifyMode)}</div></div>
    <p class="gf">Son et Vidéo ne gardent que les répliques qui en ont.</p>
    <p class="gh">Ordre</p>
    <div class="g"><div class="gr${verifyMode ? ' dis' : ''}">${seg('Ordre', [[!inOrder, 'data-order="random"', 'Aléatoire'], [inOrder, 'data-order="seq"', 'Dans l’ordre']], verifyMode)}</div>
      <button class="gr${verifyMode ? ' dis' : ''}" id="sw-auto" role="switch" aria-checked="${autoPlay}" data-auto="${autoPlay ? 0 : 1}"${verifyMode ? ' disabled' : ''}><span class="k">Lecture auto<small>Le son part dès qu’une réplique s’affiche</small></span><span class="sw" aria-hidden="true"></span></button></div>
    <p class="gf" role="status">${verifyMode ? 'Affichage, ordre et lecture auto sont suspendus pendant la vérification.' : `<b>${plural(n, 'réplique')}</b> ${n > 1 ? 'correspondent' : 'correspond'}.`}</p>
    <p class="gh">Contribuer</p>
    <div class="g"><button class="gr act${verifyMode ? ' on' : ''}" id="chip-verify"><span class="k">${verifyMode ? 'Quitter la vérification' : 'Vérifier les sons et les scènes'}</span>${icon('chev', 'chev')}</button></div>
    <p class="gf">Écouter, regarder, signaler ce qui cloche. ${todoTxt}</p>`;
}
function openSettings() {
  const sheet = openSheet(settingsHTML());
  bindSettings(sheet);
}
function refreshAfterSetting(focusSel) {
  const P = pool();
  if (P && P.length && !P.includes(quoteIdx)) randomQuote(); else renderCitations();
  const sheet = document.getElementById('sheet');
  const y = sheet.scrollTop;
  sheet.innerHTML = settingsHTML();
  sheet.scrollTop = y;
  bindSettings(sheet);
  const f = focusSel && sheet.querySelector(focusSel);
  (f || sheet.querySelector('h2'))?.focus({ preventScroll: true });
}
function bindSettings(sheet) {
  sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
  sheet.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => {
    source = b.dataset.src;
    writeStr('kaam_source', source);
    rebuildVerify(); nextRand = null;
    refreshAfterSetting(`[data-src="${source}"]`);
  }));
  const setMedia = m => {
    audioOnly = m === 'audio'; videoOnly = m === 'video';
    writePref('kaam_audio_only', audioOnly); writePref('kaam_video_only', videoOnly);
    nextRand = null;
    refreshAfterSetting({ text: '#chip-text', audio: '#chip-audio-only', video: '#chip-video-only' }[m]);
  };
  sheet.querySelector('#chip-text').addEventListener('click', () => setMedia('text'));
  sheet.querySelector('#chip-audio-only').addEventListener('click', () => setMedia('audio'));
  sheet.querySelector('#chip-video-only')?.addEventListener('click', () => setMedia('video'));
  sheet.querySelectorAll('[data-order]').forEach(b => b.addEventListener('click', () => {
    inOrder = b.dataset.order === 'seq'; writePref('kaam_in_order', inOrder); nextRand = null;
    refreshAfterSetting(`[data-order="${b.dataset.order}"]`);
  }));
  sheet.querySelectorAll('[data-auto]').forEach(b => b.addEventListener('click', () => {
    autoPlay = b.dataset.auto === '1'; writePref('kaam_autoplay', autoPlay);
    refreshAfterSetting('#sw-auto');
  }));
  sheet.querySelector('#chip-verify').addEventListener('click', () => {
    verifyMode = !verifyMode; writePref('kaam_verify', verifyMode);
    rebuildVerify(); nextRand = null;
    refreshAfterSetting('#chip-verify');
  });
}

// ===== RÉPLIQUES =====
// Plafonds du corps de la réplique quand une scène occupe le haut de l'écran (ailleurs, fitQuote calcule le corps)
const Q_MAX = { video: 26, videoSE: 21, quiz: 28, quizSE: 22, scene: 28 };
const fitMemo = new Map();      // taille trouvée par fitQuote, par réplique et par place disponible
// Corps de la réplique calculé sur la place réelle de la pochette : le texte en occupe au moins les deux tiers, jamais plus
// petit que le barème quoteSize() sauf pour tenir ; au-delà du plancher, la réplique défile dans la pochette.
function fitQuote(card, qt, qb, q) {
  const hint = qb.querySelector('.quote-hint');
  const avail = qb.clientHeight - (hint ? hint.offsetHeight + 10 : 0);
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
  const fs = Math.max(fit(.62), Math.min(Math.round(quoteSize(q.quote) * 1.12 * k), fit(.97)));
  set(fs);
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
// Données de l'écran Répliques (aucun effet sur la page, sauf le compteur de l'aide)
function citationsModel(q) {
  const P = pool();
  // le rang n'a de sens que dans l'ordre ; en aléatoire, rien
  const counter = verifyMode
    ? `${plural(Object.keys(avisFaits).length, 'vérifiée')}${avisFile.length ? ` · ${nf(avisFile.length)} à envoyer` : ''}`
    : inOrder
    ? (P ? `${nf(P.indexOf(quoteIdx) + 1)} sur ${nf(P.length)}${videoOnly ? ' avec vidéo' : audioOnly ? ' avec son' : ''}` : `${nf(quoteIdx + 1)} sur ${nf(allQuotes.length)}`)
    : '';
  const summary = verifyMode
    ? [verifyApprox ? 'Sons les moins sûrs' : 'Tout vérifier', plural(verifyIdx.length, 'restante'), source === 'all' ? '' : SRC_LABEL[source]].filter(Boolean).join(SEP)
    : [SRC_LABEL[source], { text: 'Texte', audio: 'Son', video: 'Vidéo' }[mediaMode()], inOrder ? 'Dans l’ordre' : 'Aléatoire', autoPlay ? 'Lecture auto' : '']
        .filter(Boolean).join(SEP);
  const inlineVideo = !!((videoOnly || verifyMode) && q.video);
  const hint = !verifyMode && !inlineVideo && hintCount() < 3 ? (inOrder ? 'Touchez ou glissez pour la suivante' : 'Touchez ou glissez pour changer') : '';
  if (hint) countHint();
  return {
    counter, summary, inlineVideo, hint,
    reviewable: verifyMode && !!(q.audio || q.video),
    fav: isFav(q),
    what: q.audio && q.video ? 'Son et vidéo OK' : q.video ? 'Vidéo OK' : 'Son OK',
    no: String(q.i + 1).padStart(5, '0').replace(/^(\d{2})/, '$1 '),   // « 03 345 », espace fine
    atStart: !inOrder && randPos <= 0,
    // ce que dit la barre de lecture quand rien ne joue
    badge: verifyMode && q.audio && q.approx ? 'Son estimé' : inlineVideo ? 'Scène' : !q.audio ? 'Texte seul' : '',
  };
}
// Bouton lecture du son (rond central) : pictogramme lecture / pause, libellé pour VoiceOver (« Réessayer » après un échec)
function listenHTML(q, cls = 'tp') {
  return q.audio
    ? `<button class="${cls}" id="btn-audio">${icon('play', 'i-pl')}${icon('pause', 'i-pa')}<span class="lp">Écouter</span><span class="ls">Arrêter</span></button>`
    : `<span class="${cls} nil" aria-hidden="true">${icon('play', 'i-pl')}</span>`;
}
// Gabarit de l'écran Répliques : la pochette (couleur du personnage), le nom, la barre de lecture, les commandes
function citationsHTML(q, m, dir) {
  const size = Math.round(Math.min(quoteSize(q.quote), innerWidth < 360 || innerHeight < 620 ? Q_MAX.videoSE : Q_MAX.video) * textScale());
  const L = livreDe(q);
  const scene = q.video && m.inlineVideo
    ? `<span class="tool nil" aria-hidden="true">${icon('film')}<span>Scène</span></span>`
    : q.video
    ? `<button class="tool" id="btn-video">${icon('film')}<span>Scène</span></button>`
    : `<span class="tool nil">${icon('film')}<span>Pas de scène</span></span>`;
  return `
    <button class="bar${verifyMode ? ' verify' : ''}" id="btn-settings">
      <span class="bar-sum">${verifyMode ? '' : '<span class="bar-k">Réglages :</span>'}${m.summary}</span>${icon('chev', 'chev')}
    </button>
    ${m.inlineVideo ? sceneHTML(q, 'qvideo-slot') : ''}
    <div class="stage ${m.inlineVideo ? 'plain' : 'art'} swap-in${dir < 0 ? ' back' : dir > 0 ? '' : ' rand'}" id="quote-card"${m.inlineVideo ? '' : ` style="--c:${colorOf(q.name)}"`}>
      <div class="qblock">
        <blockquote class="quote" lang="fr"${m.inlineVideo ? ` style="font-size:${size}px"` : ''}>${quoteHTML(q.quote)}</blockquote>
        ${m.hint ? `<p class="quote-hint" aria-hidden="true">${m.hint}</p>` : ''}
      </div>
      ${m.inlineVideo ? '' : `<div class="cote" aria-hidden="true"><span class="ini">${initial(q.name)}</span><span class="cl"><b>Kaamelott</b>${L ? ' · ' + esc(livreNom(L)) : ''}</span></div>`}
    </div>
    <div class="meta">
      <div class="who-b"><button class="who" id="btn-who" aria-label="${esc(nameCase(q.name))}, voir la fiche du personnage">${esc(nameCase(q.name))}</button>
        ${fmtEp(q) ? `<p class="src">${epHTML(q)}</p>` : ''}</div>
      ${verifyMode ? `${q.video ? `<button class="ic" id="btn-video" aria-label="Scène en grand">${icon('film')}</button>` : ''}<button class="ic" id="btn-share" aria-label="Partager">${icon('share')}<span class="t lab">Partager</span></button>` : ''}
      ${favCellHTML(q, m.fav)}
    </div>
    <div class="scrub${q.audio || m.inlineVideo ? '' : ' none'}" id="scrub" aria-hidden="true"><div class="track"><i></i></div>
      <div class="times"><span></span><span class="badge" data-t="${m.badge}"${m.badge ? '' : ' hidden'}>${m.badge}</span><span></span></div></div>
    ${verifyMode ? `
      ${m.reviewable ? `<div class="vrow">${listenHTML(q, 'tp sm')}<button class="ok" id="avis-ok">${icon('check')}<span>${m.what}</span></button><button class="ko" id="avis-ko">Problème</button></div>` : ''}
      <div class="vfoot"><div class="stage-foot vf"><span class="quote-counter">${m.counter}</span>${m.reviewable ? `<button class="skip" id="avis-skip">Passer</button>` : ''}</div><div class="done-slot"></div></div>`
    : `
      <div class="transport">
        <button class="ts" id="btn-prev" aria-label="${inOrder ? 'Réplique précédente' : 'Revenir à la réplique précédente'}"${m.atStart ? ' disabled' : ''}>${icon('prev')}</button>
        ${m.inlineVideo ? `<button class="tp" id="btn-replay" aria-label="Revoir la scène">${icon('replay')}</button>` : listenHTML(q)}
        <button class="ts" id="btn-next" aria-label="${inOrder ? 'Réplique suivante' : 'Autre réplique'}">${icon('next')}</button>
      </div>
      <div class="tools">
        <button class="tool" id="btn-random">${icon('shuffle')}<span>Au hasard</span></button>
        ${scene}
        <button class="tool" id="btn-share">${icon('share')}<span class="t">Partager</span></button>
      </div>
      ${m.counter ? `<div class="stage-foot"><span class="quote-counter">${m.counter}</span></div>` : ''}`}`;
}
// Boutons de l'écran Répliques ; lance la scène dans la carte et le son en lecture auto (dans le geste)
function bindCitations(q, m, keep) {
  const $ = id => document.getElementById(id);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-who').addEventListener('click', e => { e.stopPropagation(); openPersonnage(q.name); });
  $('btn-fav').addEventListener('click', () => favButton($('btn-fav'), q));
  $('btn-share').addEventListener('click', () => shareQuote(q, $('btn-share')));
  if (m.reviewable) {
    $('avis-ok').addEventListener('click', () => recordAvis(q, true, [], ''));
    $('avis-ko').addEventListener('click', () => openProblem(q));
    $('avis-skip')?.addEventListener('click', () => { if (inOrder) stepQuote(1); else randomQuote(); });
  } else if (!verifyMode) {
    // en aléatoire, les boutons font comme les gestes (historique) ; dans l'ordre, voisines dans le corpus
    $('btn-prev').addEventListener('click', () => swipeBack());
    $('btn-next').addEventListener('click', () => swipeForward());
    $('btn-random').addEventListener('click', () => randomQuote());
  }
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
// Toucher la pochette = suivante ; glisser horizontalement = suivante / précédente (le défilement vertical reste libre)
function bindCardGestures(card) {
  let lastScroll = 0;
  const qb = card.querySelector('.qblock');
  qb.addEventListener('scroll', () => { lastScroll = Date.now(); fitOverflow(card); }, { passive: true });
  card.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (getSelection().toString().length) return;           // on sélectionnait du texte pour le copier
    if (Date.now() - lastScroll < 250) return;              // on faisait défiler une réplique longue
    swipeForward();
  });
  let sx = 0, sy = 0, st = 0;
  card.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }, { passive: true });
  card.addEventListener('touchmove', e => {
    const dx = Math.abs(e.touches[0].clientX - sx), dy = Math.abs(e.touches[0].clientY - sy);
    if (dx > dy && dx > 8) e.preventDefault();
  }, { passive: false });
  card.addEventListener('touchend', e => {
    const dx = sx - e.changedTouches[0].clientX, dy = Math.abs(sy - e.changedTouches[0].clientY);
    const fast = Date.now() - st < 250 && Math.abs(dx) > 30;
    if ((Math.abs(dx) > 50 || fast) && Math.abs(dx) > dy) { if (dx > 0) swipeForward(); else swipeBack(); }
  }, { passive: true });
}
function renderCitations(dir = 0) {
  const main = document.getElementById('main-content');
  if (!allQuotes.length) return;
  if (verifyMode && !verifyIdx.length) { renderVerifyDone(); return; }   // tout est vérifié : on s'arrête
  const fid = main.contains(document.activeElement) ? document.activeElement.id : '';
  if (!allQuotes[quoteIdx]) quoteIdx = pickRandom();          // index périmé (filtres, données changées)
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

// ===== AVIS DE VÉRIFICATION =====
// listes à cocher, comme dans Réglages d'iOS : Son, Scène, Texte (identifiants d'avis inchangés)
const PB_LISTS = [
  ['audio', 'Son', [['son_faux', 'Pas le bon son'], ['son_coupe', 'Coupé avant la fin'], ['son_deborde', 'Déborde sur la suite']]],
  ['video', 'Scène', [['video_fausse', 'Pas la bonne scène'], ['video_coupee', 'Coupée avant la fin']]],
  ['texte', 'Texte', [['texte_faux', 'Le texte ne correspond pas']]],
];
function openProblem(q) {
  const has = k => k === 'texte' || !!q[k];
  const ctx = [nameCase(q.name), q.film ? 'Film' : q.inedit ? q.inedit.replace(/ :.*/, '') : [q.livre && `Livre ${q.livre}`, q.episode && `Épisode ${q.episode}`].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  const sheet = openSheet(`
    <div class="grab" aria-hidden="true"></div>
    <div class="sh-nav"><button class="l" id="avis-cancel">Annuler</button><h2 id="sh-title">Problème</h2><button class="r" id="avis-send2" disabled>Envoyer</button></div>
    <p class="gf ctr">${esc(ctx)}</p>
    ${PB_LISTS.filter(([k]) => has(k)).map(([, lab, rows]) => `<p class="gh">${lab}</p><div class="g">${rows.map(([id, l]) =>
      `<button class="gr" data-pb="${id}" role="checkbox" aria-checked="false"><span class="k">${l}</span>${icon('check', 'ck')}</button>`).join('')}</div>`).join('')}
    <p class="gh"><label for="avis-note">Précision (facultatif)</label></p>
    <div class="g"><textarea class="note" id="avis-note" maxlength="500" placeholder="Par exemple : le son mord sur la réplique suivante"></textarea></div>
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
  note.addEventListener('input', () => { upd(); note.style.height = 'auto'; note.style.height = Math.min(Math.max(note.scrollHeight, 88), 120) + 'px'; });
  note.addEventListener('focus', () => setTimeout(() => note.scrollIntoView({ block: 'center' }), 300));
  sheet.querySelector('#avis-cancel').addEventListener('click', closeSheet);
  const go = () => { closeSheet(); recordAvis(q, false, [...picked], note.value.trim()); };
  send.addEventListener('click', go); send2.addEventListener('click', go);
}
function recordAvis(q, ok, problemes, note) {
  if (avisFaits[q.i]) return;                   // jamais deux avis pour la même réplique
  avisFaits[q.i] = ok ? 1 : 2;                  // 1 = validée, 2 = signalée
  avisFile.push({ i: q.i, quote: q.quote, name: q.name, audio: q.audio, video: q.video, approx: q.approx, ok, problemes, note, ts: Date.now() });
  // la file d'abord : si elle ne peut pas être écrite, la réplique n'est pas marquée « vérifiée » (elle reviendra)
  if (writeJSON('kaam_avis_file', avisFile)) writeJSON('kaam_avis_faits', avisFaits);
  if (avisFile.length >= 5) sendAvis(); else scheduleSend();
  // « Validé · Annuler » ou « Signalé · Annuler » pendant 5 s : un pouce qui glisse ne valide rien pour de bon
  const ts = avisFile[avisFile.length - 1].ts;
  lastAvis = { i: q.i, idx: quoteIdx, ts, t: Date.now(), ok,
    label: `${nameCase(q.name)}${q.film ? ', film' : q.livre ? `, Livre ${q.livre}${q.episode ? `, ép. ${q.episode}` : ''}` : ''}` };
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
  slot.outerHTML = `<div class="done-line done-slot" role="status"><span><b>${lastAvis.ok ? 'Validé' : 'Signalé'}</b> · ${esc(lastAvis.label)}</span><button id="avis-undo"${sent ? ' disabled' : ''}>${sent ? 'Déjà envoyé' : 'Annuler'}</button></div>`;
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
  delete avisFaits[last.i];
  avisFile = avisFile.filter(a => a.ts !== last.ts);
  writeJSON('kaam_avis_faits', avisFaits);   // ordre inverse de recordAvis : jamais un avis en file pour une réplique non marquée
  writeJSON('kaam_avis_file', avisFile);
  lastAvis = null; clearTimeout(doneTimer);
  rebuildVerify();
  showQuote(last.idx, -1);
  document.getElementById('sr-live').textContent = 'Avis annulé.';
}
// Écran de fin : plus rien à vérifier dans cette source
function renderVerifyDone() {
  stopAudio();                                   // met aussi la scène de la carte en pause
  setMast('Vérification');
  const total = allQuotes.reduce((n, q) => n + ((q.audio || q.video) && inSrc(q, source) ? 1 : 0), 0);
  const vals = Object.values(avisFaits);
  document.getElementById('main-content').innerHTML = `
    <button class="bar verify" id="btn-settings"><span class="bar-sum">Terminé</span>${icon('chev', 'chev')}</button>
    <div class="scroll"><div class="fin"><div class="ok-i">${icon('check')}</div><h1>Tout est vérifié.</h1>
      <p>${nf(total)} sur ${nf(total)}, sur ce téléphone. Merci.</p>
      <dl class="grp"><div><dt>Validés</dt><dd>${nf(vals.filter(v => v !== 2).length)}</dd></div><div><dt>Signalés</dt><dd>${nf(vals.filter(v => v === 2).length)}</dd></div><div><dt>En attente d’envoi</dt><dd>${nf(avisFile.length)}</dd></div></dl>
      <button class="pill wide" id="verify-leave">Revenir à la lecture</button></div></div>`;
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('verify-leave').addEventListener('click', () => {
    verifyMode = false; writePref('kaam_verify', false); nextRand = null;
    showQuote(pickRandom());
  });
}
// Envoi par lots ; les avis restent dans l'appareil tant que l'envoi n'a pas réussi.
// Un lot refusé pour de bon (400, 415) est écarté ; 429 et 5xx : nouvel essai avec un délai doublé.
let sending = false, sendDelay = 15000, sendRetry = null, idleSend = null;
function sendAvis() {
  if (sending || !avisFile.length) return;
  sending = true;
  clearTimeout(sendRetry);
  const lot = avisFile.slice(0, 100);
  fetch('/api/avis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avis: lot }), keepalive: true })
    .then(r => {
      if (r.ok || r.status === 400 || r.status === 415) {
        const sent = new Set(lot.map(a => a.ts));
        avisFile = avisFile.filter(a => !sent.has(a.ts));
        writeJSON('kaam_avis_file', avisFile);
        sendDelay = 15000;
        refreshVerifyCounter();
      } else if (r.status === 429 || r.status >= 500) {
        sendRetry = setTimeout(sendAvis, sendDelay); sendDelay = Math.min(sendDelay * 2, 300000);
      }
    })
    .catch(() => {})
    .finally(() => { sending = false; });
}
function refreshVerifyCounter() {
  const c = document.querySelector('.stage-foot.vf .quote-counter');
  if (c) c.textContent = `${plural(Object.keys(avisFaits).length, 'vérifiée')}${avisFile.length ? ` · ${nf(avisFile.length)} à envoyer` : ''}`;
}
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
  showQuote(idx, dir);
}
function randomQuote() {
  const P = pool();
  const idx = nextRand !== null && (!P || P.includes(nextRand)) && nextRand !== quoteIdx ? nextRand : pickRandom();
  nextRand = null;
  pushHistory(idx);
  showQuote(idx, 0);
}
// Toucher / glisser : selon le mode, réplique suivante dans l'ordre ou au hasard (avec historique)
function swipeForward() { if (inOrder) stepQuote(1); else historyForward(); }
function swipeBack()    { if (inOrder) stepQuote(-1); else historyBack(); }
function historyBack() {
  if (randPos > 0) { randPos--; showQuote(randHistory[randPos], -1); }
}
function historyForward() {
  if (randPos < randHistory.length - 1) { randPos++; showQuote(randHistory[randPos], 1); }
  else randomQuote();
}
// Ouvre une réplique précise (recherche, favoris, fiche) dans la page Répliques
function gotoQuote(q) {
  let idx = allQuotes.indexOf(q);
  if (idx < 0) idx = allQuotes.findIndex(x => x.quote === q.quote && x.name === q.name);
  if (idx < 0) return;
  ficheState = overlaySnapshot();                                       // on retrouvera la fiche à sa place
  closeOverlay();
  quoteIdx = idx;
  pushHistory(idx);
  setView('citations');
}
// Partage : feuille système si elle existe, sinon copie ; la confirmation s'écrit dans le bouton (jamais de fenêtre d'alerte)
const shareTimers = new WeakMap();   // bouton → { libellé d'origine, minuteur } pendant « Copié » / « Envoyé »
async function shareText(text, btn) {
  let said = '';
  if (navigator.share) {
    try { await navigator.share({ text }); said = 'Envoyé'; } catch { return; }
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
  if (!btn || !btn.isConnected) return;
  const lab = btn.querySelector('.t') || btn;
  const prev = shareTimers.get(btn);
  if (prev) clearTimeout(prev.timer);
  const html = prev ? prev.html : lab.innerHTML;
  lab.textContent = said;
  btn.classList.add('said');
  shareTimers.set(btn, { html, timer: setTimeout(() => { lab.innerHTML = html; btn.classList.remove('said'); shareTimers.delete(btn); }, 1500) });
}
function shareQuote(q, btn) {
  return shareText(`« ${q.quote} »\n${nameCase(q.name)}${fmtEp(q) ? ', ' + fmtEp(q) : ''}\n\nKaamelott`, btn);
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
  if (!TOP_CHARS.includes(q.name) || !q.video || q.quote.length < 25) return false;
  return !fold(q.quote).includes(fold(q.name.replace(/^(LE|PÈRE) /, '')));
}
function buildQuizPool() {
  if (quizByChar && quizByChar.src === allQuotes) return;
  quizByChar = { src: allQuotes, m: {} };
  allQuotes.forEach((q, i) => {
    if (quizAccepts(q)) (quizByChar.m[q.name] = quizByChar.m[q.name] || []).push(i);   // pas de « ||= » : iOS 13.4 et plus
  });
}
function quizPick() {
  buildQuizPool();
  const names = Object.keys(quizByChar.m);
  for (let t = 0; t < 20; t++) {
    const i = rand(quizByChar.m[rand(names)]);
    if (!QUIZ_RECENT.includes(i)) { QUIZ_RECENT.push(i); if (QUIZ_RECENT.length > 80) QUIZ_RECENT.shift(); return allQuotes[i]; }
  }
  return allQuotes[rand(quizByChar.m[rand(names)])];
}
function shuffle(a, rnd = Math.random) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// ===== QUESTION DU JOUR : la même pour tout le monde ce jour-là (graine = date), une seule tentative =====
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function dailyState() { const st = readJSON('kaam_qdj', {}); return st.d === todayKey() ? st : null; }
function dailyQuestion() {
  quizPick();                                       // construit le pool
  const rnd = mulberry32(+todayKey().replace(/-/g, ''));
  const names = Object.keys(quizByChar.m).sort();
  const list = quizByChar.m[names[Math.floor(rnd() * names.length)]];
  const q = allQuotes[list[Math.floor(rnd() * list.length)]];
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
      writeJSON('kaam_qdj', { d: todayKey(), pick: btn.dataset.choice, ok: correct });
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
// cases du score : Jour · Tentative · Jours justes (question du jour) ou Justes · Série · Record
function quizUpdateScore(daily, hist, record) {
  const sc = document.querySelector('.score').children;
  if (daily) {
    sc[1].querySelector('b').innerHTML = '1<em>/1</em>';
    sc[2].querySelector('b').textContent = Object.values(hist).filter(Boolean).length;
  } else {
    sc[0].querySelector('b').innerHTML = `${quizState.correct}<em>/${quizState.total}</em>`;
    sc[1].querySelector('b').textContent = quizState.streak;
    sc[2].querySelector('b').textContent = quizState.best;
    if (record && quizState.best > 1) { sc[2].classList.add('rec'); sc[2].querySelector('span').textContent = 'Nouveau record'; }
  }
}
// la récompense : la scène, projetée dans le geste (donc avec le son), en tête de la zone ; en relecture, sans le son
function quizShowScene(q, replay) {
  if (!replay) stopAudio();                 // jamais deux sons : le mini-lecteur s'arrête, la scène parle
  const scene = document.getElementById('quiz-scene');
  scene.innerHTML = sceneHTML(q, 'quiz-fig');
  const fig = document.getElementById('quiz-fig');
  bindScene(fig, cardVideo);
  if (!replay) playCardVideo(q, fig);
  else { fig.querySelector('.frame').prepend(cardVideo); cardVideo.src = mediaSrc(videoURL(q)); setScene(cardVideo, 'loading'); cardVideo.muted = true; cardVideo.play().catch(() => {}); }
}
// rangée du pouce après la réponse : Partager / Quiz libre (question du jour) ou Question suivante
function quizNavAfter(daily) {
  const nav = document.getElementById('quiz-nav');
  if (daily) {
    const res = readJSON('kaam_qdj', {});
    nav.className = 'nav two';
    nav.innerHTML = `<button class="pill gray" id="qdj-share">${icon('share')}<span class="t">Partager</span></button><button class="pill" id="quiz-free">Quiz libre</button>`;
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
  quizUpdateScore(daily, ctx.hist, record);
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
// après, la scène prend la hauteur disponible (16:9 entier, centrée), la question se lit dessous en faisant défiler.
function fitQuiz(stage) {
  if (!stage?.isConnected) return;
  const qt = stage.querySelector('.quiz-q .quote');
  const fr = stage.querySelector('.q-scene .frame');
  if (fr) {
    const main = document.getElementById('main-content');
    main.classList.remove('qpage');
    if (stage.scrollHeight <= stage.clientHeight + 1) { armMast(); return; }   // tout tient : rien à faire
    // sinon la page entière défile : scène presque pleine largeur (16:9 entière), question entière, puis les choix
    main.classList.add('qpage');
    main.scrollTop = 0;
    armMast();
    return;
  }
  if (!qt) return;
  let fs = parseFloat(qt.style.fontSize) || 24;
  const min = Math.round(17 * textScale());
  while (fs > min && stage.scrollHeight > stage.clientHeight + 1) { fs--; qt.style.fontSize = fs + 'px'; }
}
function renderQuiz(daily = false) {
  if (!quizState) initQuiz();
  stopVideos();
  document.getElementById('main-content').classList.remove('qpage');
  setMast(daily ? 'Question du jour' : 'Quiz');
  const main = document.getElementById('main-content');
  let q, choices;
  if (daily) ({ q, choices } = dailyQuestion());
  else {
    q = quizPick();
    choices = shuffle([q.name, ...shuffle(TOP_CHARS.filter(c => c !== q.name)).slice(0, 3)]);
  }
  quizState.current = q;
  quizState.answered = false;
  cachedMedia(videoURL(q));                  // la scène se télécharge pendant que l'on réfléchit
  const short = innerHeight < 620;
  const fs = Math.round(Math.min(quoteSize(q.quote), short ? Q_MAX.quizSE : Q_MAX.quiz) * textScale());
  const done = dailyState();
  // quatre couleurs différentes : une couleur déjà prise passe à la suivante libre de la palette
  const qcol = [];
  choices.forEach(c => { let col = colorOf(c), k = PAL.indexOf(col); while (qcol.includes(col)) { k = (k + 1) % PAL.length; col = PAL[k]; } qcol.push(col); });
  const hist = readJSON('kaam_qdj_hist', {});
  const daysOk = Object.values(hist).filter(Boolean).length;
  main.innerHTML = `
    <div class="score">${daily
      ? `<div><span>Jour</span><b class="dt">${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</b></div>
         <div><span>Tentative</span><b>${done ? 1 : 0}<em>/1</em></b></div>
         <div><span>Jours justes</span><b>${daysOk}</b></div>`
      : `<div><span>Justes</span><b>${quizState.correct}<em>/${quizState.total}</em></b></div>
         <div><span>Série</span><b>${quizState.streak}</b></div>
         <div><span>Record</span><b>${quizState.best}</b></div>`}
    </div>
    <div class="scroll" id="quiz-stage">
      <p class="verdict" id="quiz-verdict" hidden></p>
      <div class="qcard">
        <div id="quiz-scene" class="q-scene"></div>
        <figure class="quiz-q">
          <p class="ask" id="quiz-ask">${daily ? 'Question du jour · qui a dit ça ?' : 'Qui a dit ça ?'}</p>
          <blockquote class="quote" lang="fr" style="font-size:${fs}px">${quoteHTML(q.quote)}</blockquote>
          <figcaption class="src" id="quiz-after" hidden></figcaption>
        </figure>
      </div>
    </div>
    <div class="choices" role="group" aria-label="Qui a dit ça ?">
      ${choices.map((c, k) => `<button class="choice" data-choice="${esc(c)}"><span class="l" style="--c:${qcol[k]}" aria-hidden="true">${initial(c)}</span><span class="n">${esc(nameCase(c))}</span><span class="v"></span></button>`).join('')}
    </div>
    ${daily
      ? `<div class="nav one" id="quiz-nav"><button class="pill gray" id="quiz-free">Revenir au quiz libre</button></div>`
      : `<div class="nav two" id="quiz-nav"><button class="pill gray" id="quiz-daily">${icon('cal')}<span>${done ? `Du jour · ${done.ok ? 'juste' : 'faux'}` : 'Question du jour'}</span></button><button class="pill gray" id="quiz-next">Passer</button></div>`}`;

  const stage = document.getElementById('quiz-stage');
  // la question entière dans la zone (corps réduit jusqu'à 17 px) ; après la réponse, la scène entière en tête
  const fade = () => fitQuiz(stage);
  fade();
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
// Rangée d'actions à colonnes fixes : Écouter · Scène · Favori (· Partager hors fiche) ; une pièce absente reste une cellule grisée
// Rangée d'actions à colonnes fixes : Écouter · Scène · Favori · Partager (même jeu partout : listes, fiche, écran principal).
// Une pièce absente le dit en clair ; ni son ni scène : une seule case sur deux colonnes.
// Quatre commandes à place fixe : Écouter (rond à gauche) · Scène · Favori (étoile à droite) · Partager.
// Une pièce absente reste à sa place, grisée ; ni son ni scène : une seule case qui en vaut deux.
function entActs(q, opts) {
  const fav = isFav(q);
  const nil = (t, w2, cls = '') => `<span class="cell nil${w2 ? ' w2' : ''}${cls}"${cls ? ' aria-hidden="true"' : ''}>${cls === ' pl' ? icon('quote') + `<span class="sr">${t}</span>` : t}</span>`;
  const media = !allQuotes.length
    ? nil(navigator.onLine === false ? 'Hors ligne' : 'Indisponible', true, ' pl')     // favoris relus sans les répliques
    : !q.audio && !q.video ? nil('Sans son ni scène', true, ' pl')
    : (q.audio ? `<button class="cell pl" data-act="audio">${icon('play', 'i-pl')}${icon('pause', 'i-pa')}<span class="lp sr">Écouter</span><span class="ls sr">Arrêter</span></button>` : nil('Pas de son', false, ' pl'))
      + (q.video ? `<button class="cell sc" data-act="video">${icon('film')}Scène</button>` : nil('Pas de scène', false, ' sc'));
  return `<div class="ent-a">
      ${media}
      <button class="cell fv${fav ? ' on' : ''}" data-act="fav" aria-pressed="${fav}">${favFace(fav, opts.remove ? 'Retirer' : 'Favori')}</button>
      <button class="cell sh" data-act="share">${icon('share')}<span class="t">Partager</span></button>
    </div>`;
}
function entHTML(q, k, opts = {}) {
  const meta = opts.fiche ? '' : `<div class="ent-m">${opts.name === false ? '' : `<b>${esc(nameCase(q.name))}</b>`}${epHTML(q)}</div>`;
  const lost = opts.remove && !q.live;                   // favori dont la réplique n'existe plus telle quelle
  return `<div class="ent" data-k="${k}">
    ${lost ? `<div class="ent-m">${esc(nameCase(q.name))} · réplique modifiée depuis : touchez l’étoile pour la retirer</div>` : meta}
    ${lost ? `<div class="ent-q">${typo(q.quote)}</div>` : `<button class="ent-q" data-act="goto">${opts.query ? highlight(q.quote, opts.query) : typo(q.quote)}</button>`}
    ${entActs(q, opts)}
  </div>`;
}
const undoByEntry = new WeakMap();   // entrée de favori retirée → de quoi la remettre à sa place
// Délégation des actions d'une liste d'entrées ; list(k) rend la réplique de l'entrée k
function bindEntries(container, list, opts = {}) {
  container.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const ent = a.closest('.ent');
    const q = list(+ent.dataset.k);
    if (!q) return;
    const act = a.dataset.act;
    if (act === 'audio') playAudio(q.audio, a, q);
    else if (act === 'video') showVideo(q);
    else if (act === 'goto') gotoQuote(q);
    else if (act === 'share') shareQuote(q, a);
    else if (act === 'fav' && opts.remove) {
      // Favoris : retirée tout de suite, mais l'entrée reste en place, barrée, avec « Remettre »
      const at = favorites.findIndex(f => sameQuote(f, q));
      const saved = favorites[at];
      if (at < 0) return;
      favorites.splice(at, 1);
      if (!saveFavorites()) { favorites.splice(at, 0, saved); a.innerHTML = favFace(true, 'Retirer', 'Non enregistré'); return; }
      const row = ent.querySelector('.ent-a');
      const rowHTML = row.outerHTML;
      ent.classList.add('off');
      row.outerHTML = `<div class="ent-a undo"><span class="lab">Retirée des favoris</span><button class="cell un" data-act="undo">Remettre</button></div>`;
      undoByEntry.set(ent, { at, saved, rowHTML });
      opts.onCount?.();
      ent.querySelector('[data-act="undo"]').focus({ preventScroll: true });
    }
    else if (act === 'undo' && undoByEntry.has(ent)) {
      const { at, saved, rowHTML } = undoByEntry.get(ent);
      if (!isFav(saved)) {
        favorites.splice(Math.min(at, favorites.length), 0, saved);
        if (!saveFavorites()) { favorites = favorites.filter(f => f !== saved); a.textContent = 'Non enregistré'; return; }
      }
      ent.classList.remove('off');
      ent.querySelector('.ent-a').outerHTML = rowHTML;
      undoByEntry.delete(ent);
      opts.onCount?.();
    }
    else if (act === 'fav') favButton(a, q);
  });
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
  // une ligne façon « artiste » : rond de couleur avec l'initiale, nom, nombre de répliques
  const row = ([name, count], cls = '') => `<button class="idx-row${cls}" data-char="${esc(name)}" data-f="${esc(fold(nameCase(name)))}"><span class="av" style="--c:${colorOf(name)}" aria-hidden="true">${initial(name)}</span><span class="t"><span class="n">${esc(nameCase(name))}</span><span class="c">${plural(count, 'réplique')}</span></span>${icon('chev', 'chev')}</button>`;
  let rows = '', letter = '';
  list.forEach(c => {
    if (persSort === 'alpha') {
      const l = sortKey(c[0]).charAt(0).toUpperCase();
      if (l !== letter) { letter = l; rows += `<div class="idx-l">${l}</div>`; }
    }
    if (minors && c[1] < MINOR && !rows.includes('idx-more')) rows += `<button class="idx-more" id="pers-more"><span class="av more-av" aria-hidden="true">${icon('people')}</span><span class="t"><span class="n">Rôles de passage</span><span class="c">${nf(minors)} personnages, moins de ${MINOR} répliques chacun</span></span>${icon('chev', 'chev')}</button>`;
    rows += row(c, minors && c[1] < MINOR ? ' minor' : '');
  });
  if (duos.length) rows += `<div class="idx-l voix">À plusieurs voix</div>` + duos.map(c => row(c, ' duo')).join('');
  const top = az ? [] : solo.slice(0, 8);
  main.innerHTML = `
    <div class="scroll" id="pers-scroll">
      <div class="page-h"><h1 class="sr">Personnages</h1><p>${nf(solo.length)} personnages · ${nf(allQuotes.length)} répliques</p></div>
      <label class="pf field">${icon('search')}<input id="pers-filter" type="search" placeholder="Filtrer les noms" aria-label="Filtrer les noms" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></label>
      <div class="sort seg"><button class="${persSort === 'count' ? 'on' : ''}" data-sort="count" aria-pressed="${persSort === 'count'}">Par répliques</button><button class="${persSort === 'alpha' ? 'on' : ''}" data-sort="alpha" aria-pressed="${persSort === 'alpha'}">De A à Z</button></div>
      ${top.length ? `<div id="pers-top"><h2 class="h2">Les plus cités</h2><div class="shelf">${top.map(([n]) => `<button class="art-c" data-char="${esc(n)}"><span class="av lg" style="--c:${colorOf(n)}" aria-hidden="true">${initial(n)}</span><b>${esc(nameCase(n))}</b></button>`).join('')}</div></div>` : ''}
      <h2 class="h2" id="pers-h">${az ? 'De A à Z' : 'Tous les personnages'}</h2>
      <div class="perso-list${minors && !persAll ? ' collapsed' : ''}${az ? ' az' : ''}" id="pers-list">${rows}</div>
    </div>`;
  const sc = document.getElementById('pers-scroll'), listEl = document.getElementById('pers-list'), input = document.getElementById('pers-filter');
  const applyFilter = () => {
    const v = fold(input.value.trim());
    listEl.classList.toggle('filtering', !!v);
    const tp = document.getElementById('pers-top'); if (tp) tp.hidden = !!v;
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
  return overlay;
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
  renderMini();
  if (was && overlayFocus?.isConnected) overlayFocus.focus({ preventScroll: true });
  overlayFocus = null;
}
// En-tête d'épisode de la fiche, en clair : « Livre IV · ép. 58 », « Film », « Inédit 3 »
function epLabel(q) {
  if (q.film) return 'Film';
  if (q.inedit) return coteEp(q);
  return [q.livre ? `Livre\u00a0${q.livre}` : '', q.episode ? `ép.\u00a0${q.episode}` : ''].filter(Boolean).join(' · ');
}
const livreDe = q => q.film ? 'Film' : q.inedit ? 'Inédits' : q.livre || '';
const LIVRES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'Film', 'Inédits'];
function openPersonnage(name, restore) {
  stopVideos();
  setMast('Personnages');
  const quotes = allQuotes.filter(q => q.name === name);
  const epKey = q => q.film ? 'film' : q.inedit ? 'x' + q.inedit : `${q.livre}|${q.episode}`;
  const epCount = new Map();
  quotes.forEach(q => epCount.set(epKey(q), (epCount.get(epKey(q)) || 0) + 1));
  const epTitre = q => q.film ? 'Premier volet' : q.inedit ? q.inedit.replace(/^Inédit \d\s*:\s*/, '') : titleCase(q.title || '');
  // part du corpus
  const pc = n => (n * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: n * 100 < 10 ? 1 : 0 });
  const byLivre = new Map();
  quotes.forEach(q => { const L = livreDe(q); if (L) byLivre.set(L, (byLivre.get(L) || 0) + 1); });
  const livres = LIVRES.filter(L => byLivre.has(L));
  const first = quotes[0];
  const nm = nameCase(name);
  let start = restore?.start || 0, shown = start, lastEp = null;
  const overlay = openOverlay(`
    <div class="back"><button id="detail-back" aria-label="Retour aux personnages">${icon('back')}</button><span class="nt" aria-hidden="true">${esc(nm)}</span></div>
    <div class="scroll" id="fiche-scroll">
      <header class="fiche-h" style="--c:${colorOf(name)}"><span class="big" aria-hidden="true">${initial(name)}</span>
        <h1${nm.length > 13 ? ' class="long"' : ''}>${esc(nm)}</h1>
        <p class="part">Première réplique : ${esc(epLabel(first) || '—')}</p>
        <button class="play" id="f-rand" aria-label="Une réplique au hasard">${icon('shuffle')}</button>
      </header>
      <div class="stats">
        <div><span>Répliques</span><b>${nf(quotes.length)}</b></div>
        <div><span>Épisodes</span><b>${nf(epCount.size)}</b></div>
        <div><span>Part du total</span><b>${pc(quotes.length / allQuotes.length)} %</b></div>
      </div>
      ${livres.length > 1 ? `<h2 class="h2">Livres</h2><div class="livres shelf" role="group" aria-label="Aller au Livre">${livres.map(L => `<button class="alb-c" data-livre="${L}" aria-label="${esc(livreNom(L))}, ${plural(byLivre.get(L), 'réplique')}"><span class="alb" style="--c:${LCOL[L]}" aria-hidden="true"><small>${/^[IV]+$/.test(L) ? 'Livre' : 'Kaamelott'}</small><b>${L}</b></span><span class="cap2" aria-hidden="true"><b>${esc(livreNom(L))}</b><span>${plural(byLivre.get(L), 'réplique')}</span></span></button>`).join('')}</div>` : ''}
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
      listEl.insertAdjacentHTML('beforeend', `<button class="more pill gray">Afficher les 50 suivantes · ${nf(quotes.length - shown)} restantes</button>`);
      const b = listEl.querySelector('.more:not(.top)');
      b.addEventListener('click', () => more());
      io?.observe(b);
    }
  };
  const from = s0 => {
    start = s0; shown = s0; lastEp = null;
    listEl.innerHTML = s0 > 0 ? `<button class="more top pill gray">Revenir au début · ${nf(s0)} répliques avant</button>` : '';
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
// Ce qu'on cherchait reste là quand on revient sur l'onglet (texte, nombre d'entrées affichées, défilement)
const searchState = { q: '', top: 0, shown: 40 };
let searchTimeout = null;
function renderRecherche() {
  stopVideos();
  setMast(mastFor('recherche'));
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="search"><label class="field">${icon('search')}
      <input type="search" id="search-input" placeholder="Un mot, une réplique, un nom" aria-label="Chercher une réplique" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <button class="clr" id="search-clear" aria-label="Effacer">${icon('x')}</button></label>
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
  // la requête désigne un personnage : une ligne de renvoi vers sa fiche, puis les répliques qui contiennent le mot
  const who = (res?.who || []).map(([n, c]) => `<button class="res-who idx-like" data-name="${esc(n)}"><span class="av" style="--c:${colorOf(n)}" aria-hidden="true">${initial(n)}</span><span class="t"><span class="n">${esc(nameCase(n))}</span><span class="c">Personnage · ${plural(c, 'réplique')}</span></span>${icon('chev', 'chev')}</button>`).join('');
  const bindWho = () => container.querySelectorAll('.res-who').forEach(b => b.addEventListener('click', () => openPersonnage(b.dataset.name)));
  if (!hits.length) {
    container.innerHTML = (who ? `<h2 class="res-h">Personnages</h2>${who}` : '') + `<div class="empty">${who ? '' : `<span class="ei">${icon('search')}</span>`}<b>${who ? 'Aucune réplique ne contient ce mot.' : `Rien pour « ${esc(query)} ».`}</b><small>Vérifiez l’orthographe, ou essayez le début d’un mot.</small></div>`;
    bindWho();
    return;
  }
  let shown = 0;
  container.innerHTML = who
    ? `<h2 class="res-h">Personnages</h2>${who}<div class="res-h" role="status">Répliques<b>${nf(hits.length)}</b></div><div id="res-list"></div>`
    : `<div class="res-n" role="status">${nf(hits.length)} réplique${hits.length > 1 ? 's' : ''}</div><div id="res-list"></div>`;
  bindWho();
  const listEl = container.querySelector('#res-list');
  const more = n => {
    listEl.querySelector('.more')?.remove();
    const next = hits.slice(shown, shown + (n || 40));
    listEl.insertAdjacentHTML('beforeend', next.map((q, j) => entHTML(q, shown + j, { query })).join(''));
    shown += next.length;
    searchState.shown = shown;
    if (shown < hits.length) {
      listEl.insertAdjacentHTML('beforeend', `<button class="more pill gray">Afficher la suite · ${nf(hits.length - shown)} restantes</button>`);
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
  stopVideos();
  setMast(mastFor('favoris'));
  const main = document.getElementById('main-content');
  if (!favorites.length) {
    main.innerHTML = `<div class="scroll"><div class="page-h"><h1 class="sr">Favoris</h1><p>Aucune réplique enregistrée</p></div>
      <div class="empty"><span class="ei">${icon('star')}</span><b>Aucun favori</b><small>Touchez l’étoile à côté d’un nom pour garder une réplique ici.</small>${allQuotes.length ? '<button class="pill" id="fav-open">Ouvrir une réplique au hasard</button>' : ''}</div></div>`;
    document.getElementById('fav-open')?.addEventListener('click', () => { quoteIdx = pickRandom(); setView('citations'); });
    return;
  }
  const list = favorites.map(liveQuote);
  const sub = () => { const n = favorites.length; return `${nf(n)} réplique${n > 1 ? 's' : ''} enregistrée${n > 1 ? 's' : ''}${n > 1 ? ' · la plus récente en tête' : ''}`; };
  const playable = () => list.filter(q => q.live && favorites.some(f => sameQuote(f, q)));
  main.innerHTML = `<div class="scroll"><div class="page-h"><h1 class="sr">Favoris</h1><p id="fav-count">${sub()}</p></div>
    ${allQuotes.length ? `<div class="pills"><button class="pill gray" id="fav-play">${icon('play')}Lecture</button><button class="pill gray" id="fav-rand">${icon('shuffle')}Aléatoire</button></div>` : ''}
    <div id="fav-list">${list.map((q, k) => entHTML(q, k, { remove: true })).join('')}</div></div>`;
  bindEntries(main.querySelector('#fav-list'), k => list[k], { remove: true, onCount: () => { document.getElementById('fav-count').textContent = sub(); } });
  // Lecture : la plus récente (avec son, de préférence) ; Aléatoire : une au hasard. Le son part dans le geste.
  const open = q => { if (!q) return; gotoQuote(q); const b = document.getElementById('btn-audio'); if (b && q.audio && !playingBtn) playAudio(q.audio, b, allQuotes[quoteIdx]); };
  document.getElementById('fav-play')?.addEventListener('click', () => { const P = playable(); open(P.find(q => q.audio) || P[0]); });
  document.getElementById('fav-rand')?.addEventListener('click', () => { const P = playable(); open(P.length ? rand(P) : null); });
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
  const fromFiche = overlayCtx?.kind === 'fiche' ? overlayCtx.snap() : null;   // scène ouverte depuis une fiche : « Retour » y ramène
  setMast('Scène');
  const overlay = openOverlay(`
    <div class="back solid"><button id="detail-back" aria-label="Retour">${icon('back')}</button><span class="nt">Scène</span></div>
    <div class="scroll scene-page">
      ${sceneHTML(q, 'mfig')}
      <figure class="body">
        <blockquote class="quote" lang="fr" style="font-size:${Math.round(Math.min(quoteSize(q.quote), Q_MAX.scene) * textScale())}px">${quoteHTML(q.quote)}</blockquote>
        <div class="meta"><div class="who-b"><button class="who" id="m-who" aria-label="${esc(nameCase(q.name))}, voir la fiche du personnage">${esc(nameCase(q.name))}</button>
          ${fmtEp(q) ? `<p class="src">${epHTML(q)}</p>` : ''}</div>
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
  wireScene(v);
  fig.querySelector('.frame').prepend(v);
  fig.dataset.src = videoURL(q);
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
  currentView = view;
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
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadCtrl = !!navigator.serviceWorker.controller;   // une version tournait déjà
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type !== 'SW_UPDATED' || !hadCtrl) return;
    updatePending = true;
  });
}
// L'app installée sur l'écran d'accueil ne « navigue » pas quand iOS la rouvre : on cherche une nouvelle version
// au retour au premier plan, au plus une fois par heure
let lastUpdateCheck = Date.now();
function onVisible() {
  if (Date.now() - lastUpdateCheck > 3600e3) {
    lastUpdateCheck = Date.now();
    navigator.serviceWorker?.getRegistration().then(r => r && r.update()).catch(() => {});
  }
  reloadIfIdle();
}

// ===== DÉMARRAGE =====
let retryTimer = null, autoRetried = false, booting = false, waitingOnline = false;
async function boot() {
  if (booting) return;                     // jamais deux démarrages en parallèle (Réessayer, retour du réseau, minuteur)
  clearTimeout(retryTimer);
  booting = true;
  currentView = 'citations';
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'citations'));
  const main = document.getElementById('main-content');
  setTabsEnabled(false);
  main.innerHTML = `<div class="boot" role="status"><div class="spin" aria-hidden="true"></div><div class="t">Chargement des répliques…</div><div class="rail indet"><i></i></div><div class="m"></div>
    <p hidden>Premier lancement : plus de 33 000 répliques sont téléchargées une seule fois, puis l’app s’ouvre sans attendre, même hors ligne.</p></div>`;
  // l'explication n'apparaît que si l'attente dure (jamais de clignotement quand les répliques sortent du cache)
  setTimeout(() => { const p = document.querySelector('.boot p'); if (p) p.hidden = false; }, 1500);
  try {
    await loadData();
  } catch (e) {
    booting = false;
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
  sendAvis();
  buildIndexSoon();
}
const VIEWS = { citations: 1, quiz: 1, personnages: 1, recherche: 1, favoris: 1 };
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
  get allQuotes() { return allQuotes; },
  get quoteIdx() { return quoteIdx; }, set quoteIdx(v) { quoteIdx = v; },
  get verifyIdx() { return verifyIdx; },
  get avisFaits() { return avisFaits; },
  get avisFile() { return avisFile; },
  get quizState() { return quizState; },
  get favorites() { return favorites; },
  get player() { return player; },
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
  document.addEventListener('keydown', onArrowKeys);                         // flèches : réplique suivante / précédente
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });
  // réseau : « Hors ligne » dans l'en-tête ; au retour du réseau, envoi des avis en attente
  ['online', 'offline'].forEach(ev => window.addEventListener(ev, refreshMast));
  window.addEventListener('online', sendAvis);
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
  document.getElementById('mast-set').addEventListener('click', openSettings);
  boot();
});
