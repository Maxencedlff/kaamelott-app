// ES5 volontairement : doit tourner sur les plus vieux Safari pour dire pourquoi l'app ne s'ouvre pas
// Minimum : iOS 15 (la page utilise aspect-ratio, Safari 15). En dessous, app.js peut s'exécuter mais les scènes et les
// affiches tomberaient à 0 px de haut sans rien dire : on le détecte ici et on le dit.
// Chargé juste après l'écran de lancement (#launch), avant le reste de la page.
(function () {
  // L'image de lancement d'iOS est centrée sur l'écran entier. Si la vue web commence sous la barre d'état (style « default »),
  // on recentre le K sur l'écran, pas sur la vue : il ne bouge pas d'un pixel au passage image → page.
  if (navigator.standalone) {
    var off = screen.height - innerHeight;
    if (off > 0 && off < 80) document.documentElement.style.setProperty('--kc', (screen.height / 2 - off) + 'px');
  }
  var vieux = !(window.CSS && CSS.supports && CSS.supports('aspect-ratio', '1'));
  if (vieux) window.__kaamVieux = 1;                     // app.js ne démarre pas (boot) : le message reste seul à l'écran
  function msg() {
    if (window.__kaamOK && !vieux) return;
    var l = document.getElementById('launch');
    if (l && l.parentNode) l.parentNode.removeChild(l);   // sinon le message resterait caché sous le noir
    document.documentElement.className = document.documentElement.className.replace(/\blaunching\b/, '');
    document.documentElement.style.background = '';
    var cs = document.getElementById('meta-cs'); if (cs) cs.setAttribute('content', 'light dark');
    var b = document.querySelector('.boot');
    if (b) {
      b.innerHTML = '<div class="t">Cet appareil est trop ancien pour l’app.</div>'
        + '<p>Il faut iOS 15 ou plus récent (Réglages › Général › Mise à jour logicielle).</p>';
    }
  }
  window.addEventListener('error', function (e) { if (/app\.js/.test(e.filename || '')) msg(); });
  if (vieux) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', msg); else msg(); }
  else setTimeout(msg, 15000);
})();
