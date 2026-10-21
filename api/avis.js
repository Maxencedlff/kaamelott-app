// Avis de vérification (son / vidéo justes ou non) envoyés depuis l'app.
// Chaque lot est rangé dans le dépôt privé Maxencedlff/kaamelott-avis (avis/<jour>/<heure>-<hasard>.json),
// relu ensuite côté PC (kaam-audio/avis_lire.py) pour corriger les sons et vidéos.
// faits.json, dans le même dépôt : {i: empreinte} des répliques déjà vérifiées par quelqu'un (GET /api/avis), pour que
// chaque personne qui vérifie fasse avancer le travail de tous. L'empreinte (fpOf dans app.js) est celle du son et de la
// scène vérifiés : s'ils changent, la réplique revient à vérifier. Amorce et reconstruction : kaam-audio/avis_partage.py.
// coupes.json, même dépôt : {coupes: {i: {fp, ds, de}}, demandes: {i: 1}}. Une coupe réglée dans l'appli (« Ajuster la
// coupe ») décale début et fin de ds / de secondes ; la première fait foi (plus de nouvelle coupe ensuite). Une demande
// (« Coupe ratée, la refaire ») attend kaam-audio/coupes.py, qui finalise les coupes (fini: 1) et traite les demandes.
const { limiteur, adresse } = require('./_debit.js');
const REPO = 'Maxencedlff/kaamelott-avis';
// mêmes identifiants que PB_LISTS dans app.js
const PROBLEMES = new Set(['son_faux', 'son_debut_coupe', 'son_coupe', 'son_deborde_avant', 'son_deborde', 'son_generique', 'son_bruit',
  'son_absent', 'video_fausse', 'video_debut_coupe', 'video_coupee', 'video_deborde_avant', 'video_deborde', 'video_generique',
  'video_decalee', 'texte_faux', 'texte_perso']);

// décalages de début et de fin : la vidéo élargie a 3 s de chaque côté (kaam-audio/contexte.py)
const MAX_DECALAGE = 3.5;
function coupeValide(c) {
  if (!Array.isArray(c) || c.length !== 2 || !c.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_DECALAGE)) return null;
  return c.map(x => Math.round(x * 100) / 100);
}

// vidéo élargie de la réplique coupée [avant, durée, après] (q.cx) : la fenêtre de la coupe en est déduite et gardée avec
// elle, pour que api/extrait.js ne découpe que des coupes enregistrées (une par réplique)
const net2 = x => Math.round(x * 100) / 100;
function cxValide(c) {
  if (!Array.isArray(c) || c.length !== 3 || !c.every(x => typeof x === 'number' && Number.isFinite(x))) return null;
  return c[0] >= 0 && c[0] <= 5 && c[2] >= 0 && c[2] <= 5 && c[1] > 0 && c[1] <= 300 ? c.map(net2) : null;
}

const MAX_I = 40000;   // data.json a 33 187 entrées : marge pour les ajouts (l'index i ne change jamais)
// caractères de contrôle retirés (séquences de terminal dans les notes relues sur le PC)
const net = s => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
function propre(a, recu) {
  if (!a || typeof a !== 'object') return null;
  const i = Number.isInteger(a.i) ? a.i : null;
  if (i === null || i < 0 || i >= MAX_I) return null;
  return {
    i,
    quote: net(a.quote).slice(0, 400),
    name: net(a.name).slice(0, 80),
    audio: a.audio ? net(a.audio).slice(0, 120) : null,
    video: a.video ? net(a.video).slice(0, 40) : null,
    approx: !!a.approx,
    fp: typeof a.fp === 'string' && /^[0-9a-z]{1,8}$/.test(a.fp) ? a.fp : null,
    ok: !!a.ok,
    problemes: Array.isArray(a.problemes) ? a.problemes.filter(p => PROBLEMES.has(p)) : [],
    note: net(a.note).slice(0, 500),
    coupe: coupeValide(a.coupe),
    cx: cxValide(a.cx),
    vv: Number.isInteger(a.vv) && a.vv >= 0 && a.vv < 1000 ? a.vv : 0,
    demande: a.demande === 'recoupe' ? 'recoupe' : null,
    tc: Number.isFinite(+a.ts) ? +a.ts : null,   // heure de l'appareil, pour information
    ts: recu,                                     // heure du serveur : la seule qui fait foi (avis_lire.py garde le dernier par ts)
  };
}

// Seul le site lui-même peut envoyer des avis ; débit limité par adresse (par instance de la fonction)
const ORIGINES = new Set(['https://kaamelott-app.vercel.app']);
const MAX_PAR_HEURE = 30;     // 30 lots de 100 avis au plus : 3 000 avis/heure par personne, largement assez
const MAX_GLOBAL = 300;       // tous appareils confondus, par instance et par heure
const trop = limiteur(MAX_PAR_HEURE, MAX_GLOBAL);

