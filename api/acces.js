// Code d'accès et comptes (écran « Qui es-tu ? » d'app.js).
// GET  → { comptes: [{ nom, pris }], moi } : les prénoms déjà pris sont grisés ; moi = le compte de ce téléphone (cookie).
// POST { code, compte } → cookies kaam_acces (vérifié par middleware.js) et kaam_compte (HttpOnly, 400 jours). Un prénom
// déjà pris par un autre téléphone est refusé (409) ; le reprendre depuis le même téléphone est permis.
// POST { code, creation } → nouveau profil : code de création (KAAM_CREATION_CODE, distinct du code d'accès), prénom libre
// encore inconnu (409 sinon), mêmes cookies. Prénoms pris et profils créés : comptes.json du dépôt privé kaamelott-avis
// ({ id: { pris, nom? } }), à éditer pour en libérer ou en retirer un. Essais limités par adresse.
const { COOKIE, normalise, jeton, egaux, COMPTES, idCompte, jetonCompte, idDe, compteDe, tousLesComptes, prenomValide } = require('./_acces.js');
const { limiteur, adresse } = require('./_debit.js');
const { lire, modifier } = require('./avis.js');

const ORIGINES = new Set(['https://kaamelott-app.vercel.app']);
const trop = limiteur(10, 500);       // 10 essais par heure et par adresse, 500 au total (par instance)
const DUREE = 400 * 86400;            // le maximum que les navigateurs gardent
const MAX_CREES = 50;                 // profils créés au plus : comptes.json et l'écran restent petits
const cookie = (nom, val) => `${nom}=${val}; Path=/; Max-Age=${DUREE}; HttpOnly; Secure; SameSite=Lax`;
// un téléphone n'a qu'un compte : en passer à un autre libère le prénom d'avant (un des 4 premiers ; un profil créé reste,
// à retirer à la main). Sinon ce prénom resterait « pris » par un téléphone qui ne l'a plus.
function liberer(v, ancien, nouveau) {
  if (!ancien || ancien === nouveau || !v[ancien] || v[ancien].nom) return 0;
  delete v[ancien]; return 1;
}
const codeEgal = async (essai, attendu, secret) => !!essai && egaux(await jeton(essai, secret), await jeton(attendu, secret));

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.KAAM_AVIS_TOKEN, code = process.env.KAAM_ACCES_CODE, secret = process.env.KAAM_ACCES_SECRET;
  if (req.method === 'GET') {
    if (!token) return res.status(500).json({ erreur: 'jeton absent' });
    try {
      const { val: pris } = await lire(token, 'comptes.json', () => ({}));
      const noms = tousLesComptes(pris), moi = await compteDe(req.headers.cookie, process.env, noms);
      return res.status(200).json({ comptes: noms.map(nom => ({ nom, pris: !!pris[idCompte(nom)] && nom !== moi })), moi });
    } catch { return res.status(502).json({ erreur: 'GitHub injoignable' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET ou POST uniquement' });
  if (!ORIGINES.has(req.headers.origin || '')) return res.status(403).json({ erreur: 'origine refusée' });
  if (trop(adresse(req))) return res.status(429).json({ erreur: 'trop d’essais, réessayez dans une heure' });
  if (!code || !secret) return res.status(500).json({ erreur: 'code non configuré' });
  const b = req.body || {}, essai = normalise(b.code);
  const acces = cookie(COOKIE, await jeton(code, secret));
  const entrer = (nom) => jetonCompte(idCompte(nom), secret).then(j => {
    res.setHeader('Set-Cookie', [acces, cookie('kaam_compte', `${idCompte(nom)}.${j}`)]);
    return res.status(200).json({ compte: nom });
  });

  const monId = await idDe(req.headers.cookie, process.env);
  if (b.creation !== undefined) {                              // nouveau profil
    const creation = process.env.KAAM_CREATION_CODE;
    if (!creation) return res.status(500).json({ erreur: 'création de profil non configurée' });
    if (!await codeEgal(essai, creation, secret)) return res.status(401).json({ erreur: 'code incorrect' });
    const nom = prenomValide(b.creation);
    if (!nom) return res.status(400).json({ erreur: 'prénom invalide' });
    if (!token) return res.status(500).json({ erreur: 'jeton absent' });
    const id = idCompte(nom);
    let refus = null;
    try {
      await modifier(token, 'comptes.json', () => ({}), v => {
        if (v[id] || COMPTES.some(n => idCompte(n) === id)) { refus = [409, `${nom} existe déjà`]; return 0; }
        if (Object.values(v).filter(x => x && x.nom).length >= MAX_CREES) { refus = [403, 'plus de place pour un profil']; return 0; }
        v[id] = { pris: Date.now(), nom }; return 1 + liberer(v, monId, id);
      }, () => `profil créé : ${nom}`);
    } catch { return res.status(502).json({ erreur: 'GitHub injoignable, réessayez' }); }
    if (refus) return res.status(refus[0]).json({ erreur: refus[1] });
    return entrer(nom);
  }

  if (!await codeEgal(essai, code, secret)) return res.status(401).json({ erreur: 'code incorrect' });
  if (b.compte === undefined) { res.setHeader('Set-Cookie', acces); return res.status(204).end(); }
  if (!token) return res.status(500).json({ erreur: 'jeton absent' });
  let pris = false, nom = null;
  try {
    await modifier(token, 'comptes.json', () => ({}), v => {
      nom = tousLesComptes(v).find(n => idCompte(n) === normalise(b.compte)) || null;
      if (!nom) return 0;
      const id = idCompte(nom);
      if (v[id] && monId !== id) { pris = true; return 0; }
      if (v[id]) return 0;                                     // déjà à ce téléphone : rien à écrire
      v[id] = { pris: Date.now() }; return 1 + liberer(v, monId, id);
    }, () => `compte : ${nom}`);
  } catch { return res.status(502).json({ erreur: 'GitHub injoignable, réessayez' }); }
  if (!nom) return res.status(400).json({ erreur: 'compte inconnu' });
  if (pris) return res.status(409).json({ erreur: `${nom} est déjà pris` });
  return entrer(nom);
};
