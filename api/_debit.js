// Débit limité par adresse et au total, sur une heure glissante, par instance de la fonction (mémoire locale : une
// instance neuve repart de zéro, la limite freine un abus sans le rendre impossible). Fichier en « _ » : pas une route.
function limiteur(parAdresse, total) {
  const fenetres = new Map();   // ip → [horodatages de la dernière heure]
  let tous = [];
  return ip => {
    const now = Date.now();
    tous = tous.filter(x => now - x < 3600e3); tous.push(now);
    const t = (fenetres.get(ip) || []).filter(x => now - x < 3600e3);
    t.push(now); fenetres.set(ip, t);
    if (fenetres.size > 5000) fenetres.clear();
    return t.length > parAdresse || tous.length > total;
  };
}
// adresse du client telle que Vercel la donne (x-forwarded-for est réécrit par Vercel, pas falsifiable)
const adresse = req => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
module.exports = { limiteur, adresse };
