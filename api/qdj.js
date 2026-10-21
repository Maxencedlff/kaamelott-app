// Question du jour entre amis : chaque compte y répond une fois par jour, tout le monde voit qui a répondu et s'il avait
// juste (jamais la réponse choisie : ce serait la donner à ceux qui n'ont pas joué).
// GET  ?d=AAAA-MM-JJ → { resultats: { Prénom: { ok } } }
// POST { d, i, pick, ok } → enregistré pour le compte du cookie kaam_compte, une seule fois (409 ensuite) ; même dépôt
// privé que les avis : qdj/<jour>.json. Accès : code (middleware.js) et compte (cookie signé).
const { compteDe } = require('./_acces.js');
const { lire, modifier } = require('./avis.js');

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
// jour accepté : celui du téléphone, à un jour près de l'heure du serveur (fuseaux, minuit)
const proche = d => JOUR.test(d) && Math.abs(Date.parse(d + 'T12:00:00Z') - Date.now()) < 2 * 86400e3;
const public_ = v => Object.fromEntries(Object.entries(v).map(([nom, r]) => [nom, { ok: !!r.ok }]));

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.KAAM_AVIS_TOKEN;
  if (!token) return res.status(500).json({ erreur: 'jeton absent' });
  const d = String((req.method === 'GET' ? req.query?.d : req.body?.d) || '');
  if (!proche(d)) return res.status(400).json({ erreur: 'jour invalide' });
  const f = `qdj/${d}.json`;
  if (req.method === 'GET') {
    try { return res.status(200).json({ resultats: public_((await lire(token, f, () => ({}))).val) }); }
    catch { return res.status(502).json({ erreur: 'GitHub injoignable' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET ou POST uniquement' });
  const nom = await compteDe(req.headers.cookie, process.env);
  if (!nom) return res.status(401).json({ erreur: 'aucun compte sur ce téléphone' });
  const b = req.body || {};
  let deja = false, apres = {};
  try {
    await modifier(token, f, () => ({}), v => {
      apres = v;
      if (v[nom]) { deja = true; return 0; }                   // une seule réponse par jour, la première fait foi
      v[nom] = { ok: !!b.ok, pick: String(b.pick || '').slice(0, 60), i: Number.isInteger(b.i) ? b.i : null, ts: Date.now() };
      return 1;
    }, () => `question du jour ${d} : ${nom}`);
  } catch { return res.status(502).json({ erreur: 'GitHub injoignable, réessayez' }); }
  return res.status(deja ? 409 : 200).json({ resultats: public_(apres) });
};
