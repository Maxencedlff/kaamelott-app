// Avis de vérification (son / vidéo justes ou non) envoyés depuis l'app.
// Chaque lot est rangé dans le dépôt privé Maxencedlff/kaamelott-avis (avis/<jour>/<heure>-<hasard>.json),
// relu ensuite côté PC (kaam-audio/avis_lire.py) pour corriger les sons et vidéos.
const REPO = 'Maxencedlff/kaamelott-avis';
const PROBLEMES = new Set(['son_faux', 'son_coupe', 'son_deborde', 'video_fausse', 'video_coupee', 'texte_faux']);

function propre(a) {
  if (!a || typeof a !== 'object') return null;
  const i = Number.isInteger(a.i) ? a.i : null;
  if (i === null || i < 0 || i > 100000) return null;
  return {
    i,
    quote: String(a.quote || '').slice(0, 400),
    name: String(a.name || '').slice(0, 80),
    audio: a.audio ? String(a.audio).slice(0, 120) : null,
    video: a.video ? String(a.video).slice(0, 40) : null,
    approx: !!a.approx,
    ok: !!a.ok,
    problemes: Array.isArray(a.problemes) ? a.problemes.filter(p => PROBLEMES.has(p)) : [],
    note: String(a.note || '').slice(0, 500),
    ts: Number(a.ts) || Date.now(),
  };
}

// Seul le site lui-même peut envoyer des avis ; débit limité par adresse (par instance de la fonction)
const ORIGINES = new Set(['https://kaamelott-app.vercel.app']);
const fenetres = new Map();   // ip → [horodatages des envois de la dernière heure]
const MAX_PAR_HEURE = 60;     // un lot = 5 avis ou plus : ~300 avis/heure par personne, largement assez
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
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (tropRapide(ip)) return res.status(429).json({ erreur: 'trop d\'envois, réessayez plus tard' });
  const token = process.env.KAAM_AVIS_TOKEN;
  if (!token) return res.status(500).json({ erreur: 'jeton absent' });

  const lot = (Array.isArray(req.body?.avis) ? req.body.avis : []).slice(0, 300).map(propre).filter(Boolean);
  if (!lot.length) return res.status(400).json({ erreur: 'aucun avis' });

  const now = new Date();
  const path = `avis/${now.toISOString().slice(0, 10)}/${now.toISOString().slice(11, 19).replace(/:/g, '')}-${Math.random().toString(36).slice(2, 8)}.json`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'kaamelott-app' },
    body: JSON.stringify({
      message: `${lot.length} avis`,
      content: Buffer.from(JSON.stringify(lot, null, 1)).toString('base64'),
    }),
  });
  if (!r.ok) return res.status(502).json({ erreur: `GitHub ${r.status}` });
  res.status(200).json({ recus: lot.length });
};
