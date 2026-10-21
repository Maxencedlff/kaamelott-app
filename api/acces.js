// Saisie du code d'accès (écran « Code d'accès » d'app.js) : POST {code} → cookie kaam_acces (HttpOnly, 400 jours),
// vérifié ensuite par middleware.js. Essais limités par adresse : le code ne se devine pas en boucle.
const { COOKIE, normalise, jeton, egaux } = require('./_acces.js');
const { limiteur, adresse } = require('./_debit.js');

const ORIGINES = new Set(['https://kaamelott-app.vercel.app']);
const trop = limiteur(10, 500);       // 10 essais par heure et par adresse, 500 au total (par instance)
const DUREE = 400 * 86400;            // le maximum que les navigateurs gardent

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  if (!ORIGINES.has(req.headers.origin || '')) return res.status(403).json({ erreur: 'origine refusée' });
  if (trop(adresse(req))) return res.status(429).json({ erreur: 'trop d’essais, réessayez dans une heure' });
  const code = process.env.KAAM_ACCES_CODE, secret = process.env.KAAM_ACCES_SECRET;
  if (!code || !secret) return res.status(500).json({ erreur: 'code non configuré' });
  const essai = normalise(req.body && req.body.code);
  if (!essai || !egaux(await jeton(essai, secret), await jeton(code, secret))) return res.status(401).json({ erreur: 'code incorrect' });
  res.setHeader('Set-Cookie', `${COOKIE}=${await jeton(code, secret)}; Path=/; Max-Age=${DUREE}; HttpOnly; Secure; SameSite=Lax`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(204).end();
};
