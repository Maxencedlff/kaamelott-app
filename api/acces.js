// Code d'accès et comptes (écran « Qui es-tu ? » d'app.js).
// GET  → { comptes: [{ nom, pris }], moi } : les prénoms déjà pris sont grisés ; moi = le compte de ce téléphone (cookie).
// POST { code, compte } → cookies kaam_acces (vérifié par middleware.js) et kaam_compte (HttpOnly, 400 jours). Un prénom
// déjà pris par un autre téléphone est refusé (409) ; le reprendre depuis le même téléphone est permis. Prénoms pris :
// comptes.json du dépôt privé kaamelott-avis ({ id: { pris } }), à éditer pour en libérer un. Essais limités par adresse.
const { COOKIE, normalise, jeton, egaux, COMPTES, idCompte, jetonCompte, compteDe } = require('./_acces.js');
const { limiteur, adresse } = require('./_debit.js');
const { lire, modifier } = require('./avis.js');

const ORIGINES = new Set(['https://kaamelott-app.vercel.app']);
const trop = limiteur(10, 500);       // 10 essais par heure et par adresse, 500 au total (par instance)
const DUREE = 400 * 86400;            // le maximum que les navigateurs gardent
const cookie = (nom, val) => `${nom}=${val}; Path=/; Max-Age=${DUREE}; HttpOnly; Secure; SameSite=Lax`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.KAAM_AVIS_TOKEN, code = process.env.KAAM_ACCES_CODE, secret = process.env.KAAM_ACCES_SECRET;
  if (req.method === 'GET') {
    if (!token) return res.status(500).json({ erreur: 'jeton absent' });
    try {
      const { val: pris } = await lire(token, 'comptes.json', () => ({}));
      const moi = await compteDe(req.headers.cookie, process.env);
      return res.status(200).json({ comptes: COMPTES.map(nom => ({ nom, pris: !!pris[idCompte(nom)] && nom !== moi })), moi });
    } catch { return res.status(502).json({ erreur: 'GitHub injoignable' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET ou POST uniquement' });
  if (!ORIGINES.has(req.headers.origin || '')) return res.status(403).json({ erreur: 'origine refusée' });
  if (trop(adresse(req))) return res.status(429).json({ erreur: 'trop d’essais, réessayez dans une heure' });
  if (!code || !secret) return res.status(500).json({ erreur: 'code non configuré' });
  const essai = normalise(req.body && req.body.code);
  if (!essai || !egaux(await jeton(essai, secret), await jeton(code, secret))) return res.status(401).json({ erreur: 'code incorrect' });
  const cookies = [cookie(COOKIE, await jeton(code, secret))];
  const demande = req.body && req.body.compte;
  if (demande !== undefined) {
    const nom = COMPTES.find(n => idCompte(n) === normalise(demande));
    if (!nom) return res.status(400).json({ erreur: 'compte inconnu' });
    if (!token) return res.status(500).json({ erreur: 'jeton absent' });
    const id = idCompte(nom), moi = await compteDe(req.headers.cookie, process.env);
    let pris = false;
    try {
      await modifier(token, 'comptes.json', () => ({}), v => {
        if (v[id] && moi !== nom) { pris = true; return 0; }
        if (v[id]) return 0;                                   // déjà à ce téléphone : rien à écrire
        v[id] = { pris: Date.now() }; return 1;
      }, () => `compte : ${nom}`);
    } catch { return res.status(502).json({ erreur: 'GitHub injoignable, réessayez' }); }
    if (pris) return res.status(409).json({ erreur: `${nom} est déjà pris` });
    cookies.push(cookie('kaam_compte', `${id}.${await jetonCompte(id, secret)}`));
    res.setHeader('Set-Cookie', cookies);
    return res.status(200).json({ compte: nom });
  }
  res.setHeader('Set-Cookie', cookies[0]);
  return res.status(204).end();
};
