// Extrait COUPÉ d'une réplique dont la coupe, réglée dans l'appli, attend encore kaam-audio/coupes.py (PC éteint) :
// le partage envoie ainsi tout de suite la version validée. Découpé à la volée dans la vidéo élargie publique
// (cx/ sur Hugging Face, kaam-audio/contexte.py), puis gardé par le cache de Vercel.
// GET /api/extrait?i=<réplique>&fp=<empreinte> : seule une coupe ENREGISTRÉE (coupes.json, écrit par api/avis.js, avec sa
// vidéo et sa fenêtre) et pas encore finie est découpée. Il n'existe donc qu'un extrait par réplique coupée (la première
// coupe fait foi) : impossible de faire réencoder le serveur à volonté avec des fenêtres inventées.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { lire, videCoupes } = require('./avis.js');
const { limiteur, adresse } = require('./_debit.js');

const CX = 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/cx/';
const MAX_FIN = 150;             // ±3 s autour de la plus longue réplique (monologue de César, 133 s), avec de la marge
const MAX_CX = 20e6;             // la plus longue vidéo élargie fait 1,5 Mo
const MIN_SORTIE = 2000;         // en dessous : fenêtre hors de la vidéo (MP4 vide), jamais servi ni gardé en cache
const MAX_PAR_HEURE = 60;        // par adresse et par instance : un partage = un appel (le cache sert les suivants)
const MAX_GLOBAL = 300;          // tous appareils confondus, par instance et par heure
const LECTURE_COUPES = 60e3;     // coupes.json relu au plus une fois par minute (sauf coupe introuvable : relu aussitôt)

// adresse canonique seulement (« i=12&fp=ab3 ») : une même coupe n'a qu'une adresse, donc qu'une entrée de cache
function demande(url) {
  const m = /^i=(0|[1-9]\d{0,4})&fp=([0-9a-z]{1,8})$/.exec(String(url || '').split('?')[1] || '');
  return m ? { i: +m[1], fp: m[2] } : null;
}
// fenêtre en centièmes entiers (3,30 − 3,10 vaut 0,2 et non 0,19999…)
function fenetreValide(w) {
  if (!Array.isArray(w) || w.length !== 2 || !w.every(Number.isFinite)) return false;
  const [a, b] = w.map(x => Math.round(x * 100));
  return a >= 0 && b <= MAX_FIN * 100 && b - a >= 20;
}

let coupes = null, luesA = 0;
async function coupe(token, i, fp, frais) {
  if (frais || !coupes || Date.now() - luesA > LECTURE_COUPES) {
    coupes = (await lire(token, 'coupes.json', videCoupes)).val.coupes || {}; luesA = Date.now();
  }
  const c = coupes[i];
  return c && c.fp === fp && !c.fini && /^[0-9a-f]{12}$/.test(c.k || '') && fenetreValide(c.w) ? c : null;
}

const trop = limiteur(MAX_PAR_HEURE, MAX_GLOBAL);

// réencodé (coupe précise à l'image près, pas seulement aux images clés), mêmes réglages que la vidéo élargie ;
// environnement vide : ffmpeg ne voit aucun secret de la fonction
function couper(src, dst, [a, b]) {
  const args = ['-v', 'error', '-y', '-ss', a.toFixed(2), '-to', b.toFixed(2), '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart', dst];
  return new Promise((ok, ko) => execFile(require('ffmpeg-static'), args, { timeout: 35000, env: {} }, e => e ? ko(e) : ok()));
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'GET uniquement' });
  const d = demande(req.url);
  if (!d) return res.status(400).json({ erreur: 'paramètres invalides' });
  if (trop(adresse(req))) return res.status(429).json({ erreur: 'trop de demandes, réessayez plus tard' });
  const token = process.env.KAAM_AVIS_TOKEN;
  if (!token) return res.status(500).json({ erreur: 'jeton absent' });
  let c;
  try { c = await coupe(token, d.i, d.fp, false) || await coupe(token, d.i, d.fp, true); }   // coupe envoyée à l'instant
  catch { return res.status(502).json({ erreur: 'GitHub injoignable' }); }
  if (!c) return res.status(404).json({ erreur: 'aucune coupe en attente pour cette réplique' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extrait-'));
  try {
    const r = await fetch(`${CX}${c.k.slice(0, 2)}/${c.k}.mp4?v=${c.vv || 1}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ erreur: 'vidéo élargie introuvable' });
    if (+r.headers.get('content-length') > MAX_CX) return res.status(502).json({ erreur: 'vidéo élargie trop lourde' });
    const src = path.join(dir, 'cx.mp4'), dst = path.join(dir, 'extrait.mp4');
    await fs.writeFile(src, Buffer.from(await r.arrayBuffer()));
    await module.exports.couper(src, dst, c.w);
    const out = await fs.readFile(dst);
    if (out.length < MIN_SORTIE) return res.status(502).json({ erreur: 'découpe vide' });
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
    return res.status(200).send(out);
  } catch {
    return res.status(502).json({ erreur: 'découpe impossible' });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = handler;
module.exports.demande = demande;
module.exports.fenetreValide = fenetreValide;
module.exports.couper = couper;   // remplaçable dans les tests (aucun ffmpeg en CI)
module.exports.oublie = () => { coupes = null; };   // tests : coupes.json relu à chaque appel
