// Extrait COUPÉ d'une réplique dont la coupe, réglée dans l'appli, attend encore kaam-audio/coupes.py (PC éteint) :
// le partage envoie ainsi tout de suite la version validée. Découpé à la volée dans la vidéo élargie publique
// (cx/ sur Hugging Face, kaam-audio/contexte.py), puis gardé par le cache de Vercel : une adresse = un extrait.
// GET /api/extrait?k=<vidéo>&v=<vv>&a=<début>&b=<fin>, début et fin en secondes dans la vidéo élargie (fenetre() d'app.js).
// Rien de secret : la vidéo élargie est publique, et ne peut sortir qu'un morceau de 0,2 à 150 s.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const CX = 'https://huggingface.co/datasets/Maxencedlf/kaamelott-videos/resolve/main/cx/';
const MAX_FIN = 150;         // ±3 s autour de la plus longue réplique (monologue de César, 133 s), avec de la marge
const MAX_PAR_HEURE = 60;    // par adresse et par instance : un partage = un appel (le cache sert les suivants)

function demande(q) {
  const k = String(q.k || ''), v = Number(q.v || 1), a = Number(q.a), b = Number(q.b);
  if (!/^[0-9a-f]{12}$/.test(k) || !Number.isInteger(v) || v < 1 || v > 999) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > MAX_FIN || b - a < 0.2) return null;
  return { k, v, a: Math.round(a * 100) / 100, b: Math.round(b * 100) / 100 };
}

const fenetres = new Map();   // ip → [horodatages de la dernière heure]
function tropRapide(ip) {
  const now = Date.now();
  const t = (fenetres.get(ip) || []).filter(x => now - x < 3600e3);
  t.push(now); fenetres.set(ip, t);
  if (fenetres.size > 5000) fenetres.clear();
  return t.length > MAX_PAR_HEURE;
}

// réencodé (coupe précise à l'image près, pas seulement aux images clés), mêmes réglages que la vidéo élargie
function couper(src, dst, { a, b }) {
  const args = ['-v', 'error', '-y', '-ss', String(a), '-to', String(b), '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart', dst];
  return new Promise((ok, ko) => execFile(require('ffmpeg-static'), args, { timeout: 50000 }, e => e ? ko(e) : ok()));
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'GET uniquement' });
  const d = demande(req.query || {});
  if (!d) return res.status(400).json({ erreur: 'paramètres invalides' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (tropRapide(ip)) return res.status(429).json({ erreur: 'trop de demandes, réessayez plus tard' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extrait-'));
  try {
    const r = await fetch(`${CX}${d.k.slice(0, 2)}/${d.k}.mp4?v=${d.v}`);
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ erreur: 'vidéo élargie introuvable' });
    const src = path.join(dir, 'cx.mp4'), dst = path.join(dir, 'extrait.mp4');
    await fs.writeFile(src, Buffer.from(await r.arrayBuffer()));
    await module.exports.couper(src, dst, d);
    const out = await fs.readFile(dst);
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
module.exports.couper = couper;   // remplaçable dans les tests (aucun ffmpeg en CI)
