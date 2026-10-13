// ES5 volontairement : doit tourner sur les plus vieux Safari pour dire pourquoi l'app ne s'ouvre pas
// (app.js demande iOS 13.4 ou plus récent ; en dessous, il ne s'exécute pas du tout et l'écran resterait sur le lancement).
// Chargé juste après l'écran de lancement (#launch), avant le reste de la page.
(function () {
  // L'image de lancement d'iOS est centrée sur l'écran entier. Si la vue web commence sous la barre d'état (style « default »),
  // on recentre le K sur l'écran, pas sur la vue : il ne bouge pas d'un pixel au passage image → page.
  if (navigator.standalone) {
    var off = screen.height - innerHeight;
    if (off > 0 && off < 80) document.documentElement.style.setProperty('--kc', (screen.height / 2 - off) + 'px');
  }
  function msg() {
    if (window.__kaamOK) return;
    var l = document.getElementById('launch');
    if (l && l.parentNode) l.parentNode.removeChild(l);   // sinon le message resterait caché sous le noir
    document.documentElement.className = document.documentElement.className.replace(/\blaunching\b/, '');
    document.documentElement.style.background = '';
    var cs = document.getElementById('meta-cs'); if (cs) cs.setAttribute('content', 'light dark');
    var b = document.querySelector('.boot');
    if (b) {
      b.innerHTML = '<div class="t">Cet appareil est trop ancien pour l’app.</div>'
        + '<p>Il faut iOS 14 ou plus récent (Réglages › Général › Mise à jour logicielle).</p>';
    }
  }
  window.addEventListener('error', function (e) { if (/app\.js/.test(e.filename || '')) msg(); });
  setTimeout(msg, 15000);
})();
