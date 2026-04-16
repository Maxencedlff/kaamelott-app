'use strict';

// ===== STATE =====
let allQuotes = [];       // parsed quotes
let favorites = [];       // saved quotes
let currentView = 'citations';
let currentQuote = null;
let quoteIdx = 0;
let quizState = null;
let detailChar = null;

// ===== PARSE DATA =====
function parseQuote(item) {
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

  return { quote: item.quote, name, livre, episode, title };
}

async function loadData() {
  const res  = await fetch('data.json');
  const raw  = await res.json();
  allQuotes  = raw.map(parseQuote).filter(q => q.quote && q.name);
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
// ===== CHARACTER IMAGES =====
const CHAR_WIKI = {
  'ARTHUR':         'Alexandre_Astier',
  'PERCEVAL':       'Franck_Pitiot',
  'LÉODAGAN':       'Lionnel_Astier',
  'LANCELOT':       'Thomas_Cousseau',
  'GUENIÈVRE':      'Audrey_Fleurot',
  'KARADOC':        'Jean-Christophe_Hembert',
  'SÉLI':           'Joëlle_Sevilla',
  'MERLIN':         'Jacques_Chambon',
  'PÈRE BLAISE':    'Jean-Robert_Lombard',
  'GAUVAIN':        'Simon_Astier',
  'LA DAME DU LAC': 'Anne_Girouard',
  'BOHORT':         'Nicolas_Gabion',
  'YVAIN':          'Guilhem_Pellegri',
};

const imgCache = {};

async function fetchCharImage(name) {
  if (imgCache[name] !== undefined) return imgCache[name];
  const stored = localStorage.getItem(`kaam_img_${name}`);
  if (stored) { imgCache[name] = stored; return stored; }
  const wiki = CHAR_WIKI[name];
  if (!wiki) { imgCache[name] = null; return null; }
  try {
    const r = await fetch(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wiki)}`);
    if (!r.ok) { imgCache[name] = null; return null; }
    const d = await r.json();
    const url = d.thumbnail?.source || null;
    imgCache[name] = url;
    if (url) { try { localStorage.setItem(`kaam_img_${name}`, url); } catch {} }
    return url;
  } catch { imgCache[name] = null; return null; }
}

async function loadAvatars() {
  const els = document.querySelectorAll('[data-name]');
  for (const el of els) {
    const name = el.dataset.name;
    const url = await fetchCharImage(name);
    if (url && !el.querySelector('img')) {
      el.innerHTML = `<img src="${url}" alt="${esc(name)}">`;
      el.classList.add('has-img');
    }
  }
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

  const q = allQuotes[quoteIdx];
  currentQuote = q;
  const favActive = isFav(q);
  const ep = fmtEp(q);

  main.innerHTML = `
    <div class="citations-view">
      <div class="quote-counter">${quoteIdx + 1} / ${allQuotes.length}</div>

      <div class="quote-card" id="quote-card">
        <div class="quote-card-line-top"></div>
        <div class="quote-card-line-bottom"></div>
        <div class="quote-mark">"</div>
        <div class="quote-text">${esc(q.quote)}</div>
        <div class="quote-char">
          <div class="char-avatar" data-name="${esc(q.name)}">${esc(q.name.charAt(0))}</div>
          <div class="quote-char-name">${esc(q.name)}</div>
          ${ep ? `<div class="quote-char-ep">${esc(ep)}</div>` : ''}
        </div>
      </div>

      <div class="quote-actions">
        <button class="quote-action-btn" id="btn-prev" title="Précédente">◀</button>
        <button class="quote-action-btn ${favActive ? 'active' : ''}" id="btn-fav" title="Favoris">❤️</button>
        <button class="quote-action-btn" id="btn-random" title="Aléatoire">🎲</button>
        <button class="quote-action-btn" id="btn-share" title="Partager">📤</button>
        <button class="quote-action-btn" id="btn-next" title="Suivante">▶</button>
      </div>
      <div class="quote-hint">Swipe ou appuyez sur la carte pour une réplique aléatoire</div>
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

  const card = document.getElementById('quote-card');
  card.addEventListener('click', () => randomQuote());

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
      randomQuote();
    }
    swiping = false;
  }, { passive: true });
}

function nextQuote() {
  quoteIdx = (quoteIdx + 1) % allQuotes.length;
  renderCitations();
}
function prevQuote() {
  quoteIdx = (quoteIdx - 1 + allQuotes.length) % allQuotes.length;
  renderCitations();
}
function randomQuote() {
  quoteIdx = Math.floor(Math.random() * allQuotes.length);
  renderCitations();
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
            <div class="quiz-choice-avatar" data-name="${esc(c)}">${esc(c.charAt(0))}</div>
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
      <div class="perso-avatar detail-avatar" data-name="${esc(name)}">${esc(name.charAt(0))}</div>
      <span class="detail-header-title">${esc(name)}</span>
      <span class="detail-count">${quotes.length} répliques</span>
    </div>
    <div class="perso-quotes-list">
      ${quotes.map((q, i) => `
        <div class="perso-quote-item" data-idx="${i}">
          <button class="perso-quote-fav ${isFav(q) ? 'active' : ''}" data-idx="${i}">❤️</button>
          <div class="perso-quote-text">"${esc(q.quote)}"</div>
          ${fmtEp(q) ? `<div class="perso-quote-ep">${esc(fmtEp(q))}</div>` : ''}
        </div>`).join('')}
    </div>`;

  loadAvatars();
  document.getElementById('detail-back').addEventListener('click', () => {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
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
        <div class="search-result-char">${esc(x.name)}</div>
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
            <div class="fav-item-char">${esc(q.name)}</div>
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

// ===== QUOTE MODAL (from search/fav) =====
function showQuoteModal(q) {
  const overlay = document.getElementById('detail-overlay');
  overlay.classList.remove('hidden');
  overlay.scrollTop = 0;
  const ep = fmtEp(q);

  overlay.innerHTML = `
    <div class="detail-header">
      <button class="detail-back" id="detail-back">&#8592;</button>
      <div class="perso-avatar detail-avatar" data-name="${esc(q.name)}">${esc(q.name.charAt(0))}</div>
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
      <div style="margin-top:32px;display:flex;gap:12px;justify-content:center;">
        <button id="modal-share" style="background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:12px 24px;border-radius:4px;font-size:13px;cursor:pointer;">📤 Partager</button>
        <button id="modal-perso" style="background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:12px 24px;border-radius:4px;font-size:13px;cursor:pointer;">👑 ${esc(q.name)}</button>
      </div>
    </div>`;

  loadAvatars();
  document.getElementById('detail-back').addEventListener('click', () => {
    overlay.classList.add('hidden'); overlay.innerHTML = '';
  });
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
    // Shuffle pour commencer sur une citation aléatoire
    quoteIdx = Math.floor(Math.random() * allQuotes.length);
    renderCitations();
    bindNav();
  } catch (e) {
    document.getElementById('main-content').innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text3);">
        <p style="font-family:Georgia,serif;font-style:italic;">Erreur de chargement des données.</p>
      </div>`;
  }
});
