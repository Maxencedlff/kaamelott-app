// ES5 volontairement : doit tourner sur les plus vieux Safari pour dire pourquoi l'app ne s'ouvre pas
// (app.js demande iOS 13.4 ou plus récent ; en dessous, il ne s'exécute pas du tout et l'écran resterait sur « Chargement »).
(function () {
  function msg() {
    var b = document.querySelector('.boot');
    if (b && !window.__kaamOK) {
      b.innerHTML = '<div class="t">Cet appareil est trop ancien pour l’app.</div>'
        + '<p>Il faut iOS 14 ou plus récent (Réglages › Général › Mise à jour logicielle).</p>';
    }
  }
  window.addEventListener('error', function (e) { if (/app\.js/.test(e.filename || '')) msg(); });
  setTimeout(msg, 15000);
})();