const GH = { 'User-Agent': 'kaamelott-app', Accept: 'application/vnd.github+json' };
const URL_DEPOT = f => `https://api.github.com/repos/${REPO}/contents/${f}`;
async function lire(token, f, vide) {
  const r = await fetch(URL_DEPOT(f), { headers: { ...GH, Authorization: `token ${token}` } });
  if (r.status === 404) return { val: vide(), sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  // au-delà de 1 Mo, GitHub renvoie le sha mais pas le contenu (encoding « none ») : contenu brut lu à part. Jamais un
  // fichier non vide lu comme vide (il serait réécrit avec les seules nouvelles entrées, tout le reste effacé)
  let texte = j.encoding === 'base64' ? Buffer.from(j.content || '', 'base64').toString('utf8') : null;
  if (texte === null || (!texte && j.size > 0)) {
    const b = await fetch(URL_DEPOT(f), { headers: { ...GH, Accept: 'application/vnd.github.raw+json', Authorization: `token ${token}` } });
    if (!b.ok) throw new Error(`GitHub ${b.status}`);
    texte = await b.text();
    if (!texte && j.size > 0) throw new Error(`${f} : contenu illisible`);
  }
  return { val: JSON.parse(texte || 'null') || vide(), sha: j.sha };
}
const videCoupes = () => ({ coupes: {}, demandes: {} });
// lit le fichier, applique change(val) (nombre de modifications), réécrit ; deux envois en même temps : GitHub refuse
// le second (409), qui relit et réessaie
async function modifier(token, f, vide, change, message) {
  for (let essai = 0; essai < 4; essai++) {
    const { val, sha } = await lire(token, f, vide);
    const n = change(val);
    if (!n) return;
    const r = await fetch(URL_DEPOT(f), { method: 'PUT', headers: { ...GH, Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message(n), content: Buffer.from(JSON.stringify(val)).toString('base64'), ...(sha ? { sha } : {}) }) });
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub ${r.status}`);
    await new Promise(ok => setTimeout(ok, 300 + Math.random() * 700));
  }
  throw new Error('GitHub : conflits répétés');
}
// avis du lot → faits.json (une demande de recoupe ne vaut pas vérification)
const ajouterFaits = (token, lot) => modifier(token, 'faits.json', () => ({}), faits => {
  let n = 0;
  for (const a of lot) if (a.fp && !a.demande && faits[a.i] !== a.fp) { faits[a.i] = a.fp; n++; }
  return n;
}, n => `faits : +${n}`);
// coupes et demandes du lot → coupes.json (la première coupe d'une réplique fait foi)
const ajouterCoupes = (token, lot) => modifier(token, 'coupes.json', videCoupes, v => {
  let n = 0;
  v.coupes ||= {}; v.demandes ||= {};
  for (const a of lot) {
    if (a.coupe && a.fp && !v.coupes[a.i] && !v.demandes[a.i]) {
      v.coupes[a.i] = { fp: a.fp, ds: a.coupe[0], de: a.coupe[1] };
      // de quoi fabriquer l'extrait coupé en ligne, tant que le PC ne l'a pas refait (api/extrait.js)
      if (a.cx && /^[0-9a-f]{12}$/.test(a.video || '')) Object.assign(v.coupes[a.i], { k: a.video, vv: a.vv, w: [net2(a.cx[0] + a.coupe[0]), net2(a.cx[0] + a.cx[1] + a.coupe[1])] });
      n++;
    }
    if (a.demande && !v.demandes[a.i]) { v.demandes[a.i] = 1; n++; }
  }
  return n;
}, n => `coupes : +${n}`);

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {          // déjà vérifiées par quelqu'un : mis en cache 1 min par Vercel, sans rien de personnel
    const token = process.env.KAAM_AVIS_TOKEN;
    if (!token) return res.status(500).json({ erreur: 'jeton absent' });
    try {
      const [{ val: faits }, { val: c }] = await Promise.all([lire(token, 'faits.json', () => ({})), lire(token, 'coupes.json', videCoupes)]);
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
      return res.status(200).json({ faits, coupes: c.coupes || {}, demandes: c.demandes || {} });
    } catch { return res.status(502).json({ erreur: 'GitHub injoignable' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET ou POST uniquement' });
  if (!ORIGINES.has(req.headers.origin || '')) return res.status(403).json({ erreur: 'origine refusée' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ erreur: 'JSON attendu' });
  if (trop(adresse(req))) return res.status(429).json({ erreur: 'trop d\'envois, réessayez plus tard' });
  const token = process.env.KAAM_AVIS_TOKEN;
  if (!token) return res.status(500).json({ erreur: 'jeton absent' });

  const recu = Date.now();
  const lot = (Array.isArray(req.body?.avis) ? req.body.avis : []).slice(0, 100).map(a => propre(a, recu)).filter(Boolean);
  if (!lot.length) return res.status(400).json({ erreur: 'aucun avis' });

  const now = new Date();
  const path = `avis/${now.toISOString().slice(0, 10)}/${now.toISOString().slice(11, 19).replace(/:/g, '')}-${Math.random().toString(36).slice(2, 8)}.json`;
  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'kaamelott-app' },
      body: JSON.stringify({
        message: `${lot.length} avis`,
        content: Buffer.from(JSON.stringify(lot, null, 1)).toString('base64'),
      }),
    });
  } catch {
    return res.status(502).json({ erreur: 'GitHub injoignable' });   // le client garde ses avis et réessaiera
  }
  if (!r.ok) return res.status(502).json({ erreur: `GitHub ${r.status}` });
  // avis rangés : le partage ne doit jamais faire échouer l'envoi (avis_partage.py sait reconstruire faits.json)
  try { await ajouterFaits(token, lot); } catch {}
  if (lot.some(a => a.coupe || a.demande)) {
    try { await ajouterCoupes(token, lot); } catch { return res.status(502).json({ erreur: 'coupe non enregistrée, réessayez' }); }
  }
  res.status(200).json({ recus: lot.length });
};

module.exports.lire = lire;
module.exports.videCoupes = videCoupes;
