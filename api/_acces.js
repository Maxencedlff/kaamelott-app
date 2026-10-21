// Code d'accès à l'appli, partagé entre middleware.js (contrôle à l'entrée, Edge) et api/acces.js (saisie du code).
// Le cookie kaam_acces porte un HMAC du code (clé KAAM_ACCES_SECRET) : jamais le code lui-même, et changer le code
// (KAAM_ACCES_CODE sur Vercel) déconnecte tout le monde. WebCrypto : même code sur Edge et sous Node.
const COOKIE = 'kaam_acces';
// saisie tolérante : casse, accents, espaces et tirets ignorés (« Cul-de-Chouette » = « culdechouette »)
const normalise = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function hmac(secret, texte) {
  const enc = new TextEncoder();
  const cle = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cle, enc.encode(texte)));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}
const jeton = (code, secret) => hmac(secret, `acces:${normalise(code)}`);
// Comptes de l'appli (même code pour tous) : un prénom par téléphone, choisi à la première ouverture (api/acces.js). Le
// cookie kaam_compte porte l'identifiant (« timothee ») et son HMAC : un prénom ne se fabrique pas sans le secret.
const COMPTES = ['Anselme', 'Maxence', 'Timothée', 'Wandrille'];
const idCompte = nom => normalise(nom);
const jetonCompte = (id, secret) => hmac(secret, `compte:${id}`);
async function compteDe(entete, env) {
  const m = /(?:^|;\s*)kaam_compte=([a-z]{1,20})\.([0-9a-f]{64})(?:;|$)/.exec(entete || '');
  if (!m || !env.KAAM_ACCES_SECRET) return null;
  const nom = COMPTES.find(n => idCompte(n) === m[1]);
  return nom && egaux(m[2], await jetonCompte(m[1], env.KAAM_ACCES_SECRET)) ? nom : null;
}
const cookieDe = entete => (/(?:^|;\s*)kaam_acces=([0-9a-f]{64})(?:;|$)/.exec(entete || '') || [])[1] || '';
// comparaison en temps constant (même longueur : 64 caractères hexadécimaux)
function egaux(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// accès autorisé ? Code non configuré : ouvert (jamais un site bloqué par une variable oubliée)
async function autorise(entete, env) {
  if (!env.KAAM_ACCES_CODE || !env.KAAM_ACCES_SECRET) return true;
  const j = cookieDe(entete);
  return !!j && egaux(j, await jeton(env.KAAM_ACCES_CODE, env.KAAM_ACCES_SECRET));
}
module.exports = { COOKIE, normalise, jeton, cookieDe, egaux, autorise, COMPTES, idCompte, jetonCompte, compteDe };
