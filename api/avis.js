// Avis de vérification (son / vidéo justes ou non) envoyés depuis l'app.
// Chaque lot est rangé dans le dépôt privé Maxencedlff/kaamelott-avis (avis/<jour>/<heure>-<hasard>.json),
// relu ensuite côté PC (kaam-audio/avis_lire.py) pour corriger les sons et vidéos.
const REPO = 'Maxencedlff/kaamelott-avis';
// mêmes identifiants que PB_LISTS dans app.js
const PROBLEMES = new Set(['son_faux', 'son_debut_coupe', 'son_coupe', 'son_deborde_avant', 'son_deborde', 'son_generique', 'son_bruit',
  'son_absent', 'video_fausse', 'video_debut_coupe', 'video_coupee', 'video_deborde_avant', 'video_deborde', 'video_generique',
  'video_decalee', 'texte_faux', 'texte_perso']);

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
    ok: !!a.ok,
    problemes: Array.isArray(a.problemes) ? a.problemes.filter(p => PROBLEMES.has(p)) : [],
    note: net(a.note).slice(0, 500),
    tc: Number.isFinite(+a.ts) ? +a.ts : null,   // heure de l'appareil, pour information
    ts: recu,                                     // heure du serveur : la seule qui fait foi (avis_lire.py garde le dernier par ts)
  };
}

// Seul le site lui-même peut envoyer des avis ; débit limité par adresse (par instance de la fonction)
const ORIGINES = new Set(['https://kaamelott-app.vercel.app']);
const fenetres = new Map();   // ip → [horodatages des envois de la dernière heure]
const MAX_PAR_HEURE = 30;     // 30 lots de 100 avis au plus : 3 000 avis/heure par personne, largement assez
const MAX_GLOBAL = 300;       // tous appareils confondus, par instance et par heure
let global = [];
function tropGlobal() {
  const now = Date.now();
  global = global.filter(x => now - x < 3600e3);
  global.push(now);
  return global.length > MAX_GLOBAL;
}
function tropRapide(ip) {
  const now = Date.now();
  const t = (fenetres.get(ip) || []).filter(x => now - x < 3600e3);
  t.push(now); fenetres.set(ip, t);
  if (fenetres.size > 5000) fenetres.clear();
  return t.length > MAX_PAR_HEURE;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  if (!ORIGINES.has(req.headers.origin || '')) return res.status(403).json({ erreur: 'origine refusée' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ erreur: 'JSON attendu' });
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (tropRapide(ip) || tropGlobal()) return res.status(429).json({ erreur: 'trop d\'envois, réessayez plus tard' });
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
  res.status(200).json({ recus: lot.length });
};
