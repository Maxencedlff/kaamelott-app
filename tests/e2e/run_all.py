#!/usr/bin/env python3
"""Banc de test de la PWA Kaamelott (navigateurs + tests unitaires + contrôle de data.json).

Usage : python3 tests/e2e/run_all.py            (tout, ~2-3 min)
        python3 tests/e2e/run_all.py --quick    (sans iPhone 13 « nu » ni les combinaisons de réglages)
Variables : QA_APP (dossier de l'app, défaut : racine du dépôt), QA_OUT (rapport et captures, défaut : tests/e2e),
            QA_REAL_MEDIA=1 (vrais médias Hugging Face, contrôle manuel ponctuel seulement).
Code retour : 0 si tout passe, 1 au moindre échec (étape, erreur console/CSP/pageerror, test unitaire, data.json).

Principes :
  * le serveur local pose lui-même les en-têtes de vercel.json (CSP comprise, bloc par bloc selon « source ») ;
    Playwright n'intercepte que les médias Hugging Face (remplacés par stub/, muets) et /api/avis (capturé, jamais envoyé) ;
  * toute erreur console, violation CSP ou exception de page pendant une étape fait échouer cette étape ;
  * le banc ne lit l'état de l'app que par le pont window.__kaam (app.js).

SILENCE : aucun son ne sort. L'état natif `muted` est toujours forcé à true et volume à 0 (dans play(), le setter et
sur loadstart/play) ; la valeur demandée par l'app est rangée dans `el.__m` et relue par le getter. WebKit est lancé
avec PULSE_SERVER invalide, Chromium avec --mute-audio. La règle iOS « pas de son sans toucher » est émulée sur WebKit.
"""
import json, os, re, signal, socket, subprocess, sys, threading, time, traceback
from pathlib import Path

QA = Path(__file__).resolve().parent
APP = Path(os.environ.get("QA_APP") or QA.parent.parent).resolve()
OUT = Path(os.environ.get("QA_OUT") or QA).resolve()
SHOTS = OUT / "shots"
RES = OUT / ".results"
STUB = QA / "stub"
STEP_TIMEOUT = 45
GLOBAL_BUDGET = int(os.environ.get("QA_BUDGET", "300"))
REAL_MEDIA = os.environ.get("QA_REAL_MEDIA") == "1"
HF_RE = re.compile(r"^https?://([^/]*\.)?(huggingface\.co|hf\.co)/")


def _stub(name):
    try: return (STUB / name).read_bytes()
    except Exception: return None


def playwright_browser_pids():
    """Processus navigateurs (ms-playwright) descendants de ce worker."""
    kids = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                st = open(f"/proc/{d}/stat").read()
                kids.setdefault(int(st.rsplit(")", 1)[1].split()[1]), []).append(int(d))
            except Exception:
                pass
    out, todo = [], [os.getpid()]
    while todo:
        for c in kids.get(todo.pop(), []):
            out.append(c); todo.append(c)
    res = []
    for pid in out:
        try:
            if b"ms-playwright" in open(f"/proc/{pid}/cmdline", "rb").read():
                res.append(pid)
        except Exception:
            pass
    return res


INIT_JS = r"""
(() => {
  const P = HTMLMediaElement.prototype;
  const md = Object.getOwnPropertyDescriptor(P, 'muted');
  const vd = Object.getOwnPropertyDescriptor(P, 'volume');
  const hush = el => { try { md.set.call(el, true); vd.set.call(el, 0); } catch (e) {} };
  Object.defineProperty(P, 'muted', {
    configurable: true,
    get() { return this.__m === undefined ? false : !!this.__m; },
    set(v) {
      const old = this.__m === undefined ? false : !!this.__m;
      this.__m = !!v; hush(this);
      if (old !== !!v) this.dispatchEvent(new Event('volumechange'));
    }
  });
  let lastGesture = -1e9;
  ['touchend', 'click', 'keydown', 'pointerup'].forEach(t =>
    window.addEventListener(t, () => { lastGesture = performance.now(); }, true));
  const op = P.play;
  P.play = function () {
    hush(this);
    const wantsSound = this.__m !== true;
    if (window.__qaIOSPolicy && wantsSound && !this.__unlocked) {
      if (performance.now() - lastGesture < 1000) this.__unlocked = true;
      else { window.__qaRefused = (window.__qaRefused || 0) + 1;
             return Promise.reject(new DOMException('qa: lecture avec son refusée sans geste (politique iOS émulée)', 'NotAllowedError')); }
    }
    return op.call(this);
  };
  ['loadstart', 'play', 'playing'].forEach(t => document.addEventListener(t, e => {
    if (e.target instanceof HTMLMediaElement) hush(e.target); }, true));
  document.addEventListener('securitypolicyviolation', e => {
    try { window.__qaCsp && window.__qaCsp(`${e.violatedDirective} bloque ${e.blockedURI || '(inline)'} @ ${e.sourceFile || ''}:${e.lineNumber || ''}`); } catch (_) {}
  });
})();
"""

SAFE_OVERLAY_JS = r"""
document.addEventListener('DOMContentLoaded', () => {
  const mk = css => { const d = document.createElement('div'); d.setAttribute('data-qa', 'safe');
    d.style.cssText = 'position:fixed;left:0;right:0;pointer-events:none;z-index:2147483647;' + css; document.documentElement.appendChild(d); };
  mk('top:0;height:47px;background:repeating-linear-gradient(45deg,rgba(255,0,0,.10) 0 6px,transparent 6px 12px);border-bottom:1px dashed rgba(255,0,0,.6)');
  mk('bottom:0;height:34px;background:repeating-linear-gradient(45deg,rgba(255,0,0,.10) 0 6px,transparent 6px 12px);border-top:1px dashed rgba(255,0,0,.6)');
});
"""

PREF_KEYS = ["kaam_sel", "kaam_verify", "kaam_video_only", "kaam_audio_only", "kaam_in_order", "kaam_autoplay"]
# Couverture par paires (toutes les combinaisons deux à deux des 6 réglages), vérifiée par pairwise_ok() au lancement ;
# les 2 dernières lignes ajoutent le mode Son seul hors vérification.
# kaam_sel : film seul, « série » migrée (tout sauf le film), toutes les parties ; le couple kaam_video_only / kaam_audio_only
# teste la migration vers kaam_media (aucun des deux à 1 = Texte choisi).
SEL_FILM, SEL_SERIE = '["film"]', '["L1","L2","L3","L4","L5","L6","in1","in2","in3"]'
SEL_ALL = '["L1","L2","L3","L4","L5","L6","film","in1","in2","in3"]'
COMBOS = [[{"film": SEL_FILM, "all": SEL_ALL, "serie": SEL_SERIE}[r[0]]] + r[1:] for r in [
    ["film", "0", "1", "0", "0", "1"], ["all", "1", "0", "1", "1", "1"], ["serie", "0", "1", "1", "1", "0"],
    ["serie", "1", "0", "0", "0", "0"], ["all", "0", "1", "0", "0", "0"], ["film", "1", "0", "1", "1", "0"],
    ["serie", "0", "0", "0", "1", "1"], ["film", "1", "1", "1", "0", "1"],
    ["all", "0", "0", "1", "0", "1"], ["film", "0", "0", "1", "1", "0"],
]]

NAV = {"citations": "Répliques", "quiz": "Quiz", "personnages": "Personnages", "recherche": "Rechercher", "favoris": "Favoris"}
MAIN_SEL = "#quote-card"


def pairwise_ok(rows):
    import itertools
    lv = [[SEL_ALL, SEL_SERIE, SEL_FILM]] + [["0", "1"]] * 5
    need = {(i, a, j, b) for i, j in itertools.combinations(range(6), 2) for a in lv[i] for b in lv[j]}
    have = {(i, r[i], j, r[j]) for r in rows for i, j in itertools.combinations(range(6), 2)}
    return need - have


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


_DATA = None
def data_json():
    global _DATA
    if _DATA is None:
        _DATA = json.loads((APP / "data.json").read_text(encoding="utf-8"))
    return _DATA


def fav_objects():
    out = []
    for it in data_json():
        if it.get("hide") or not it.get("quote") or not it.get("character"):
            continue
        name = re.sub(r"\s+", " ", it["character"].split(",")[0].strip()).upper()
        out.append({"quote": it["quote"], "name": name, "livre": "", "episode": "", "title": "", "film": "",
                    "inedit": "", "audio": None, "video": None})
        if len(out) == 2:
            break
    return out


# ---------------------------------------------------------------------------
# Worker (un navigateur, une suite d'étapes)
# ---------------------------------------------------------------------------
class Worker:
    def __init__(self, name, base, pw):
        self.name, self.base, self.p = name, base, pw
        self.steps, self.console, self.csp, self.pageerrors = [], [], [], []
        self.shot_dir = SHOTS / name
        self._cur = []                  # erreurs (console, CSP, pageerror) de l'étape en cours
        self.expect_errors = False      # erreurs console attendues (test 403)
        self.avis_posts = []            # corps des POST /api/avis capturés
        self.out = None
        self.deadline = float(os.environ.get("QA_DEADLINE", time.time() + GLOBAL_BUDGET))
        self.browser = None; self._ctx = None; self._launch = None; self._ctx_kw = None
        self.dead = False; self.restarts = 0
        self.t0 = time.time()

    def setup(self, launch, opts, **kw):
        self._launch, self._ctx_kw = launch, (opts, kw)

    def ctx(self):
        if self._ctx is None or self.dead:
            if self.browser is not None:
                try: self.browser.close()
                except Exception: pass
            if self.dead: self.restarts += 1
            self.browser = self._launch()
            opts, kw = self._ctx_kw
            self._ctx = self.make_context(self.browser, opts, **kw)
            self.dead = False
        return self._ctx

    def new_ctx(self, **extra):
        """Contexte séparé (service worker, hors ligne…), sur le même navigateur."""
        self.ctx()
        opts, kw = self._ctx_kw
        return self.make_context(self.browser, opts, **{**kw, **extra})

    def close(self):
        try:
            if self.browser: self.browser.close()
        except Exception:
            pass

    def save(self, final=False):
        if not self.out: return
        res = {"name": self.name, "steps": self.steps, "console": self.console, "csp": self.csp,
               "pageerrors": self.pageerrors, "dur": round(time.time() - self.t0, 1),
               "partial": not final, "restarts": self.restarts}
        tmp = Path(self.out + ".tmp")
        tmp.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.out)

    def make_context(self, browser, opts, safe=False, ios_policy=False, sw=False):
        ctx = browser.new_context(service_workers="allow" if sw else "block", **opts)
        ctx.set_default_timeout(12000)
        ctx.set_default_navigation_timeout(20000)
        ctx.add_init_script(INIT_JS)
        if ios_policy:
            ctx.add_init_script("window.__qaIOSPolicy = true;")
        if safe:
            ctx.add_init_script(SAFE_OVERLAY_JS)
        ctx.expose_binding("__qaCsp", lambda src, msg: self._err("csp", msg))

        def media(route, request):
            if REAL_MEDIA:
                return route.continue_()
            isv = ".mp4" in request.url.split("?")[0]
            body = _stub("stub.mp4" if isv else "stub.m4a")
            if body is None:
                return route.abort()
            return route.fulfill(status=200, body=body, headers={
                "content-type": "video/mp4" if isv else "audio/mp4",
                "access-control-allow-origin": "*", "cache-control": "no-store"})
        ctx.route(HF_RE, media)

        def avis(route, request):
            try: self.avis_posts.append(json.loads(request.post_data or "null"))
            except Exception: self.avis_posts.append(None)
            n = len(((self.avis_posts[-1] or {}).get("avis")) or [])
            route.fulfill(status=200, body=json.dumps({"recus": n}), headers={"content-type": "application/json"})
        ctx.route("**/api/avis", avis)

        if safe:
            def css(route, request):
                try:
                    resp = route.fetch(timeout=15000)
                    txt = resp.body().decode("utf-8", "replace")
                    txt = re.sub(r"env\(\s*safe-area-inset-top\s*(,[^)]*)?\)", "47px", txt)
                    txt = re.sub(r"env\(\s*safe-area-inset-bottom\s*(,[^)]*)?\)", "34px", txt)
                    txt = re.sub(r"env\(\s*safe-area-inset-(left|right)\s*(,[^)]*)?\)", "0px", txt)
                    route.fulfill(status=resp.status, headers=dict(resp.headers), body=txt.encode("utf-8"))
                except Exception:
                    try: route.continue_()
                    except Exception: pass
            ctx.route("**/*.css", css)
        return ctx

    def _err(self, kind, msg):
        msg = str(msg)[:300]
        (self.csp if kind == "csp" else self.pageerrors if kind == "pageerror" else self.console).append(msg)
        self._cur.append(f"{kind} : {msg}")

    def attach(self, page):
        def on_console(m):
            if m.type != "error":
                return
            t = m.text
            if "Content Security Policy" in t or "Refused to" in t:
                self._err("csp", t)
            elif not self.expect_errors:
                self._err("console", t)
        page.on("console", on_console)
        page.on("pageerror", lambda e: None if self.expect_errors else self._err("pageerror", e))

    def new_page(self, ctx, prefs=None, extra_ls=None, clear=True, media_default=True):
        page = ctx.new_page()
        self.attach(page)
        sets = dict(prefs or {}); sets.update(extra_ls or {})
        # Vidéo est l'affichage par défaut : les étapes écrites pour l'affichage Texte le demandent explicitement,
        # sauf si l'étape fixe elle-même l'affichage (kaam_media ou les anciennes clés, migration testée) ou veut le vrai défaut
        if media_default and clear and not ({"kaam_media", "kaam_video_only", "kaam_audio_only"} & set(sets)):
            sets["kaam_media"] = "text"
        if clear or sets:
            # une seule fois par page (pas à chaque rechargement : la mémorisation des réglages est testée)
            js = ("try{if(!sessionStorage.getItem('__qa')){sessionStorage.setItem('__qa','1');" + ("localStorage.clear();" if clear else "")
                  + "".join(f"localStorage.setItem({json.dumps(k)},{json.dumps(v)});" for k, v in sets.items()) + "}}catch(e){}")
            page.add_init_script(js)
        return page

    def step(self, name, fn):
        self._cur = []
        t0 = time.time()
        rec = {"name": name, "status": "OK", "detail": "", "shots": []}
        if time.time() > self.deadline:
            rec.update(status="ÉCHEC", detail="non exécutée : budget global épuisé", dur=0)
            self.steps.append(rec); self.save(); return rec
        fired = threading.Event()

        def watchdog():
            fired.set()
            for pid in playwright_browser_pids():
                try: os.kill(pid, signal.SIGKILL)
                except Exception: pass
        limit = max(5, min(STEP_TIMEOUT, self.deadline - time.time()))
        tm = threading.Timer(limit, watchdog); tm.daemon = True; tm.start()
        try:
            out = fn(rec)
            if isinstance(out, str) and out:
                rec["detail"] = out
        except Exception as e:
            rec["status"] = "ÉCHEC"
            msg = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
            rec["detail"] = (rec["detail"] + " | " if rec["detail"] else "") + msg[:300]
        finally:
            tm.cancel()
        if fired.is_set():
            self.dead = True
            rec["status"] = "ÉCHEC"
            rec["detail"] = f"DÉLAI {int(limit)} s dépassé (navigateur tué puis relancé) | " + rec["detail"]
        if self._cur:
            rec["status"] = "ÉCHEC"
            rec["detail"] += " | " + " ; ".join(self._cur[:3])
        rec["dur"] = round(time.time() - t0, 1)
        self.steps.append(rec)
        self.save()
        return rec

    def shot(self, page, rec, fname, full=False):
        self.shot_dir.mkdir(parents=True, exist_ok=True)
        path = self.shot_dir / f"{fname}.png"
        page.screenshot(path=str(path), full_page=full, timeout=15000, animations="disabled")
        rec["shots"].append(str(path.relative_to(OUT)))
        ov = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        if ov and ov > 1:
            raise RuntimeError(f"débordement horizontal de {ov} px ({fname})")

    def nav(self, page, view):
        page.click(f".nav-btn[data-view={view}]")
        page.wait_for_function("v => document.querySelector(`.nav-btn[data-view=${v}]`).classList.contains('active')", arg=view)
        page.wait_for_timeout(150)

    def wait_ready(self, page, timeout=20000):
        # écran de lancement levé (fond noir retiré) : les mesures de couleur portent sur la vraie page
        page.wait_for_function("() => window.__kaam && __kaam.allQuotes.length > 0 && !!document.querySelector('#main-content button')"
                               " && !document.documentElement.classList.contains('launching')", timeout=timeout)
        page.wait_for_timeout(150)

    def goto(self, page, path=""):
        page.goto(self.base + path, wait_until="domcontentloaded", timeout=20000)
        self.wait_ready(page)

    VIDEO_STATE = """() => {
      const v = document.querySelector('#main-content video') || document.querySelector('video');
      if (!v) return null;
      const slot = v.parentElement;
      return { appMuted: v.__m === true, cls: !!(slot && slot.classList.contains('muted')),
               paused: v.paused, rs: v.readyState, err: v.error ? v.error.code : null,
               src: (v.currentSrc || v.src || '').split('/').pop().slice(0, 40), refused: window.__qaRefused || 0 };
    }"""


# ---------------------------------------------------------------------------
# Scénarios
# ---------------------------------------------------------------------------
def scenario_screens(w):
    state = {"page": None}

    def fresh(prefs=None, extra=None):
        if state["page"]:
            try: state["page"].close()
            except Exception: pass
        pg = w.new_page(w.ctx(), prefs, extra)
        state["page"] = pg
        w.goto(pg)
        return pg

    def s_text(rec):
        pg = fresh()
        if not pg.locator(MAIN_SEL).is_visible():
            raise RuntimeError("carte de réplique absente")
        r = pg.evaluate("""() => { const q = __kaam.allQuotes[__kaam.quoteIdx];
          return { who: document.getElementById('btn-who').textContent, quote: document.querySelector('#quote-card .quote').textContent, name: q.name, text: q.quote }; }""")
        sq = lambda x: re.sub(r"[\s\u202f\u00a0'’«»]", "", x)
        if r["who"].upper() != r["name"].upper() or sq(r["text"])[:12] not in sq(r["quote"]):
            raise RuntimeError(f"la carte ne montre pas la réplique courante : {r}")
        w.shot(pg, rec, "01-citation-texte")
    w.step("Réplique (texte)", s_text)

    def s_csp(rec):
        pg = state["page"]
        hdr = pg.evaluate("fetch(location.href, {cache: 'no-store'}).then(r => r.headers.get('content-security-policy') || '')")
        n0 = len(w.csp)
        pg.evaluate("document.head.appendChild(Object.assign(document.createElement('script'), {textContent: 'window.__qaInline = 1'}))")
        pg.wait_for_timeout(400)
        caught = len(w.csp) - n0
        ran = pg.evaluate("window.__qaInline === 1")
        del w.csp[n0:]; w._cur = [c for c in w._cur if not c.startswith("csp")]   # témoin volontaire
        if not hdr or ran or not caught:
            raise RuntimeError(f"CSP non appliquée ou non détectée (en-tête={bool(hdr)}, script en ligne exécuté={ran}, violations vues={caught})")
        return "en-tête CSP présent, script en ligne témoin bloqué et détecté"
    w.step("Contrôle : CSP de vercel.json active", s_csp)

    def s_audio(rec):
        pg = fresh({"kaam_audio_only": "1"})
        pg.click("#btn-audio")
        pg.wait_for_function("() => !__kaam.player.paused && __kaam.player.currentTime > 0", timeout=6000)
        st = pg.evaluate("({ p: __kaam.player.paused, e: __kaam.player.error && __kaam.player.error.code, cls: document.getElementById('btn-audio').className })")
        w.shot(pg, rec, "02-son-ecouter")
        if st["e"] or "playing" not in st["cls"]:
            raise RuntimeError(f"le son ne joue pas : {st}")
        return f"lecteur {st}"
    w.step("Son : bouton Écouter", s_audio)

    def s_video(rec):
        pg = fresh({"kaam_video_only": "1"})
        pg.wait_for_function("() => { const v = document.querySelector('#qvideo'); return v && v.readyState >= 2; }", timeout=8000)
        if not pg.evaluate("!!__kaam.allQuotes[__kaam.quoteIdx].video"):
            raise RuntimeError("mode vidéo : la réplique affichée n'a pas de scène")
        st = pg.evaluate(Worker.VIDEO_STATE)
        w.shot(pg, rec, "03-video")
        return f"image chargée ; {st}"
    w.step("Vidéo (mode vidéo)", s_video)

    def s_settings(rec):
        pg = state["page"]
        pg.click("#mast-set")
        pg.wait_for_selector("#sheet:not([hidden]) #sh-title")
        pg.wait_for_timeout(300)
        w.shot(pg, rec, "04-reglages")
    w.step("Réglages ouverts", s_settings)

    def s_verify(rec):
        pg = fresh({"kaam_verify": "1"})
        if not pg.evaluate("__kaam.verifyIdx.includes(__kaam.quoteIdx)"):
            raise RuntimeError("Vérifier : la réplique affichée n'est pas à vérifier")
        pg.wait_for_selector("#avis-ok")
        w.shot(pg, rec, "05-verifier")
    w.step("Vérifier", s_verify)

    def s_problem(rec):
        pg = state["page"]
        pg.click("#avis-ko")
        pg.wait_for_selector("#sheet:not([hidden]) #avis-send")
        pg.wait_for_timeout(300)
        w.shot(pg, rec, "06-verifier-probleme")
    w.step("Vérifier + feuille Problème", s_problem)

    def s_quiz(rec):
        pg = fresh()
        w.nav(pg, "quiz")
        if pg.locator(".choice").count() != 4:
            raise RuntimeError("le quiz n'a pas 4 réponses")
        w.shot(pg, rec, "07-quiz-avant")
    w.step("Quiz (avant réponse)", s_quiz)

    def s_quiz2(rec):
        pg = state["page"]
        pg.locator(".choice").first.click()
        pg.wait_for_selector(".choice.right")
        pg.wait_for_timeout(600)
        w.shot(pg, rec, "08-quiz-apres")
    w.step("Quiz (après réponse)", s_quiz2)

    def s_pers(rec):
        pg = state["page"]
        w.nav(pg, "personnages")
        w.shot(pg, rec, "09-personnages")
    w.step("Personnages", s_pers)

    def s_fiche(rec):
        pg = state["page"]
        pg.locator(".idx-row").first.click()
        pg.wait_for_selector("#detail-overlay:not(.hidden) .fiche-h h1")
        pg.wait_for_timeout(400)
        w.shot(pg, rec, "10-fiche-personnage")
    w.step("Fiche personnage", s_fiche)

    def s_fiche_bar(rec):
        pg = state["page"]
        pg.evaluate("document.getElementById('fiche-scroll').scrollTop = 600"); pg.wait_for_timeout(450)
        try:                                   # machine chargée (CI) : laisser finir la transition d'opacité
            pg.wait_for_function("() => document.querySelector('#detail-overlay .back').classList.contains('solid')"
                                 " && +getComputedStyle(document.querySelector('.back .nt')).opacity >= .99", timeout=4000)
        except Exception:
            pass
        r = pg.evaluate("() => ({ solid: document.querySelector('#detail-overlay .back').classList.contains('solid'), nt: getComputedStyle(document.querySelector('.back .nt')).opacity })")
        w.shot(pg, rec, "10b-fiche-barre")
        pg.evaluate("document.getElementById('fiche-scroll').scrollTop = 0"); pg.wait_for_timeout(350)
        try:
            pg.wait_for_function("() => !document.querySelector('#detail-overlay .back').classList.contains('solid')", timeout=4000)
        except Exception:
            pass
        back = pg.evaluate("document.querySelector('#detail-overlay .back').classList.contains('solid')")
        if not r["solid"] or float(r["nt"]) < .99 or back: raise RuntimeError(f"barre de la fiche : {r}, revenue en haut solid={back}")
        pg.click("#detail-back"); pg.wait_for_selector("#detail-overlay.hidden", state="attached")
        return "barre opaque avec le nom une fois l'aplat passé, transparente en haut"
    w.step("Fiche : barre repliée au défilement", s_fiche_bar)

    w.step("Grand titre replié au défilement (clair)", lambda rec: check_compact(w, state["page"], rec, "10c-titre-replie"))

    def s_search(rec):
        pg = fresh()
        w.nav(pg, "recherche")
        pg.fill("#search-input", "Perceval")
        pg.wait_for_function("() => document.querySelectorAll('#search-results .ent').length > 0", timeout=6000)
        n = pg.evaluate("document.querySelectorAll('#search-results .ent').length")
        w.shot(pg, rec, "11-chercher")
        return f"{n} entrées affichées"
    w.step("Chercher « Perceval »", s_search)

    def s_favs(rec):
        favs = fav_objects()
        pg = fresh(extra={"kaam_fav": json.dumps(favs, ensure_ascii=False)})
        w.nav(pg, "favoris")
        n = pg.evaluate("document.querySelectorAll('#main-content .ent').length")
        w.shot(pg, rec, "12-favoris")
        if n != 2:
            raise RuntimeError(f"{n} favori(s) affiché(s) au lieu de 2 (kaam_fav)")
    w.step("Favoris (2 injectés)", s_favs)

    def s_long(rec):
        pg = fresh()
        res = pg.evaluate("""() => { const A = __kaam.allQuotes; let b = 0;
          A.forEach((q, i) => { if (q.quote.length > A[b].quote.length) b = i; });
          __kaam.quoteIdx = b; __kaam.render(); return { len: A[b].quote.length }; }""")
        pg.wait_for_timeout(400)
        w.shot(pg, rec, "13-replique-longue")
        info = pg.evaluate("""() => { const c = document.querySelector('#quote-card'); const cs = getComputedStyle(c);
           return { sh: c.scrollHeight, ch: c.clientHeight, ov: cs.overflowY }; }""")
        if info["sh"] > info["ch"] + 2 and info["ov"] not in ("auto", "scroll"):
            raise RuntimeError(f"texte coupé sans défilement : {info}")
        return f"réplique de {res['len']} signes ; carte {info}"
    w.step("Réplique la plus longue", s_long)

    def s_err(rec):
        if state["page"]:
            state["page"].close(); state["page"] = None
        pg = w.new_page(w.ctx())
        w.expect_errors = True
        try:
            pg.route("**/data.json*", lambda r: r.fulfill(status=403, body="Forbidden", headers={"content-type": "text/plain"}))
            pg.goto(w.base, wait_until="domcontentloaded")
            pg.wait_for_selector("#btn-retry", timeout=20000)
            w.shot(pg, rec, "14-erreur-403")
            txt = pg.evaluate("document.querySelector('#main-content').innerText.slice(0, 160)")
        finally:
            pg.close(); w.expect_errors = False
        return "message : " + txt.replace("\n", " / ")
    w.step("État d'erreur (data.json 403)", s_err)


def _lum_rgb(r, g, b):
    f = lambda v: (v / 255 / 12.92) if v / 255 <= .04045 else ((v / 255 + .055) / 1.055) ** 2.4
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b)


def png_pixels(data):
    """Pixels RVB d'une capture PNG (8 bits, RVB ou RVBA, non entrelacée), sans dépendance (la CI n'a pas Pillow)."""
    import struct, zlib
    pos, idat, w = 8, b"", 0
    while pos < len(data):
        n, typ = struct.unpack(">I4s", data[pos:pos + 8]); chunk = data[pos + 8:pos + 8 + n]; pos += 12 + n
        if typ == b"IHDR": w, h, depth, ctype = struct.unpack(">IIBB", chunk[:10])
        elif typ == b"IDAT": idat += chunk
    bpp = 4 if ctype == 6 else 3
    raw, stride, prev, out, i = zlib.decompress(idat), w * bpp, None, [], 0
    for _ in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0; b = prev[x] if prev else 0; c = prev[x - bpp] if prev and x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pp = a + b - c; pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out.extend((line[x], line[x + 1], line[x + 2]) for x in range(0, stride, bpp)); prev = line
    return out


def text_on_image_ratio(pg, text_sel):
    """Contraste MESURÉ d'un texte posé sur une image : le texte est masqué, la zone qu'il couvre est capturée,
    et l'on prend le pixel le plus défavorable du fond (le plus proche de la couleur du texte)."""
    import re as _re
    color = pg.evaluate("s => getComputedStyle(document.querySelector(s)).color", text_sel)
    tl = _lum_rgb(*[int(float(x)) for x in _re.findall(r"[\d.]+", color)[:3]])
    box = pg.evaluate("""s => { const e = document.querySelector(s); e.style.visibility = 'hidden';
        const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }""", text_sel)
    pg.wait_for_timeout(50)
    png = pg.screenshot(clip=box, animations="disabled", scale="css")
    pg.evaluate("s => { document.querySelector(s).style.visibility = ''; }", text_sel)
    lums = sorted(_lum_rgb(*px) for px in png_pixels(png))
    worst = lums[-1] if tl > .5 else lums[0]
    return (max(tl, worst) + .05) / (min(tl, worst) + .05)


QUIZ_CUT = """() => { const st = document.getElementById('quiz-stage'), m = document.getElementById('main-content');
  const card = document.querySelector('.qcard').getBoundingClientRect(), q = document.querySelector('.quiz-q .quote').getBoundingClientRect(), s = st.getBoundingClientRect();
  return { qpage: m.classList.contains('qpage'), inner: st.scrollHeight - st.clientHeight, cardBot: card.bottom, qBot: q.bottom, stBot: s.bottom,
           bg: getComputedStyle(document.querySelector('.qcard')).backgroundColor, body: getComputedStyle(document.body).backgroundColor,
           ink: getComputedStyle(document.querySelector('.quiz-q .quote')).color, len: document.querySelector('.quiz-q .quote').textContent.length }; }"""


def quiz_never_cut(w, pg, rec, n, fname):
    """La question du quiz n'est jamais coupée : entière dans sa zone, ou c'est la page qui défile ; carte neutre (pas noire en clair).
    n questions tirées, puis la réplique la plus longue du pool (cas de la question du jour) rendue de force."""
    w.nav(pg, "quiz")
    pg.evaluate("document.fonts.ready"); pg.wait_for_timeout(200)
    bad, seen = [], 0
    for k in range(n + 1):
        if k == n:
            pg.evaluate("""() => { const A = __kaam.allQuotes; let L = null;
              A.forEach(q => { if (q.video && (!L || q.quote.length > L.quote.length) && q.quote.length < 700) L = q; });
              const qt = document.querySelector('.quiz-q .quote'); qt.innerHTML = '« ' + L.quote + ' »'; qt.dataset.fs0 = '22';
              fitQuiz(document.getElementById('quiz-stage')); }""")
            pg.wait_for_timeout(100)
        r = pg.evaluate(QUIZ_CUT)
        seen = max(seen, r["len"])
        if r["inner"] > 1 or (not r["qpage"] and r["cardBot"] > r["stBot"] + 1): bad.append(r)
        if r["body"] == "rgb(255, 255, 255)" and r["bg"] != "rgb(245, 245, 247)": bad.append({"carte non neutre en clair": r["bg"]})
        if k == 0: w.shot(pg, rec, fname)
        if k == n: w.shot(pg, rec, fname + "-longue")
        if k < n - 1: pg.click("#quiz-next"); pg.wait_for_timeout(120); pg.evaluate("document.fonts.ready")
    if bad: raise RuntimeError(f"question coupée ou carte non neutre : {bad[:2]}")
    return f"{n} questions + la plus longue ({seen} signes) : jamais coupées (page qui défile si besoin), carte {r['bg']}"


def check_compact(w, pg, rec, fname):
    """Grand titre repliable : Personnages défilé -> barre compacte visible, lisible, sous la zone sûre, sans saut."""
    w.nav(pg, "personnages")
    pg.evaluate("document.getElementById('pers-scroll').scrollTop = 0"); pg.wait_for_timeout(350)
    r0 = pg.evaluate("""() => ({ compact: document.getElementById('main-header').classList.contains('compact'),
        y: document.querySelector('#pers-list').getBoundingClientRect().top })""")
    if r0["compact"]: raise RuntimeError("barre repliée alors que rien n'a défilé")
    pg.evaluate("document.getElementById('pers-scroll').scrollTop = 300")
    try: pg.wait_for_function("() => document.getElementById('main-header').classList.contains('compact')", timeout=3000)
    except Exception: pass
    pg.wait_for_timeout(450)    # fin du fondu (0,2 s)
    try:                        # machine chargée (CI) : le fondu peut durer plus longtemps
        pg.wait_for_function("() => +getComputedStyle(document.getElementById('mast-ct')).opacity >= .99", timeout=4000)
    except Exception: pass
    r = pg.evaluate("""() => { const m = document.getElementById('main-header'), ct = document.getElementById('mast-ct'), cs = getComputedStyle(ct),
        bf = getComputedStyle(m, '::before'), big = getComputedStyle(document.querySelector('#mast-sub'));
        const st = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--st')) || 0;
        const b = ct.getBoundingClientRect(), safe = document.querySelector('[data-qa=safe]');
        return { compact: m.classList.contains('compact'), txt: ct.textContent, fs: cs.fontSize, fw: cs.fontWeight, op: cs.opacity, bigOp: big.opacity,
                 color: cs.color, bg: bf.backgroundColor, bgOp: bf.opacity, shadow: bf.boxShadow, top: b.top, cx: b.left + b.width / 2, vw: innerWidth,
                 safeTop: safe ? 47 : 0, y: document.querySelector('#pers-list').getBoundingClientRect().top + 300 }; }""")
    w.shot(pg, rec, fname)
    import re as _re
    def lum(c):
        v = [float(x) for x in _re.findall(r"[\d.]+", c)[:3]]
        f = lambda x: x / 255 / 12.92 if x / 255 <= .04045 else ((x / 255 + .055) / 1.055) ** 2.4
        return .2126 * f(v[0]) + .7152 * f(v[1]) + .0722 * f(v[2])
    ratio = (max(lum(r["color"]), lum(r["bg"])) + .05) / (min(lum(r["color"]), lum(r["bg"])) + .05)
    errs = []
    if not r["compact"]: errs.append("pas de barre compacte après défilement")
    if r["txt"] != "Personnages" or r["fs"] != "17px" or r["fw"] not in ("600", "semibold"): errs.append(f"titre compact {r['txt']!r} {r['fs']} {r['fw']}")
    if float(r["op"]) < .99 or float(r["bgOp"]) < .99 or float(r["bigOp"]) > .01: errs.append(f"opacités {r['op']}/{r['bgOp']}/{r['bigOp']}")
    if "0.5px" not in r["shadow"] and ".5px" not in r["shadow"]: errs.append(f"filet absent : {r['shadow']}")
    if ratio < 7: errs.append(f"titre compact peu lisible ({ratio:.1f}:1)")
    if r["top"] < r["safeTop"] - .5: errs.append(f"titre sous l'encoche ({r['top']})")
    if abs(r["cx"] - r["vw"] / 2) > 2: errs.append(f"titre non centré ({r['cx']})")
    if abs(r["y"] - r0["y"]) > 1: errs.append(f"saut de mise en page : liste {r0['y']} -> {r['y'] - 300}")
    if errs: raise RuntimeError(" ; ".join(errs))
    return f"barre compacte « {r['txt']} » 17 px, contraste {ratio:.1f}:1 sur {r['bg']}, filet, pas de saut"


# Invariant après chaque navigation : la réplique affichée respecte TOUS les filtres, et le pool aussi
INV = """p => { const K = __kaam, A = K.allQuotes, q = A[K.quoteIdx], P = K.pool();
  // sélection effective : une ancienne sélection complète (sans kaam_sel_v2) inclut aussi les pilotes et Dies Iræ
  const S = p.kaam_sel ? [...K.sel] : null, S0 = p.kaam_sel ? JSON.parse(p.kaam_sel).filter(x => /^(L[1-6]|film|in[123]|dies|pil)$/.test(x)) : [];
  if (S && !S0.every(x => S.includes(x))) return { q: false, pool: false, inPool: false, card: false, idx: K.quoteIdx, sel: S };
  const ok = x => (!S || S.includes(x.part))
    && (p.kaam_verify === '1' || p.kaam_video_only !== '1' || !!x.video)
    && (p.kaam_verify === '1' || p.kaam_video_only === '1' || p.kaam_audio_only !== '1' || !!x.audio)
    && (p.kaam_verify !== '1' || !!(x.audio || x.video));
  const shown = document.getElementById('btn-who')?.textContent || '';
  return { q: ok(q), pool: !P || P.every(i => ok(A[i])), inPool: !P || P.includes(K.quoteIdx),
           card: shown.toUpperCase() === q.name.toUpperCase(), idx: K.quoteIdx }; }"""


def scenario_combos(w):
    bad = pairwise_ok(COMBOS)
    if bad:
        raise RuntimeError(f"couverture par paires incomplète : {sorted(bad)[:5]}")
    for combo in COMBOS:
        prefs = dict(zip(PREF_KEYS, combo))
        label = "réglages " + " ".join(f"{k.replace('kaam_', '')}={v}" for k, v in prefs.items())

        def run(rec, prefs=prefs):
            pg = w.new_page(w.ctx(), prefs)
            try:
                w.goto(pg)
                verify = prefs["kaam_verify"] == "1"
                seen = set()
                for k, key in enumerate(["start"] + ["next"] * 3 + ["random"] * 3 + ["prev"]):
                    before = pg.evaluate("__kaam.quoteIdx")
                    if key == "next":
                        if verify: pg.click("#avis-skip")
                        else: pg.click("#btn-next")
                    elif key == "random":
                        if verify: pg.locator("#quote-card .quote").click(position={"x": 8, "y": 8})
                        else: pg.click("#btn-random" if pg.locator("#btn-random").count() else "#btn-next")
                    elif key == "prev" and not verify:
                        if pg.locator("#btn-prev:not([disabled])").count(): pg.click("#btn-prev")
                    if key != "start":
                        pg.wait_for_timeout(60)
                    inv = pg.evaluate(INV, prefs)
                    seen.add(inv["idx"])
                    if not (inv["q"] and inv["pool"] and inv["inPool"] and inv["card"]):
                        raise RuntimeError(f"réplique hors filtre après « {key} » n°{k} : {inv}")
                if len(seen) < 3:
                    raise RuntimeError(f"la navigation ne change pas de réplique ({len(seen)} vues)")
                return f"{len(seen)} répliques vues, toutes dans le filtre"
            finally:
                pg.close()
        w.step(label, run)


def scenario_video_sound(w):
    S = {}

    def s_open(rec):
        pg = S["pg"] = w.new_page(w.ctx(), {"kaam_video_only": "1"})
        w.goto(pg)
        pg.wait_for_function("() => { const v = document.querySelector('#qvideo'); return v && (v.__m === true || window.__qaRefused > 0); }", timeout=8000)
        pg.wait_for_timeout(300)
        s = pg.evaluate(Worker.VIDEO_STATE)
        w.shot(pg, rec, "20-video-ouverture-muet")
        if not s or not s["appMuted"] or not s["cls"]:
            raise RuntimeError(f"l'app n'indique pas « muet » à l'ouverture : {s}")
        return "muet indiqué (video.__m=true, classe muted)"
    w.step("Ouverture mode vidéo : « muet » indiqué", s_open)

    def s_tap(rec):
        pg = S["pg"]
        box = pg.locator(".mast").bounding_box()
        pg.touchscreen.tap(box["x"] + 10, box["y"] + box["height"] / 2)
        pg.wait_for_timeout(500)
        s = pg.evaluate(Worker.VIDEO_STATE)
        w.shot(pg, rec, "21-video-apres-tap")
        if not s or s["appMuted"] or s["cls"]:
            raise RuntimeError(f"toujours muet après un toucher : {s}")
        return f"son actif ; {s}"
    w.step("Après un premier toucher : son actif", s_tap)

    for k in range(3):
        def s_next(rec, k=k):
            pg = S["pg"]
            pg.click("#btn-next")
            pg.wait_for_function("() => { const v = document.querySelector('#qvideo'); return v && !v.paused; }", timeout=6000)
            s = pg.evaluate(Worker.VIDEO_STATE)
            if k == 2: w.shot(pg, rec, "22-video-suivante")
            if not s or s["appMuted"] or s["cls"]:
                raise RuntimeError(f"redevenu muet : {s}")
            return f"{s}"
        w.step(f"Vidéo suivante {k + 1} : reste avec le son", s_next)


def scenario_vague2(w):
    """Comportements fins (iPhone SE, le plus contraint)."""
    def page(prefs=None, extra=None):
        pg = w.new_page(w.ctx(), prefs, extra); w.goto(pg); return pg

    def s_quizD(rec):
        pg = page(); w.nav(pg, "quiz")
        bad = 0
        for k in range(8):
            r = pg.evaluate("""() => { const c = [...document.querySelectorAll('.choice')]; const nav = document.getElementById('quiz-nav').getBoundingClientRect();
                return { n: c.length, last: c[3].getBoundingClientRect().bottom, nav: nav.top, ys: c.map(x => Math.round(x.getBoundingClientRect().top)) }; }""")
            if r["n"] != 4 or r["last"] > r["nav"] + 1: bad += 1
            if k == 7:
                pg.locator(".choice").nth(2).click(); pg.wait_for_selector(".choice.right")
                ys = pg.evaluate("[...document.querySelectorAll('.choice')].map(x => Math.round(x.getBoundingClientRect().top))")
                live = pg.evaluate("document.getElementById('sr-live').textContent")
                w.shot(pg, rec, "30-quiz-apres-se")
                # après la réponse, la page peut défiler (scène en grand au-dessus) : les 4 lignes restent, même espacement
                if [y - ys[0] for y in ys] != [y - r["ys"][0] for y in r["ys"]]: raise RuntimeError(f"les réponses ont bougé : {r['ys']} -> {ys}")
                if not re.match(r"^(Juste|Faux)", live): raise RuntimeError(f"verdict non annoncé : {live!r}")
            else:
                pg.click("#quiz-next"); pg.wait_for_timeout(60)
        pg.close()
        if bad: raise RuntimeError(f"réponse D cachée ou absente {bad} fois sur 8")
        return "D toujours visible, lignes immobiles après réponse, verdict annoncé"
    w.step("Quiz : D visible, rien ne bouge, verdict annoncé", s_quizD)

    def s_qcut(rec):
        pg = page()
        try: return quiz_never_cut(w, pg, rec, 10, "30d-quiz-jamais-coupe-se")
        finally: pg.close()
    w.step("Quiz (SE) : question jamais coupée, carte neutre", s_qcut)

    def s_quiz_scene(rec):
        pg = page(); w.nav(pg, "quiz")
        pg.locator(".choice").first.click(); pg.wait_for_selector(".choice.right"); pg.wait_for_timeout(600)
        # état « sans le son » forcé : la pastille doit rester petite, en bas à gauche
        pg.evaluate("() => { const f = document.getElementById('quiz-fig'), v = f.querySelector('video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } }")
        pg.wait_for_timeout(300)   # le « loadstart » du lecteur vidé arrive après coup (machine chargée) : l'état forcé vient ensuite
        pg.evaluate("() => { const f = document.getElementById('quiz-fig'); f.dataset.s = 'muted'; const st = f.querySelector('.st'); st.className = 'st red'; st.innerHTML = '<i></i>Touchez l’image pour le son'; }")
        pg.wait_for_timeout(100)
        G = """() => { const R = e => e.getBoundingClientRect(), m = document.getElementById('main-content');
          const top = R(document.getElementById('main-header')).top + parseFloat(getComputedStyle(m).paddingTop);
          const nav = R(document.getElementById('quiz-nav')), fr = R(document.querySelector('#quiz-fig .frame')), vd = R(document.getElementById('quiz-verdict'));
          const pill = R(document.querySelector('#quiz-fig .st'));
          return { vw: innerWidth, qpage: m.classList.contains('qpage'), top, navTop: nav.top, navBot: nav.bottom, tabs: R(document.querySelector('.tabs')).top,
                   fr: [fr.left, fr.top, fr.width, fr.height], vd: [vd.top, vd.bottom], pill: [pill.left - fr.left, fr.bottom - pill.bottom, pill.width, pill.height],
                   ch: [...document.querySelectorAll('.choice')].map(c => [R(c).top, R(c).bottom]), sh: m.scrollHeight, cl: m.clientHeight }; }"""
        r = pg.evaluate(G)
        w.shot(pg, rec, "30b-quiz-scene-se")
        errs = []
        fl, ft, fw, fh = r["fr"]
        if fw < .85 * r["vw"]: errs.append(f"scène {fw:.0f} px < 85 % de {r['vw']}")
        if abs(fw / fh - 16 / 9) > .02: errs.append(f"scène hors 16:9 ({fw:.0f}×{fh:.0f})")
        if r["vd"][0] < r["top"] - .5 or r["vd"][1] > ft: errs.append(f"verdict caché ou recouvert {r['vd']}")
        if ft < r["top"] - .5 or ft + fh > r["navTop"] + .5: errs.append(f"scène coupée : {ft:.0f}-{ft + fh:.0f}, zone {r['top']:.0f}-{r['navTop']:.0f}")
        if r["navBot"] > r["tabs"] + .5: errs.append("« Question suivante » sous les onglets")
        px, pb, pw, ph = r["pill"]
        if px > 12 or pb > 12 or pw > fw * .75 or ph > 20: errs.append(f"pastille trop grande ou mal placée {r['pill']}")
        pg.evaluate("document.getElementById('main-content').scrollTop = 99999"); pg.wait_for_timeout(300)
        r2 = pg.evaluate(G)
        w.shot(pg, rec, "30c-quiz-choix-se")
        if any(t < r2["top"] - .5 or b > r2["navTop"] + .5 for t, b in r2["ch"]): errs.append(f"un choix est recouvert en bas de page : {r2['ch']} / {r2['navTop']}")
        pg.close()
        if errs: raise RuntimeError(" ; ".join(errs))
        return f"scène {fw:.0f}×{fh:.0f} ({fw / r['vw']:.0%} de l'écran), verdict, choix et « Question suivante » dégagés ; pastille {pw:.0f}×{ph:.0f} en bas à gauche"
    w.step("Quiz SE : scène en grand après la réponse, rien de coupé", s_quiz_scene)

    def s_az(rec):
        pg = page(); w.nav(pg, "personnages")
        pg.click("[data-sort=alpha]"); pg.wait_for_timeout(200)
        letters = pg.evaluate("[...document.querySelectorAll('.idx-l:not(.voix)')].map(x => x.textContent)")
        names = pg.evaluate("[...document.querySelectorAll('.idx-row .n')].map(x => x.textContent)")
        w.shot(pg, rec, "31-personnages-az")
        pg.close()
        if len(letters) != len(set(letters)): raise RuntimeError(f"lettres répétées : {letters}")
        if letters != sorted(letters): raise RuntimeError(f"lettres dans le désordre : {letters}")
        for bad in ("Dame Ou Lac", "Ia Dame", "Léodaganr", "Père Biaise"):
            if any(bad.lower() in n.lower() for n in names): raise RuntimeError(f"coquille encore présente : {bad}")
        return f"{len(letters)} lettres uniques et ordonnées"
    w.step("Personnages : tri de A à Z, coquilles", s_az)

    def s_fiche(rec):
        pg = page(); w.nav(pg, "personnages")
        pg.locator(".idx-row").first.click(); pg.wait_for_selector("#fiche-list .ent")
        r = pg.evaluate("""() => ({ ep: document.querySelectorAll('.ep-h').length, ents: document.querySelectorAll('#fiche-list .ent').length,
            more: document.querySelectorAll('#fiche-list .ent > .ent-more').length, rows: document.querySelectorAll('#fiche-list .ent-a, #fiche-list [data-act=share], #fiche-list [data-act=video]').length,
            livres: document.querySelectorAll('.livres button').length, fab: !!document.querySelector('.fiche-h .play'), pills: [...document.querySelectorAll('.fiche-acts .pill')].map(b => b.textContent.trim()),
            part: document.querySelector('.fiche-h .part').textContent, stats: !!document.querySelector('.stats') })""")
        w.shot(pg, rec, "32-fiche-se")
        # menu « … » : Écouter / Voir la scène seulement s'ils existent
        pg.locator("#fiche-list .ent-more").first.click(); pg.wait_for_selector("#sheet:not([hidden]) [data-m]")
        acts = pg.evaluate("[...document.querySelectorAll('#sheet [data-m]')].map(b => b.dataset.m)")
        w.shot(pg, rec, "32b-fiche-menu-se")
        pg.close()
        errs = []
        if not r["ep"] or r["more"] != r["ents"] or r["rows"]: errs.append(f"lignes : {r}")
        if r["fab"] or r["stats"] or "Aléatoire" not in r["pills"][-1] or not re.match(r"^[\d\u202f\u00a0 ]+ répliques · [\d\u202f\u00a0 ]+ épisodes?$", r["part"]): errs.append(f"en-tête : {r}")
        if r["livres"] < 2: errs.append(f"Livres : {r['livres']}")
        if not {"fav", "share"} <= set(acts): errs.append(f"menu : {acts}")
        if errs: raise RuntimeError(" ; ".join(errs))
        return f"{r['ep']} en-têtes d'épisode, un « … » par ligne (aucune rangée d'actions), {r['livres']} Livres en liste, « {r['part']} », menu {acts}"
    w.step("Fiche personnage : en-tête, Livres en liste, « … » par ligne", s_fiche)

    def s_search(rec):
        pg = page(); w.nav(pg, "recherche")
        pg.fill("#search-input", "roi")
        pg.wait_for_function("() => document.querySelectorAll('#search-results .ent').length > 0")
        marks = pg.evaluate("[...document.querySelectorAll('.ent-q mark')].map(m => m.textContent.toLowerCase())")
        pg.fill("#search-input", "c est pas faux")
        pg.wait_for_function("() => /faux/i.test(document.querySelector('#search-results .ent-q')?.textContent || '')")
        n = pg.evaluate("document.querySelectorAll('#search-results .ent').length")
        w.nav(pg, "citations"); w.nav(pg, "recherche")
        v = pg.evaluate("document.getElementById('search-input').value")
        w.shot(pg, rec, "33-chercher-memoire")
        pg.close()
        if not marks or any(not re.fullmatch(r"roi\w*", m) for m in marks): raise RuntimeError(f"surlignage absent ou hors mot entier : {marks[:6]}")
        if not n: raise RuntimeError("« c est pas faux » ne trouve rien")
        if v != "c est pas faux": raise RuntimeError(f"recherche oubliée : {v!r}")
        return f"« roi » : {len(marks)} mots entiers soulignés ; « c est pas faux » : {n} ; recherche gardée"
    w.step("Chercher : surlignage, ponctuation facultative, mémoire", s_search)

    def s_fav(rec):
        favs = fav_objects()
        pg = page(extra={"kaam_fav": json.dumps(favs, ensure_ascii=False)}); w.nav(pg, "favoris")
        pg.locator(".ent-more").first.click(); pg.click("#sheet [data-m=fav]"); pg.wait_for_selector(".ent.off")
        off = pg.evaluate("document.querySelectorAll('.ent.off').length")
        n1 = pg.evaluate("JSON.parse(localStorage.getItem('kaam_fav')).length")
        w.shot(pg, rec, "34-favori-retire")
        pg.click("[data-act=undo]"); pg.wait_for_timeout(150)
        n2 = pg.evaluate("JSON.parse(localStorage.getItem('kaam_fav')).length")
        first = pg.evaluate("JSON.parse(localStorage.getItem('kaam_fav'))[0].quote")
        pg.close()
        if off != 1 or n1 != 1 or n2 != 2 or first != favs[0]["quote"]: raise RuntimeError(f"off={off} après retrait={n1} après remise={n2}")
        return "retrait barré sur place, « Remettre » rétablit le favori à sa place (kaam_fav)"
    w.step("Favoris : Retirer puis Remettre", s_fav)

    def s_verify(rec):
        pg = page({"kaam_verify": "1"})
        pg.click("#avis-ok"); pg.wait_for_selector(".done-line")
        line = pg.evaluate("document.querySelector('.done-line').innerText")
        w.shot(pg, rec, "35-verifier-signale")
        pg.click("#avis-undo"); pg.wait_for_timeout(200)
        left = pg.evaluate("Object.keys(__kaam.avisFaits).length + __kaam.avisFile.length")
        pg.evaluate("""() => { const K = __kaam; K.allQuotes.forEach(q => { if (q.audio || q.video) K.avisFaits[q.i] = 1; }); K.rebuildVerify(); K.render(); }""")
        pg.wait_for_selector(".fin")
        fin = pg.evaluate("({ fin: !!document.querySelector('.fin'), ok: !!document.getElementById('avis-ok') })")
        w.shot(pg, rec, "36-verifier-fini")
        pg.close()
        if not re.search(r"Validé|Signalé", line) or left != 0 or not fin["fin"] or fin["ok"]: raise RuntimeError(f"ligne={line!r} restant={left} fin={fin}")
        return "la ligne d'avis permet d'annuler ; tout vérifié : écran de fin, plus de bouton OK"
    w.step("Vérifier : Annuler, puis écran de fin", s_verify)

    def s_sounds(rec):
        pg = page({"kaam_verify": "1"})
        pg.tap(".mast"); pg.wait_for_timeout(200)
        pg.evaluate("() => { const K = __kaam; const i = K.allQuotes.findIndex((q, k) => q.audio && q.video && K.verifyIdx.includes(k)); if (i >= 0) { K.quoteIdx = i; K.render(); } }")
        pg.wait_for_selector("#btn-audio")
        pg.click("#btn-audio"); pg.wait_for_function("() => !__kaam.player.paused")
        r = pg.evaluate("({ video: document.getElementById('qvideo').paused, audio: __kaam.player.paused })")
        pg.close()
        if not r["video"]: raise RuntimeError(f"la scène joue encore pendant le son : {r}")
        return f"Écouter met la scène en pause : {r}"
    w.step("Jamais deux sons à la fois", s_sounds)

    def s_err(rec):
        pg = w.new_page(w.ctx(), None, {"kaam_fav": json.dumps(fav_objects(), ensure_ascii=False)})
        w.expect_errors = True
        try:
            pg.route("**/data.json*", lambda r: r.fulfill(status=403, body="Forbidden", headers={"content-type": "text/plain"}))
            pg.goto(w.base, wait_until="domcontentloaded")
            pg.wait_for_selector("#btn-myfav", timeout=20000)
            pg.click(".nav-btn[data-view=favoris]"); pg.wait_for_timeout(200)
            r = pg.evaluate("({ sub: document.querySelector('.page-h h1')?.textContent, n: document.querySelectorAll('.ent').length })")
            w.shot(pg, rec, "37-erreur-favoris")
        finally:
            pg.close(); w.expect_errors = False
        if r["sub"] != "Favoris" or r["n"] < 2: raise RuntimeError(f"onglet Favoris inerte sur l'écran d'erreur : {r}")
        return "écran d'erreur : l'onglet Favoris s'ouvre et montre les favoris"
    w.step("Écran d'erreur : Favoris accessible", s_err)

    def s_daily(rec):
        pg = page(); w.nav(pg, "quiz")
        pg.click("#quiz-daily"); pg.wait_for_selector("#quiz-free")
        q1 = pg.evaluate("document.querySelector('.quiz-q .quote').textContent")
        ch1 = pg.evaluate("[...document.querySelectorAll('.choice')].map(c => c.dataset.choice)")
        pg.locator(".choice").first.click(); pg.wait_for_selector(".choice.right")
        w.shot(pg, rec, "38-question-du-jour")
        pg.click("#quiz-free"); pg.wait_for_selector("#quiz-daily"); pg.click("#quiz-daily"); pg.wait_for_selector(".choice.right")
        again = pg.evaluate("({ answered: __kaam.quizState.answered, right: !!document.querySelector('.choice.right'), q: document.querySelector('.quiz-q .quote').textContent })")
        pg.close()
        pg2 = page(); w.nav(pg2, "quiz"); pg2.click("#quiz-daily"); pg2.wait_for_selector("#quiz-free")
        q2 = pg2.evaluate("document.querySelector('.quiz-q .quote').textContent")
        ch2 = pg2.evaluate("[...document.querySelectorAll('.choice')].map(c => c.dataset.choice)")
        pg2.close()
        if q1 != q2 or ch1 != ch2: raise RuntimeError("la question du jour change d'un appareil à l'autre")
        if not (again["answered"] and again["right"] and again["q"] == q1): raise RuntimeError(f"seconde tentative possible : {again}")
        return "même question et mêmes choix sur deux appareils ; une seule tentative"
    w.step("Quiz : question du jour", s_daily)

    def s_copy(rec):
        pg = page()
        pg.evaluate("() => { try { delete Navigator.prototype.share; } catch (e) {} navigator.share = undefined; }")
        alerts = []
        pg.on("dialog", lambda d: (alerts.append(d.message), d.dismiss()))
        pg.click("#btn-share"); pg.wait_for_timeout(250)
        lab = pg.evaluate("document.querySelector('#btn-share').innerText")
        w.shot(pg, rec, "39-partage-copie")
        pg.close()
        if alerts: raise RuntimeError(f"fenêtre d'alerte : {alerts}")
        if not re.search(r"Copié|Échec", lab): raise RuntimeError(f"pas de confirmation dans le bouton : {lab!r}")
        return f"confirmation dans le bouton : {lab.strip()!r}"
    w.step("Partager : confirmation sans alerte", s_copy)


# Glisser horizontal sur la carte (WebKit refuse « new Touch » : événement générique portant touches / changedTouches)
SWIPE_JS = """([dx]) => { const el = document.getElementById('quote-card'); const b = el.getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  const fire = (type, X, down) => { const e = new Event(type, { bubbles: true, cancelable: true }); const t = [{ identifier: 1, target: el, clientX: X, clientY: y }];
    Object.defineProperty(e, 'touches', { value: down ? t : [] }); Object.defineProperty(e, 'changedTouches', { value: t }); el.dispatchEvent(e); };
  fire('touchstart', x, true); fire('touchmove', x + dx / 2, true); fire('touchend', x + dx, false); }"""


def scenario_fonctions(w):
    """Ordre, toucher et glisser, mémorisation, envoi des avis, hors ligne (service worker)."""
    def setting(pg, sel):
        pg.click("#mast-set"); pg.wait_for_selector("#sheet:not([hidden])")
        pg.click(f"#sheet {sel}"); pg.wait_for_timeout(80)
        pg.click("#sheet-close"); pg.wait_for_selector("#sheet", state="hidden")

    def s_nodot(rec):
        pg = w.new_page(w.ctx(), media_default=False); w.goto(pg)   # vrais réglages par défaut (Vidéo)
        bad = pg.evaluate("document.getElementById('mast-set').classList.contains('dot') || !!document.querySelector('.bar')")
        pg.close()
        if bad: raise RuntimeError("réglages par défaut : point ou résumé affiché")
        return "réglages par défaut : ni point ni résumé"
    w.step("Réglages par défaut : aucun point", s_nodot)

    def s_order(rec):
        pg = w.new_page(w.ctx()); w.goto(pg)
        setting(pg, '[data-order="seq"]')
        idx = lambda: pg.evaluate("__kaam.quoteIdx")
        pos = lambda: pg.evaluate("(() => { const P = __kaam.pool(); return P ? P.indexOf(__kaam.quoteIdx) : __kaam.quoteIdx; })()")
        p0 = pos(); pg.locator("#quote-card .quote").click(position={"x": 8, "y": 8}); pg.wait_for_timeout(80); p1 = pos()
        if p1 != p0 + 1: raise RuntimeError(f"toucher en mode ordre : {p0} -> {p1}")
        pg.evaluate(SWIPE_JS, [-120]); pg.wait_for_timeout(80); p2 = pos()
        if p2 != p1 + 1: raise RuntimeError(f"glisser ← (suivante) : {p1} -> {p2}")
        pg.evaluate(SWIPE_JS, [120]); pg.wait_for_timeout(80); p3 = pos()
        if p3 != p2 - 1: raise RuntimeError(f"glisser → (précédente) : {p2} -> {p3}")
        pg.reload(); w.wait_ready(pg)
        if "sur" not in pg.inner_text(".quote-counter") or "ordre" not in (pg.get_attribute("#mast-set", "aria-label") or "") or not pg.evaluate("document.getElementById('mast-set').classList.contains('dot')"):
            raise RuntimeError("mode « Dans l'ordre » oublié au rechargement (ou point des réglages absent)")
        setting(pg, '[data-order="random"]')
        a = idx(); pg.evaluate(SWIPE_JS, [-120]); pg.wait_for_timeout(80); b = idx()
        if a == b: raise RuntimeError("glisser en aléatoire ne change pas de réplique")
        pg.evaluate(SWIPE_JS, [120]); pg.wait_for_timeout(80)
        if idx() != a: raise RuntimeError(f"glisser → en aléatoire ne revient pas à la précédente ({a} attendu, {idx()})")
        w.shot(pg, rec, "40-ordre")
        pg.close()
        return f"ordre : toucher {p0}->{p1}, glisser {p1}->{p2}->{p3}, mémorisé ; aléatoire : historique {a}->{b}->{a}"
    w.step("Ordre : toucher, glisser, mémorisation, historique aléatoire", s_order)

    def s_avis(rec):
        w.avis_posts.clear()
        pg = w.new_page(w.ctx(), {"kaam_verify": "1"}); w.goto(pg)
        sent = []
        for k in range(5):
            sent.append(pg.evaluate("__kaam.allQuotes[__kaam.quoteIdx].i"))
            pg.click("#avis-ok"); pg.wait_for_timeout(60)
        pg.wait_for_function("() => __kaam.avisFile.length === 0", timeout=6000)
        stored = pg.evaluate("JSON.parse(localStorage.getItem('kaam_avis_file') || '[]').length")
        pg.close()
        got = [a.get("i") for p in w.avis_posts if p for a in p.get("avis", [])]
        if got[:5] != sent: raise RuntimeError(f"avis envoyés {got} au lieu de {sent}")
        bad = [a for p in w.avis_posts for a in p["avis"] if not isinstance(a.get("ts"), (int, float)) or a.get("ok") is not True]
        if bad or stored: raise RuntimeError(f"avis mal formés {bad[:1]} ou file non vidée ({stored})")
        return f"{len(got)} avis envoyés en 1 lot, index i corrects, file vidée"
    w.step("Avis : lot envoyé à /api/avis (intercepté)", s_avis)

    def s_offline(rec):
        br = w.p.chromium.launch(args=["--mute-audio"], env={**os.environ, "PULSE_SERVER": "unix:/nonexistent/qa-silence"})
        ctx = w.make_context(br, dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True), sw=True)
        try:
            pg = ctx.new_page(); w.attach(pg)
            w.goto(pg)
            pg.wait_for_function("() => navigator.serviceWorker && navigator.serviceWorker.controller", timeout=15000)
            pg.wait_for_function("() => caches.open('kaamelott-data').then(c => c.match('/data.json')).then(Boolean)", timeout=15000)
            ctx.set_offline(True)
            out = []
            for path in ["", "?utm_source=sms"]:
                pg.goto(w.base + path, wait_until="domcontentloaded", timeout=15000)
                w.wait_ready(pg, 15000)
                if not pg.locator(MAIN_SEL).is_visible(): raise RuntimeError(f"hors ligne : pas de réplique sur /{path}")
                out.append("/" + path)
            off = pg.evaluate("document.getElementById('mast-sub').textContent")
            w.shot(pg, rec, "41-hors-ligne")
            ctx.set_offline(False)
            return f"Chromium, service worker actif, ouvert hors ligne : {', '.join(out)} ; en-tête « {off} »"
        finally:
            ctx.close(); br.close()
    w.step("Hors ligne : ouverture servie par le service worker", s_offline)

    def s_liefi(rec):
        br = w.p.chromium.launch(args=["--mute-audio"], env={**os.environ, "PULSE_SERVER": "unix:/nonexistent/qa-silence"})
        ctx = w.make_context(br, dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True), sw=True)
        try:
            pg = ctx.new_page(); w.attach(pg)
            w.goto(pg)
            pg.wait_for_function("() => navigator.serviceWorker && navigator.serviceWorker.controller", timeout=15000)
            pg.wait_for_function("() => caches.open('kaamelott-data').then(c => c.match('/data.json')).then(Boolean)", timeout=15000)
            pg.wait_for_function("() => caches.keys().then(k => k.some(n => /^kaamelott-v/.test(n)))", timeout=15000)
            ctx.add_cookies([{"name": "qa_lent", "value": "1", "url": w.base}])
            t0 = time.time()
            pg.goto(w.base, wait_until="domcontentloaded", timeout=30000)
            w.wait_ready(pg, 30000)
            dt = time.time() - t0
            if dt > 4.5: raise RuntimeError(f"réseau lent (6 s par fichier) : réplique affichée en {dt:.1f} s (attendu < 4,5 s)")
            return f"Chromium, réseau lent simulé (6 s par fichier) : réplique affichée en {dt:.1f} s depuis le cache"
        finally:
            ctx.close(); br.close()
    w.step("Réseau lent : ouverture depuis le cache en moins de 4,5 s", s_liefi)

    def s_badfav(rec):
        out = []
        for raw in ["null", "{}", '"x"', "[null]", "[{\"quote\":5}]", "pas du json"]:
            pg = w.new_page(w.ctx(), None, {"kaam_fav": raw}); w.goto(pg)
            if not pg.locator(MAIN_SEL).is_visible(): raise RuntimeError(f"kaam_fav={raw} : l'app ne s'ouvre pas")
            w.nav(pg, "favoris")
            kept = pg.evaluate("localStorage.getItem('kaam_fav')")
            pg.close()
            if kept != raw: raise RuntimeError(f"kaam_fav réécrit : {raw!r} -> {kept!r}")
            out.append(raw)
        return f"l'app s'ouvre et kaam_fav reste intact pour {len(out)} valeurs abîmées"
    w.step("Favoris abîmés : l'app s'ouvre, kaam_fav jamais réécrit", s_badfav)

    def s_render_err(rec):
        hits = []
        pg = w.new_page(w.ctx())
        pg.on("request", lambda r: "data.json" in r.url and hits.append(r.url))
        # le premier calcul de taille de texte du rendu lève une exception (bug d'affichage simulé)
        pg.add_init_script("(() => { const g = window.getComputedStyle; let n = 1; window.getComputedStyle = function (el, ...a) { if (el === document.documentElement && n > 0) { n--; throw new Error('qa : rendu cassé'); } return g.call(this, el, ...a); }; })()")
        w.expect_errors = True
        try:
            pg.goto(w.base, wait_until="domcontentloaded")
            pg.wait_for_selector("text=Erreur d’affichage", timeout=15000)
            w.shot(pg, rec, "42-erreur-affichage")
            pg.click("#btn-retry"); pg.wait_for_selector(MAIN_SEL)
        finally:
            w.expect_errors = False
        n = len(hits); pg.close()
        if n != 1: raise RuntimeError(f"{n} téléchargements de data.json (1 attendu)")
        return "« Erreur d’affichage » (pas « Serveur indisponible »), « Autre réplique » sans retélécharger"
    w.step("Bug d'affichage : message distinct, pas de nouveau téléchargement", s_render_err)

    def s_reentrant(rec):
        hits = []
        pg = w.new_page(w.ctx())
        # appareil hors ligne (navigator.onLine piloté), répliques jamais téléchargées
        pg.add_init_script("window.__qaOnline = false; Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get() { return window.__qaOnline; } });")
        pg.route("**/data.json*", lambda r: r.abort("internetdisconnected"))
        w.expect_errors = True
        try:
            pg.goto(w.base, wait_until="domcontentloaded")
            for k in range(3):
                pg.wait_for_selector("text=Hors ligne", timeout=15000)
                if k < 2: pg.click("#btn-retry")
            pg.unroute("**/data.json*")
            pg.on("request", lambda r: "data.json" in r.url and hits.append(r.url))
            pg.evaluate("() => { window.__qaOnline = true; window.dispatchEvent(new Event('online')); }")
            pg.wait_for_selector(MAIN_SEL, timeout=15000); pg.wait_for_timeout(1500)
        finally:
            w.expect_errors = False; pg.close()
        if len(hits) != 1: raise RuntimeError(f"{len(hits)} téléchargements de data.json au retour du réseau (1 attendu)")
        return "3 échecs hors ligne, retour du réseau : un seul démarrage, un seul téléchargement"
    w.step("Démarrage : jamais deux en parallèle après des échecs hors ligne", s_reentrant)

    def s_audio_guard(rec):
        pg = w.new_page(w.ctx(), {"kaam_audio_only": "1"})
        pg.route(HF_RE, lambda r: None)          # Hugging Face ne répond jamais
        w.goto(pg)
        pg.click("#btn-audio"); pg.wait_for_timeout(400)
        pg.click("#btn-audio"); pg.wait_for_timeout(150)
        c1 = pg.evaluate("document.getElementById('btn-audio').className")
        pg.click("#btn-audio")
        pg.wait_for_function("() => /Réessayer/.test(document.getElementById('btn-audio').textContent)", timeout=12000)
        c2 = pg.evaluate("document.getElementById('btn-audio').className")
        w.shot(pg, rec, "43-son-delai")
        pg.unroute_all(behavior="ignoreErrors"); pg.close()
        if "playing" in c1: raise RuntimeError(f"toucher pendant le chargement n'arrête pas : {c1}")
        if "playing" in c2: raise RuntimeError(f"bouton bloqué après le délai : {c2}")
        return "toucher pendant le chargement = arrêt ; après 10 s sans réponse : « Réessayer »"
    w.step("Son : délai de 10 s, toucher = arrêt", s_audio_guard)

    def s_quota(rec):
        pg = w.new_page(w.ctx()); w.goto(pg)
        pg.evaluate("() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'kaam_fav') throw new DOMException('plein', 'QuotaExceededError'); return o.call(this, k, v); }; }")
        pg.click("#btn-fav"); pg.wait_for_timeout(100)
        r = pg.evaluate("({ t: document.getElementById('btn-fav').innerText, p: document.getElementById('btn-fav').getAttribute('aria-pressed'), n: __kaam.favorites.length })")
        w.shot(pg, rec, "44-favori-non-enregistre")
        pg.close()
        if "Non enregistré" not in r["t"] or r["p"] != "false" or r["n"] != 0: raise RuntimeError(f"stockage plein : {r}")
        return "stockage plein : « Non enregistré », favori non coché, rien en mémoire"
    w.step("Stockage plein : « Non enregistré »", s_quota)

    def s_media(rec):
        # un fichier n'est téléchargé qu'une fois : préchargement terminé (fetch) OU lecture directe (media), jamais les deux
        from collections import Counter
        def watch(pg, log):
            pg.on("requestfinished", lambda r: HF_RE.match(r.url) and r.resource_type == "fetch" and log["fetch"].update([r.url.split("?")[0]]))
            pg.on("request", lambda r: HF_RE.match(r.url) and r.resource_type != "fetch" and log["media"].add(r.url.split("?")[0]))
        def dups(log):
            return [u for u in set(log["fetch"]) | log["media"] if log["fetch"][u] + (u in log["media"]) > 1]
        log = {"fetch": Counter(), "media": set()}
        pg = w.new_page(w.ctx(), {"kaam_audio_only": "1"}); watch(pg, log)
        w.goto(pg)
        for k in range(3):
            pg.click("#btn-audio"); pg.wait_for_function("() => !__kaam.player.paused")
            pg.click("#btn-next"); pg.wait_for_timeout(150)
        pg.close()
        if dups(log): raise RuntimeError(f"son : fichiers téléchargés deux fois : {dups(log)[:3]}")
        log = {"fetch": Counter(), "media": set()}
        pg = w.new_page(w.ctx(), {"kaam_video_only": "1"}); watch(pg, log)
        w.goto(pg)
        for k in range(10):
            pg.click("#btn-next"); pg.wait_for_timeout(100)
        pg.wait_for_timeout(1600)
        n = sum(log["fetch"].values()) + len(log["media"])
        st = pg.evaluate("() => ({ ix: typeof IX !== 'undefined' && !!IX, quiz: typeof quizByChar !== 'undefined' && !!quizByChar })")
        pg.close()
        if n > 16: raise RuntimeError(f"mode vidéo aléatoire : {n} fichiers téléchargés pour 11 répliques vues")
        if dups(log): raise RuntimeError(f"vidéo : fichiers téléchargés deux fois : {dups(log)[:3]}")
        if not (st["ix"] and st["quiz"]): raise RuntimeError(f"index de recherche / pool du quiz pas prêts en arrière-plan : {st}")
        return f"aucun double téléchargement ; vidéo aléatoire : {n} fichiers pour 11 répliques ; index et quiz prêts"
    w.step("Médias : ni double téléchargement ni préchargement inutile", s_media)

    def s_compat(rec):
        pg = w.new_page(w.ctx())
        pg.route("**/app.js", lambda r: r.fulfill(status=200, body="let x = ;", headers={"content-type": "text/javascript"}))
        w.expect_errors = True
        try:
            pg.goto(w.base, wait_until="domcontentloaded")
            pg.wait_for_selector("text=trop ancien", timeout=16000)
            w.shot(pg, rec, "45-appareil-ancien")
        finally:
            w.expect_errors = False; pg.close()
        return "app.js illisible : message « appareil trop ancien » (compat.js, ES5)"
    w.step("Appareil trop ancien : message au lieu d'un chargement sans fin", s_compat)


def scenario_sombre(w):
    """Mode sombre (réglage de l'appareil) : teintes iOS, texte lisible, couleurs des personnages lisibles en blanc."""
    S = {}

    def lum(c):
        import re as _re
        r, g, b = [int(x) for x in _re.findall(r"\d+", c)[:3]]
        f = lambda v: (v / 255 / 12.92) if v / 255 <= .04045 else ((v / 255 + .055) / 1.055) ** 2.4
        return .2126 * f(r) + .7152 * f(g) + .0722 * f(b)
    ratio = lambda a, b: (max(lum(a), lum(b)) + .05) / (min(lum(a), lum(b)) + .05)

    def s_main(rec):
        pg = S["pg"] = w.new_page(w.ctx()); w.goto(pg)
        r = pg.evaluate("""() => { const cs = e => getComputedStyle(document.querySelector(e));
          const metas = [...document.querySelectorAll('meta[name=theme-color]')].map(m => [m.media, m.content]);
          return { dark: matchMedia('(prefers-color-scheme: dark)').matches, body: cs('body').backgroundColor, ink: cs('body').color,
                   card: cs('#quote-card').backgroundColor, quote: cs('#quote-card .quote').color, who: cs('#btn-who').color,
                   tabs: cs('.tabs').backgroundColor, metas }; }""")
        w.shot(pg, rec, "50-sombre-replique")
        if not r["dark"]: raise RuntimeError("le navigateur n'est pas en mode sombre")
        if r["body"] != "rgb(0, 0, 0)": raise RuntimeError(f"fond sombre attendu #000 : {r['body']}")
        if ratio(r["ink"], r["body"]) < 15: raise RuntimeError(f"texte peu lisible sur fond sombre : {r['ink']}")
        if r["card"] != "rgba(0, 0, 0, 0)" and ratio(r["quote"], r["card"]) < 4.5: raise RuntimeError(f"réplique peu lisible sur la carte : {r['quote']} / {r['card']}")
        if ratio(r["who"], r["body"]) < 4.5: raise RuntimeError(f"nom (rouge) peu lisible : {r['who']}")
        if ["(prefers-color-scheme: dark)", "#000000"] not in r["metas"]: raise RuntimeError(f"theme-color sombre absent : {r['metas']}")
        return f"fond {r['body']}, texte {r['ink']}, pochette {r['card']} ; theme-color clair et sombre"
    w.step("Sombre : Répliques, contrastes, theme-color", s_main)

    def s_colors(rec):
        pg = S["pg"]
        w.nav(pg, "personnages")
        r = pg.evaluate("""() => ({ styled: document.querySelectorAll('#main-content [style*="--c"]').length,
            mono: [...document.querySelectorAll('.av.mono:not(.img):not(.more-av)')].map(a => [getComputedStyle(a).backgroundImage, !!a.querySelector('use[href="#i-person"]')]) })""")
        w.shot(pg, rec, "51-sombre-personnages")
        import re as _re
        def gray(bg):
            cols = _re.findall(r"rgb\((\d+), (\d+), (\d+)\)", bg)
            return cols and all(max(map(int, c)) - min(map(int, c)) <= 6 for c in cols)
        bad = [m for m in r["mono"] if not (gray(m[0]) and m[1])]
        if r["styled"] or not r["mono"] or bad: raise RuntimeError(f"couleur arbitraire : {r['styled']} aplats, monogrammes non gris {bad[:2]}")
        return f"aucun aplat de couleur ; {len(r['mono'])} personnages sans photo en silhouette grise"
    w.step("Sombre : aucun aplat de couleur, silhouettes grises", s_colors)

    def s_sheet(rec):
        pg = S["pg"]
        w.nav(pg, "citations")
        pg.click("#mast-set"); pg.wait_for_selector("#sheet:not([hidden]) #sh-title"); pg.wait_for_timeout(400)
        r = pg.evaluate("({ sheet: getComputedStyle(document.getElementById('sheet')).backgroundColor, cell: getComputedStyle(document.querySelector('#sheet .g')).backgroundColor })")
        w.shot(pg, rec, "52-sombre-reglages")
        if r["sheet"] != "rgb(28, 28, 30)" or r["cell"] != "rgb(44, 44, 46)": raise RuntimeError(f"feuille sombre : {r}")
        pg.click("#sheet-close")
        return f"feuille #1c1c1e, cellules #2c2c2e"
    w.step("Sombre : feuille Réglages", s_sheet)

    def s_quiz(rec):
        pg = S["pg"]
        w.nav(pg, "quiz"); pg.locator(".choice").first.click(); pg.wait_for_selector(".choice.right"); pg.wait_for_timeout(500)
        w.shot(pg, rec, "53-sombre-quiz")
        w.nav(pg, "personnages"); pg.locator(".idx-row").first.click(); pg.wait_for_selector("#detail-overlay:not(.hidden) .fiche-h h1"); pg.wait_for_timeout(400)
        w.shot(pg, rec, "54-sombre-fiche")
        pg.close()
    w.step("Sombre : quiz et fiche", s_quiz)

    def s_compact(rec):
        pg = w.new_page(w.ctx()); w.goto(pg)
        try: return check_compact(w, pg, rec, "58-sombre-titre-replie")
        finally: pg.close()
    w.step("Sombre : grand titre replié au défilement", s_compact)

def scenario_selection(w, se=False):
    """Sélection des épisodes (feuille à cases), Vidéo par défaut, migration des anciennes clés, écrans vides, quiz, recherche."""
    S = {}
    def page(prefs=None, raw=False):
        pg = w.new_page(w.ctx(), prefs, media_default=not raw); w.goto(pg); return pg
    def foot(pg): return pg.evaluate("document.getElementById('sel-foot').innerText.replace(/\\s+/g, ' ')")
    def nbsp(x): return re.sub(r"[  ]", " ", x)
    sfx = "-se" if se else ""

    if not se:
        def s_default(rec):
            pg = page(raw=True)
            pg.wait_for_selector("#qvideo")
            r = pg.evaluate("""() => ({ media: __kaam.media, all: __kaam.pool().every(i => __kaam.allQuotes[i].video),
                ls: localStorage.getItem('kaam_media'), lsSel: localStorage.getItem('kaam_sel'), scope: document.querySelector('#mast-scope .sl').textContent,
                vis: !document.getElementById('mast-scope').hidden })""")
            try: pg.wait_for_function("() => document.querySelector('#qvideo-slot').dataset.s === 'muted' || window.__qaRefused > 0", timeout=6000)
            except Exception: pass
            w.shot(pg, rec, "30-defaut-video")
            pg.close()
            if r["media"] != "video" or not r["all"] or r["ls"] is not None or r["lsSel"] is not None or not r["vis"] or r["scope"] != "Tout Kaamelott":
                raise RuntimeError(f"premier lancement : {r}")
            return f"Vidéo par défaut, rien d'écrit au chargement, sélecteur « {r['scope']} »"
        w.step("Premier lancement : Vidéo par défaut", s_default)

        def s_migr_m(rec):
            out = []
            for prefs, want in [({"kaam_video_only": "0", "kaam_audio_only": "0"}, "text"), ({"kaam_audio_only": "1"}, "audio")]:
                pg = page(prefs, raw=True)
                r = pg.evaluate("({ m: __kaam.media, v: !!document.getElementById('qvideo') })"); pg.close()
                if r["m"] != want or r["v"]: raise RuntimeError(f"{prefs} : {r}")
                out.append(want)
            return "Texte et Son choisis avant : respectés"
        w.step("Migration : affichage choisi respecté", s_migr_m)

        def s_migr(rec):
            pg = page({"kaam_source": "film"})
            lab = pg.inner_text("#mast-scope")
            for _ in range(5):
                pg.click("#btn-next"); pg.wait_for_timeout(60)
                if not pg.evaluate("!!__kaam.allQuotes[__kaam.quoteIdx].film"): raise RuntimeError("réplique hors film")
            pg.close()
            pg = page({"kaam_source": "serie"}); lab2 = pg.inner_text("#mast-scope"); pg.close()
            if lab.strip() != "Film" or lab2.strip() != "Toute la série · Inédits · Dies Iræ · Pilotes": raise RuntimeError(f"libellés {lab!r} {lab2!r}")
            return f"film → « {lab.strip()} », série → « {lab2.strip()} »"
        w.step("Migration : ancienne source", s_migr)

    def s_sheet(rec):
        pg = S["pg"] = page(raw=True)
        pg.click("#mast-scope"); pg.wait_for_selector("#sheet:not([hidden]) #sel-foot")
        f0 = nbsp(foot(pg))
        pg.click('[data-part="all"]'); f1 = foot(pg)
        pg.click('[data-part="L1"]'); pg.click('[data-part="film"]'); f2 = nbsp(foot(pg))
        c = pg.evaluate("(() => { const c = __kaam.counts; return c.L1.v + c.film.v; })()")
        aria = pg.evaluate("[...document.querySelectorAll('#sheet [data-part]')].map(b => [b.dataset.part, b.getAttribute('role'), b.getAttribute('aria-checked')])")
        pg.wait_for_timeout(300)
        w.shot(pg, rec, "31-selection" + sfx)
        if se:   # le pied ne recouvre pas la dernière ligne une fois la liste défilée en bas
            pg.evaluate("document.getElementById('sheet').scrollTop = 1e5"); pg.wait_for_timeout(200)
            ov = pg.evaluate("() => { const r = document.querySelector('[data-part=in3]').getBoundingClientRect(), f = document.getElementById('sel-foot').getBoundingClientRect(); return r.bottom - f.top; }")
            w.shot(pg, rec, "31b-selection-bas" + sfx)
            if ov > 0.5: raise RuntimeError(f"le pied recouvre la dernière ligne ({ov} px)")
        pg.click("#sheet-close"); pg.wait_for_selector("#sheet", state="hidden")
        lab = pg.inner_text("#mast-scope").strip(); ls = pg.evaluate("localStorage.getItem('kaam_sel')")
        errs = []
        tot = sum(1 for _ in [0])
        if not f0.startswith(pg.evaluate("__kaam.allQuotes.filter(q => q.video).length.toLocaleString('fr-FR')").replace(" ", " ") + " scènes"): errs.append(f"pied initial {f0!r}")
        if "Aucune sélection" not in f1: errs.append(f"pied vide {f1!r}")
        if not f2.startswith(nbsp(f"{c:,}".replace(",", " ")) + " scènes"): errs.append(f"pied {f2!r} ({c})")
        if lab != "Livre I · Film" or ls != '["L1","film"]': errs.append(f"libellé {lab!r} / {ls}")
        if any(r != "checkbox" for _, r, _ in aria) or dict((p, a) for p, _, a in aria).get("L1") != "true": errs.append(f"aria {aria}")
        for k in range(8):
            pg.click("#btn-next"); pg.wait_for_timeout(60)
            inv = pg.evaluate("() => { const q = __kaam.allQuotes[__kaam.quoteIdx]; return ['L1', 'film'].includes(q.part) && !!q.video; }")
            if not inv: errs.append(f"réplique hors sélection à la navigation {k}"); break
        pg.reload(); w.wait_ready(pg)
        lab2 = pg.inner_text("#mast-scope").strip()
        if lab2 != lab: errs.append(f"sélection oubliée au rechargement : {lab2!r}")
        pg.close()
        if errs: raise RuntimeError(" ; ".join(errs))
        return f"pied « {f0} » → « {f1} » → « {f2} » ; « {lab} » mémorisé ; navigation dans la sélection"
    w.step("Feuille Sélection : cases, total en direct, mémorisation", s_sheet)

    def s_empty(rec):
        pg = page({"kaam_sel": "[]"}, raw=True)
        r = pg.evaluate("({ t: document.querySelector('.empty.sel0 b')?.textContent, card: !!document.getElementById('quote-card') })")
        w.shot(pg, rec, "32-vide" + sfx)
        pg.click("#empty-sel"); pg.wait_for_selector("#sheet:not([hidden]) #sel-foot")
        pg.close()
        if r["t"] != "Aucune sélection" or r["card"]: raise RuntimeError(f"écran vide : {r}")
        pg = page({"kaam_sel": '["in3"]'}, raw=True)
        r = pg.evaluate("({ t: document.querySelector('.empty.sel0 b')?.textContent, txt: document.querySelector('.empty.sel0').innerText })")
        w.shot(pg, rec, "33-inedit3" + sfx)
        pg.click("#empty-text"); pg.wait_for_selector("#quote-card")
        r2 = pg.evaluate("({ m: __kaam.media, ls: localStorage.getItem('kaam_media'), part: __kaam.allQuotes[__kaam.quoteIdx].part })")
        pg.close()
        if r["t"] != "Aucune scène" or "Dolor" not in r["txt"] or r2 != {"m": "text", "ls": "text", "part": "in3"}: raise RuntimeError(f"Inédit 3 : {r} {r2}")
        pg = page({"kaam_sel": '["in2","in3"]'}, raw=True)
        pg.click("#mast-scope"); pg.wait_for_selector("#sel-foot")
        f = nbsp(foot(pg)); pg.close()
        if not f.startswith("79 scènes") or "Inédit 3 se lit en Texte seulement." not in f: raise RuntimeError(f"pied in2+in3 : {f!r}")
        return f"« Aucune sélection » → Choisir ; Inédit 3 seul : « Aucune scène » → Lire en Texte ; pied « {f} »"
    w.step("Écrans vides et Inédit 3", s_empty)

    def s_quiz(rec):
        pg = page({"kaam_sel": '["L4"]'})
        w.nav(pg, "quiz")
        parts = []
        for k in range(6):
            parts.append(pg.evaluate("__kaam.quizState.current.part"))
            if k < 5: pg.click("#quiz-next"); pg.wait_for_timeout(60)
        vis = pg.evaluate("!document.getElementById('mast-scope').hidden")
        w.shot(pg, rec, "34-quiz-portee" + sfx)
        pg.click("#quiz-daily"); pg.wait_for_selector("#quiz-free")
        dvis = pg.evaluate("!document.getElementById('mast-scope').hidden")
        pg.close()
        pg = page({"kaam_sel": '["in3"]'}); w.nav(pg, "quiz")
        st = pg.inner_text("#quiz-stat"); pg.close()
        if set(parts) != {"L4"} or not vis or dvis or "Pas assez de scènes" not in st: raise RuntimeError(f"quiz : {parts} vis={vis} jour={dvis} {st!r}")
        return f"6 questions du Livre IV ; repli annoncé « {st} » ; pas de sélecteur sur la question du jour"
    w.step("Quiz : suit la sélection", s_quiz)

    def s_search(rec):
        pg = page({"kaam_sel": '["L2"]'})
        w.nav(pg, "recherche")
        pg.fill("#search-input", "compote")
        pg.wait_for_function("() => document.querySelectorAll('#search-results .ent').length > 0")
        a = nbsp(pg.inner_text("#search-results .res-n"))
        pg.click('#search-scope [data-scope="sel"]'); pg.wait_for_timeout(150)
        b = nbsp(pg.inner_text("#search-results .res-n"))
        w.shot(pg, rec, "35-recherche-portee" + sfx)
        pg.close()
        pg = page(); w.nav(pg, "recherche"); pg.fill("#search-input", "compote"); pg.wait_for_timeout(200)
        hid = pg.evaluate("document.getElementById('search-scope').hidden"); pg.close()
        m = re.match(r"(\d+) répliques?$", a); m2 = re.match(r"(\d+) répliques? · (\d+) partout$", b)
        if not m or not m2 or m2.group(2) != m.group(1) or int(m2.group(1)) >= int(m.group(1)) or not hid: raise RuntimeError(f"{a!r} / {b!r} / segment caché sans sélection : {hid}")
        return f"« {a} » puis « {b} »"
    w.step("Recherche : Partout puis la sélection", s_search)

    def s_pers(rec):
        out = []
        for sel in ['["film"]', None]:
            pg = page({"kaam_sel": sel} if sel else None); w.nav(pg, "personnages")
            out.append(pg.evaluate("[...document.querySelectorAll('.idx-row')].find(r => r.dataset.char === 'ARTHUR')?.querySelector('.c').textContent"))
            pg.close()
        if out[0] != out[1] or not out[0]: raise RuntimeError(f"Personnages filtrés : {out}")
        return f"Arthur : « {out[0]} » dans les deux cas"
    if not se: w.step("Personnages non filtrés", s_pers)

    if se:
        def s_se(rec):
            pg = page({"kaam_sel": '["L1","L3","L5","film","in1","in2"]'}, raw=True)
            r = pg.evaluate("""() => { const b = document.getElementById('mast-scope').getBoundingClientRect(), n = document.getElementById('btn-next').getBoundingClientRect(),
                t = document.querySelector('.tabs').getBoundingClientRect(), sl = document.querySelector('#mast-scope .sl');
                return { h: b.height, right: b.right, vw: innerWidth, ell: sl.scrollWidth > sl.clientWidth, next: n.bottom, tabs: t.top,
                         ov: document.documentElement.scrollWidth - innerWidth }; }""")
            w.shot(pg, rec, "36-se-portee")
            pg.close()
            if r["h"] > 26.5 or r["right"] > r["vw"] or r["next"] > r["tabs"] + .5 or r["ov"] > 1: raise RuntimeError(f"SE : {r}")
            return f"sélecteur {r['h']:.0f} px de haut (ellipse : {r['ell']}), « Autre » au-dessus des onglets"
        w.step("SE : rien de coupé", s_se)


def scenario_lancement(w):
    """Écran de lancement : noir au K dès le premier rendu, sans CSS ni JS ; fondu une fois la réplique affichée."""
    def s_first(rec):
        out = []
        for scheme in ("light", "dark"):
            opts, kw = (w.ctx(), w._ctx_kw)[1]
            ctx = w.make_context(w.browser, {**opts, "color_scheme": scheme}, **kw)
            try:
                pg = ctx.new_page(); w.attach(pg)
                # ni style.css ni app.js : le premier rendu ne doit dépendre que d'index.html
                pg.route("**/style.css", lambda r: r.fulfill(status=200, body="", headers={"content-type": "text/css"}))
                pg.route("**/app.js", lambda r: r.fulfill(status=200, body="", headers={"content-type": "text/javascript"}))
                pg.goto(w.base, wait_until="domcontentloaded")
                pg.wait_for_timeout(300)
                r = pg.evaluate("""() => { const k = document.querySelector('#launch .launch-k').getBoundingClientRect();
                    return { bg: getComputedStyle(document.documentElement).backgroundColor, launch: getComputedStyle(document.getElementById('launch')).backgroundColor,
                             kh: k.height, kc: k.top + k.height / 2, vh: innerHeight }; }""")
                w.shot(pg, rec, f"70-lancement-sans-css-{scheme}")
                if r["bg"] != "rgb(0, 0, 0)" or r["launch"] != "rgb(0, 0, 0)" or abs(r["kh"] - 64) > .5 or abs(r["kc"] - r["vh"] / 2) > 1: raise RuntimeError(f"{scheme} : {r}")
                out.append(scheme)
                pg.unroute_all(behavior="ignoreErrors"); pg.close()
            finally:
                ctx.close()
        return "noir et K de 64 px centré sans style.css ni app.js, en clair et en sombre"
    w.step("Lancement : premier rendu noir au K (sans CSS ni JS)", s_first)

    def s_fade(rec):
        pg = w.new_page(w.ctx()); w.goto(pg)
        pg.wait_for_function("() => !document.getElementById('launch')", timeout=3000)
        r = pg.evaluate("({ cls: document.documentElement.className, style: document.documentElement.getAttribute('style') || '', cs: document.getElementById('meta-cs').content, body: getComputedStyle(document.body).backgroundColor })")
        w.shot(pg, rec, "71-apres-lancement")
        pg.close()
        if "launching" in r["cls"] or "background" in r["style"] or r["cs"] != "light dark" or r["body"] != "rgb(255, 255, 255)": raise RuntimeError(f"après le lancement : {r}")
        return "écran de lancement retiré après la première réplique, fond rendu au mode clair"
    w.step("Lancement : fondu puis retrait", s_fade)

    def s_slow(rec):
        pg = w.new_page(w.ctx())
        hold = {}
        def slow(route):
            hold["r"] = route
        pg.route("**/data.json*", slow)
        pg.goto(w.base, wait_until="domcontentloaded")
        pg.wait_for_timeout(1500)
        r = pg.evaluate("({ on: document.querySelector('#launch .launch-slow').classList.contains('on'), op: getComputedStyle(document.querySelector('#launch .launch-slow')).opacity })")
        w.shot(pg, rec, "72-lancement-lent")
        pg.unroute_all(behavior="ignoreErrors")
        if hold.get("r"):
            try: hold["r"].continue_()
            except Exception: pass
        w.wait_ready(pg); pg.close()
        if not r["on"]: raise RuntimeError(f"barre absente après 1 s : {r}")
        return "réseau lent : la barre apparaît sous le K après 1 s"
    w.step("Lancement lent : barre après 1 s", s_slow)


def scenario_mini(w):
    """Mini-lecteur : le son continue quand on change d'onglet ; lecture / pause, retour à la réplique, fermeture."""
    S = {}
    state = "() => ({ mini: !document.getElementById('mini').hidden, paused: __kaam.player.paused, ended: __kaam.player.ended, idx: __kaam.quoteIdx, txt: document.getElementById('mini').innerText })"

    def s_tab(rec):
        pg = S["pg"] = w.new_page(w.ctx(), {"kaam_audio_only": "1"}); w.goto(pg)
        S["idx"] = pg.evaluate("__kaam.quoteIdx")
        if not pg.evaluate("document.getElementById('mini').hidden"): raise RuntimeError("mini-lecteur visible sur l'écran Répliques")
        pg.click("#btn-audio"); pg.wait_for_function("() => !__kaam.player.paused && __kaam.player.currentTime > 0", timeout=6000)
        pg.evaluate("__kaam.player.loop = true")            # le son muet du banc dure 1 s : on le fait durer
        w.nav(pg, "personnages")
        r = pg.evaluate(state)
        w.shot(pg, rec, "55-mini-lecteur")
        if not r["mini"] or r["paused"]: raise RuntimeError(f"le son ne continue pas dans le mini-lecteur : {r}")
        name = pg.evaluate("__kaam.allQuotes[__kaam.quoteIdx].name")
        if name.split()[0].lower() not in r["txt"].lower(): raise RuntimeError(f"mini-lecteur sans le bon nom : {r['txt']!r}")
        pg.locator(".idx-row").first.click(); pg.wait_for_selector("#detail-overlay:not(.hidden) .fiche-h h1")
        r2 = pg.evaluate(state)
        if not r2["mini"] or r2["paused"]: raise RuntimeError(f"fiche ouverte : le son s'est arrêté : {r2}")
        return "le son continue sur Personnages et dans la fiche ; mini-lecteur visible avec la réplique"
    w.step("Mini-lecteur : le son continue d'un onglet à l'autre", s_tab)

    def s_ctrl(rec):
        pg = S["pg"]
        pg.click("#mini-play"); pg.wait_for_timeout(150)
        if not pg.evaluate("__kaam.player.paused"): raise RuntimeError("Pause du mini-lecteur sans effet")
        lab = pg.evaluate("document.getElementById('mini-play').getAttribute('aria-label')")
        pg.click("#mini-play"); pg.wait_for_function("() => !__kaam.player.paused", timeout=5000)
        pg.click("#mini-open"); pg.wait_for_function("() => document.querySelector('.nav-btn[data-view=citations]').classList.contains('active')")
        pg.wait_for_timeout(200)
        r = pg.evaluate(state)
        cls = pg.evaluate("document.getElementById('btn-audio').className")
        w.shot(pg, rec, "56-mini-retour")
        if r["idx"] != S["idx"] or r["paused"] or r["mini"] or "playing" not in cls:
            raise RuntimeError(f"retour à la réplique : {r} bouton={cls}")
        w.nav(pg, "favoris")
        pg.click("#mini-close"); pg.wait_for_timeout(150)
        r3 = pg.evaluate(state)
        pg.close()
        if r3["mini"] or not r3["paused"]: raise RuntimeError(f"Fermer n'arrête pas le son : {r3}")
        return f"Pause / Lecture ({lab}), retour à la même réplique sans couper le son, Fermer arrête tout"
    w.step("Mini-lecteur : pause, retour à la réplique, fermer", s_ctrl)

    def s_text(rec):
        pg = w.new_page(w.ctx()); w.goto(pg)
        pg.evaluate("() => { const A = __kaam.allQuotes; __kaam.quoteIdx = A.findIndex(q => !q.audio && !q.video); __kaam.render(); }")
        r = pg.evaluate("""() => { const vis = e => !!e && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
          const txt = document.getElementById('main-content').innerText;
          return { audio: !!document.getElementById('btn-audio'), video: !!document.getElementById('btn-video'), nil: document.querySelectorAll('.nil').length,
                   scrub: vis(document.querySelector('#scrub .track')), dead: /Texte seul|Pas de scène|--:--|0:00/.test(txt) }; }""")
        w.shot(pg, rec, "57-texte-seul")
        # même règle dans un menu de liste : ni « Écouter » ni « Voir la scène » pour une réplique qui n'en a pas
        q = pg.evaluate("__kaam.allQuotes[__kaam.quoteIdx].quote")
        pg.click("#btn-fav"); w.nav(pg, "favoris"); pg.locator(".ent-more").first.click(); pg.wait_for_selector("#sheet [data-m]")
        acts = pg.evaluate("[...document.querySelectorAll('#sheet [data-m]')].map(b => b.dataset.m)")
        pg.close()
        if r["audio"] or r["video"] or r["nil"] or r["scrub"] or r["dead"] or "audio" in acts or "video" in acts:
            raise RuntimeError(f"réplique sans son ni scène : {r}, menu {acts}")
        return f"ni lecteur, ni barre, ni « Texte seul », ni « Pas de scène » : masqués ; menu {acts}"
    w.step("Réplique sans son ni scène : rien de grisé, tout est masqué", s_text)

    def s_contrast(rec):
        # mode clair : texte blanc des boutons rouges, rouge du texte, gris tertiaire, onglet actif ≥ 4,5:1
        pg = w.new_page(w.ctx(), {"kaam_verify": "1"}); w.goto(pg)
        r = pg.evaluate("""() => { const cs = e => getComputedStyle(document.querySelector(e));
          return [['OK', cs('#avis-ok').color, cs('#avis-ok').backgroundColor], ['Problème', cs('#avis-ko').color, cs('#avis-ko').backgroundColor],
                  ['nom', cs('#btn-who').color, cs('body').backgroundColor], ['résumé', cs('.bar-sum').color, cs('body').backgroundColor],
                  ['compteur', cs('.quote-counter').color, cs('body').backgroundColor], ['onglet actif', cs('.nav-btn.active').color, cs('.tabs').backgroundColor]]; }""")
        pg.close()
        import re as _re
        def lum(c):
            v = [int(x) / 255 for x in _re.findall(r"\d+", c)[:3]]
            f = lambda x: x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4
            return .2126 * f(v[0]) + .7152 * f(v[1]) + .0722 * f(v[2])
        low = [(n, round((max(lum(a), lum(b)) + .05) / (min(lum(a), lum(b)) + .05), 2)) for n, a, b in r]
        bad = [x for x in low if x[1] < 4.5]
        if bad: raise RuntimeError(f"contraste < 4,5:1 : {bad}")
        return "contrastes ≥ 4,5:1 : " + ", ".join(f"{n} {v}" for n, v in low)
    w.step("Contrastes (clair) : boutons rouges, rouge du texte, gris", s_contrast)

    def s_qcut(rec):
        pg = w.new_page(w.ctx()); w.goto(pg)
        try: return quiz_never_cut(w, pg, rec, 10, "59-quiz-jamais-coupe")
        finally: pg.close()
    w.step("Quiz (iPhone 13, clair) : question jamais coupée, carte neutre", s_qcut)

IMGS = """() => { const ok = im => im.complete && im.naturalWidth > 0;
  const q = s => [...document.querySelectorAll(s)];
  const vis = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; };
  return { posters: q('.poster').length, pimg: q('.poster .pc.img img').filter(ok).length, pnoimg: q('.poster .pc:not(.img)').length,
           rows: q('.idx-row').filter(vis).length, rimg: q('.idx-row .av.img img').filter(vis).filter(ok).length,
           ini: q('.idx-row .av:not(.img)').filter(vis).map(a => a.textContent.trim()).filter(Boolean),
           broken: q('img').filter(im => im.complete && !im.naturalWidth).length }; }"""


def scenario_portraits(w):
    """Portraits des personnages (img/perso/, perso.json) : chargés, en clair et en sombre ; repli sur l'initiale sans image."""
    import re as _re
    def lum(c):
        v = [int(x) / 255 for x in _re.findall(r"\d+", c)[:3]]
        f = lambda x: x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4
        return .2126 * f(v[0]) + .7152 * f(v[1]) + .0722 * f(v[2])
    ratio = lambda a, b: (max(lum(a), lum(b)) + .05) / (min(lum(a), lum(b)) + .05)

    def check_loaded(rec, scheme):
        ctx = w.new_ctx() if scheme == "light" else None
        if scheme == "dark":
            w.ctx(); opts, kw = w._ctx_kw
            ctx = w.make_context(w.browser, {**opts, "color_scheme": "dark"}, **kw)
        try:
            pg = w.new_page(ctx, {"kaam_audio_only": "1"}); w.goto(pg)
            n = pg.evaluate("Object.keys(__kaam.perso).length")
            if n < 120: raise RuntimeError(f"perso.json : {n} portraits seulement")
            # pochette : rond du personnage en photo
            pg.evaluate("() => { const A = __kaam.allQuotes; __kaam.quoteIdx = A.findIndex(q => q.name === 'ARTHUR' && q.audio); __kaam.render(); }")
            pg.wait_for_function("() => { const i = document.querySelector('#quote-card.photo .bgimg img'); return i && i.complete && i.naturalWidth > 0; }", timeout=6000)
            pg.click("#btn-audio"); pg.wait_for_timeout(200); pg.evaluate("__kaam.player.loop = true")
            w.nav(pg, "personnages")
            # cartes visibles (les suivantes, hors écran à droite, se chargent au défilement : loading="lazy")
            pg.wait_for_function("() => [...document.querySelectorAll('.poster img')].filter(i => i.getBoundingClientRect().left < innerWidth).every(i => i.complete && i.naturalWidth > 0)", timeout=8000)
            r = pg.evaluate(IMGS)
            mini = pg.evaluate("() => { const i = document.querySelector('#mini .tile img'); return !!i && i.complete && i.naturalWidth > 0; }")
            w.shot(pg, rec, f"60-portraits-{scheme}")
            if r["posters"] < 8 or r["pimg"] < 2 or r["pnoimg"]: raise RuntimeError(f"cartes « Les plus présents » sans photo : {r}")
            if r["broken"]: raise RuntimeError(f"{r['broken']} image(s) cassée(s)")
            if not mini: raise RuntimeError("mini-lecteur sans portrait")
            pg.evaluate("document.getElementById('pers-scroll').scrollTop = 600"); pg.wait_for_timeout(700)
            r2 = pg.evaluate(IMGS)
            if r2["rows"] < 4 or r2["rimg"] < r2["rows"] - 1: raise RuntimeError(f"vignettes de la liste non chargées : {r2}")
            pg.locator(".poster").first.click()
            pg.wait_for_function("() => { const i = document.querySelector('.fiche-h.photo .hero img'); return i && i.complete && i.naturalWidth > 0; }", timeout=8000)
            pg.wait_for_timeout(300)
            w.shot(pg, rec, f"61-fiche-photo-{scheme}")
            f = {"h1": text_on_image_ratio(pg, ".fiche-h h1"), "part": text_on_image_ratio(pg, ".fiche-h .part")}
            if f["h1"] < 4.5 or f["part"] < 4.5: raise RuntimeError(f"titre de la fiche peu lisible sur la photo (mesuré) : {f}")
            w.nav(pg, "quiz")
            pg.wait_for_function("() => [...document.querySelectorAll('.choice .l img')].every(i => i.complete && i.naturalWidth > 0)", timeout=8000)
            nq = pg.evaluate("document.querySelectorAll('.choice .l.img img').length")
            if nq != 4: raise RuntimeError(f"quiz : {nq} ronds en photo sur 4")
            pg.close()
            return f"{n} portraits ; {r['pimg']} cartes, {r2['rimg']}/{r2['rows']} vignettes visibles, mini-lecteur, fiche (titre {f['h1']:.1f}:1, sous-titre {f['part']:.1f}:1 mesurés sur la photo), 4 ronds du quiz"
        finally:
            ctx.close()
    def card_contrast(rec, scheme):
        opts, kw = (w.ctx(), w._ctx_kw)[1]
        ctx = w.make_context(w.browser, {**opts, "color_scheme": scheme}, **kw)
        try:
            pg = w.new_page(ctx); w.goto(pg)
            out, bad = [], []
            for name in ["ARTHUR", "LÉODAGAN", "KARADOC", "GUENIÈVRE", "LA DAME DU LAC"]:
                ok = pg.evaluate("""n => { const A = __kaam.allQuotes, i = A.findIndex(q => q.name === n && q.quote.length > 60); if (i < 0) return false;
                    __kaam.quoteIdx = i; __kaam.render(); return true; }""", name)
                if not ok: continue
                try: pg.wait_for_function("() => { const i = document.querySelector('#quote-card .bgimg img'); return !i || (i.complete && i.naturalWidth > 0); }", timeout=6000)
                except Exception: pass
                pg.wait_for_timeout(250)
                info = pg.evaluate("""() => { const c = document.getElementById('quote-card'); return { photo: c.classList.contains('photo'),
                    bg: getComputedStyle(c).backgroundColor, styled: c.hasAttribute('style'), cote: !!c.querySelector('.cote, .quote-hint') }; }""")
                if info["styled"] or info["cote"]: bad.append(f"{name} : aplat ou mention dans la carte {info}")
                if info["photo"]:
                    rt = text_on_image_ratio(pg, "#quote-card .quote"); out.append(f"{name.title()} {rt:.1f}")
                    if rt < 4.5: bad.append(f"{name} : {rt:.2f}:1")
                elif info["bg"] not in ("rgb(245, 245, 247)", "rgb(28, 28, 30)"): bad.append(f"{name} : fond {info['bg']}")
            w.shot(pg, rec, f"64-carte-photo-{scheme}")
            pg.close()
            if bad or len(out) < 4: raise RuntimeError(f"carte : {bad} ({out})")
            return "texte blanc sur photo floutée, contraste mesuré (pixel le plus clair) : " + ", ".join(out)
        finally:
            ctx.close()
    w.step("Carte sur photo floutée : contraste mesuré ≥ 4,5:1 (clair)", lambda rec: card_contrast(rec, "light"))
    w.step("Carte sur photo floutée : contraste mesuré ≥ 4,5:1 (sombre)", lambda rec: card_contrast(rec, "dark"))
    w.step("Portraits chargés (clair)", lambda rec: check_loaded(rec, "light"))
    w.step("Portraits chargés (sombre)", lambda rec: check_loaded(rec, "dark"))

    def s_fallback(rec):
        ctx = w.new_ctx()
        w.expect_errors = True             # images refusées exprès : les erreurs de chargement sont attendues
        try:
            pg = w.new_page(ctx)
            pg.route("**/img/perso/**", lambda r: r.fulfill(status=404, body="absent"))
            w.goto(pg); w.nav(pg, "personnages"); pg.wait_for_timeout(800)
            r = pg.evaluate(IMGS)
            w.shot(pg, rec, "62-portraits-absents")
            pg.locator(".poster").first.click(); pg.wait_for_selector("#detail-overlay:not(.hidden) .fiche-h h1"); pg.wait_for_timeout(600)
            f = pg.evaluate("() => { const h = document.querySelector('.fiche-h'); return { photo: h.classList.contains('photo'), img: !!h.querySelector('img'), bg: getComputedStyle(h).backgroundColor, ink: getComputedStyle(h.querySelector('h1')).color }; }")
            w.shot(pg, rec, "63-fiche-sans-photo")
            pg.close()
            # liste des portraits elle-même absente : initiales partout, aucune image demandée
            pg = w.new_page(ctx)
            pg.route("**/perso.json*", lambda r: r.fulfill(status=404, body="absent", headers={"content-type": "text/plain"}))
            w.goto(pg); w.nav(pg, "personnages"); pg.wait_for_timeout(300)
            r3 = pg.evaluate("() => ({ imgs: document.querySelectorAll('#main-content img').length, ini: [...document.querySelectorAll('.poster .pc')].map(x => x.querySelector('use[href=\"#i-person\"]') ? 'P' : x.textContent.trim()) })")
            pg.close()
        finally:
            w.expect_errors = False; ctx.close()
        errs = []
        if r["pimg"] or r["pnoimg"] < 3 or r["broken"]: errs.append(f"cartes : {r}")
        if r["ini"]: errs.append(f"initiales colorées encore là : {r['ini'][:5]}")
        if f["photo"] or f["img"] or f["bg"] != "rgb(245, 245, 247)" or f["ink"] != "rgb(29, 29, 31)": errs.append(f"fiche sans photo (fond neutre attendu) : {f}")
        if r3["imgs"] or not r3["ini"] or not all(x == "P" for x in r3["ini"]): errs.append(f"sans perso.json : {r3}")
        if errs: raise RuntimeError(" ; ".join(errs))
        return f"images refusées : {r['posters']} cartes et vignettes en silhouette grise, fiche sur fond neutre ; sans perso.json : aucune image demandée"
    w.step("Portraits absents : repli sur la silhouette grise", s_fallback)


def scenario_pilotes(w):
    """Pilotes et Dies Iræ (répliques transcrites) : mention « Transcription » à côté de la source, « Interprété par »
    quand l'interprète n'est pas celui de la série, et jamais la photo du personnage de la série sur cette réplique."""
    def check(rec, scheme):
        opts, kw = (w.ctx(), w._ctx_kw)[1]
        ctx = w.make_context(w.browser, {**opts, "color_scheme": scheme}, **kw)
        try:
            pg = w.new_page(ctx, {"kaam_audio_only": "1"}); w.goto(pg)
            res = {}
            for nom, js in [("autre", "q => q.part === 'pil' && q.acteur && q.audio"), ("meme", "q => q.part === 'pil' && !q.acteur && q.audio && q.name === 'PERCEVAL'"),
                            ("dies", "q => q.part === 'dies' && q.audio && !q.acteur"), ("dies-autre", "q => q.part === 'dies' && q.acteur && q.audio")]:
                ok = pg.evaluate(f"() => {{ const A = __kaam.allQuotes, i = A.findIndex({js}); if (i < 0) return false; __kaam.quoteIdx = i; __kaam.render(); return A[i].acteur || true; }}")
                if not ok:
                    # Dies Iræ ajouté en second : exigé dès que data.json en contient
                    if nom.startswith("dies") and not any("court métrage" in it.get("character", "") for it in data_json()): continue
                    if nom == "dies-autre": continue          # aucune réplique de Dies Iræ retenue n'a un autre interprète
                    raise RuntimeError(f"aucune réplique « {nom} » dans data.json")
                pg.wait_for_timeout(300)
                r = pg.evaluate("""() => { const c = document.getElementById('quote-card'), m = document.querySelector('.meta');
                    return { photo: c.classList.contains('photo'), img: !!c.querySelector('.bgimg img'), src: m.querySelector('.src')?.textContent || '',
                             by: m.querySelector('.src.by')?.textContent || '', vis: !!m.querySelector('.trs')?.getClientRects().length }; }""")
                res[nom] = r
                if "Transcription" not in r["src"] or not r["vis"]: raise RuntimeError(f"{nom} : « Transcription » absente ou cachée : {r}")
                if nom in ("autre", "dies-autre"):
                    if r["by"] != f"Interprété par {ok}": raise RuntimeError(f"{nom} : ligne interprète {r['by']!r} (attendu {ok!r})")
                    if r["photo"] or r["img"]: raise RuntimeError(f"{nom} : photo du personnage de la série sur un autre interprète")
                elif r["by"]: raise RuntimeError(f"{nom} : « Interprété par » sur un acteur de la série : {r['by']!r}")
                w.shot(pg, rec, f"70-pilote-{nom}-{scheme}")
            pg.close()
            return " ; ".join(f"{k} : {v['src']}{' / ' + v['by'] if v['by'] else ''}" for k, v in res.items())
        finally:
            ctx.close()
    w.step("Pilotes et Dies Iræ : Transcription, Interprété par, sans photo de la série (clair)", lambda rec: check(rec, "light"))
    w.step("Pilotes et Dies Iræ : Transcription, Interprété par, sans photo de la série (sombre)", lambda rec: check(rec, "dark"))

    def migration(rec):
        ctx = w.new_ctx()
        try:
            old = json.dumps(["L1", "L2", "L3", "L4", "L5", "L6", "film", "in1", "in2", "in3"])
            pg = w.new_page(ctx, extra_ls={"kaam_sel": old}); w.goto(pg)
            a = pg.evaluate("() => ({ sel: __kaam.sel ? [...__kaam.sel] : null, all: document.getElementById('mast-sub')?.textContent || '' })")
            pg.close()
            pg = w.new_page(ctx, extra_ls={"kaam_sel": old, "kaam_sel_v2": "1"}); w.goto(pg)
            b = pg.evaluate("() => (__kaam.sel ? [...__kaam.sel] : null)")
            pg.close()
        finally:
            ctx.close()
        if a["sel"] is not None and ("pil" not in a["sel"] or "dies" not in a["sel"]): raise RuntimeError(f"ancienne sélection complète : pilotes absents {a}")
        if b is not None and ("pil" in b or "dies" in b): raise RuntimeError(f"choix récent sans pilotes non respecté : {b}")
        return f"ancienne sélection complète → {a['sel']} ; choix récent respecté → {b}"
    w.step("Sélection enregistrée avant les pilotes : reste « Tout Kaamelott »", migration)

    def retour(rec):
        """« Retour » : la carte ne doit jamais prendre la classe .back (barre des fiches, position absolue en haut) ;
        après 3 « Autre » puis 3 « Retour », la réplique ne chevauche pas l'en-tête (bug du 14/10)."""
        CHK = """() => { const c = document.getElementById('quote-card'), q = c && c.querySelector('.quote'), m = document.querySelector('.mast');
            if (!c || !q || !m) return { err: 'carte ou en-tête absent' };
            const a = q.getBoundingClientRect(), b = m.getBoundingClientRect();
            return { pos: getComputedStyle(c).position, cls: c.className, over: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) }; }"""
        res = []
        for nom, prefs, media_default in [("vidéo (défaut)", {}, False), ("texte avec photo", {"kaam_media": "text"}, True)]:
            ctx = w.new_ctx()
            try:
                pg = w.new_page(ctx, prefs, media_default=media_default); w.goto(pg)
                if nom.startswith("texte"):
                    pg.evaluate("() => { const A = __kaam.allQuotes; __kaam.quoteIdx = A.findIndex(q => q.name === 'ARTHUR' && q.quote.length > 40); __kaam.render(); }")
                for k in range(3): pg.click("#btn-next"); pg.wait_for_timeout(450)
                for k in range(3):
                    pg.click("#btn-prev"); pg.wait_for_timeout(120)
                    r = pg.evaluate(CHK)
                    if r.get("err") or r["pos"] == "absolute" or " back" in f" {r['cls']} ".replace("swap-back", "") or r["over"] > 1:
                        w.shot(pg, rec, f"71-retour-{k}")
                        raise RuntimeError(f"{nom}, retour {k + 1} : {r}")
                    pg.wait_for_timeout(350)
                w.shot(pg, rec, f"71-retour-{'video' if media_default is False else 'texte'}")
                res.append(nom)
                pg.close()
            finally:
                ctx.close()
        return "3 « Autre » puis 3 « Retour » sans chevauchement de l'en-tête : " + ", ".join(res)
    w.step("Retour : la carte reste en place (pas de classe .back), aucun chevauchement de l'en-tête", retour)


def scenario_correctifs(w, tag=""):
    """Correctifs du 14/10 (rapport QA iPhone + Android) : chaque étape échouait avant son correctif."""
    def open_(prefs=None, extra=None, media_default=True):
        ctx = w.new_ctx()
        pg = w.new_page(ctx, prefs, extra, media_default=media_default); w.goto(pg)
        return ctx, pg

    CHK = """() => { const c = document.getElementById('quote-card'), q = c && c.querySelector('.quote'), m = document.querySelector('.mast');
        const a = q.getBoundingClientRect(), b = m.getBoundingClientRect();
        return { cls: c.className, pos: getComputedStyle(c).position, over: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) }; }"""
    def bad_back(r): return r["pos"] == "absolute" or "swap-back" not in r["cls"] or " back " in f" {r['cls']} " or r["over"] > 1

    def s_prev_undo(rec):
        out = []
        ctx, pg = open_({"kaam_in_order": "1", "kaam_hint": "9"})
        try:
            for _ in range(2): pg.click("#btn-next"); pg.wait_for_timeout(300)
            pg.click("#btn-prev"); pg.wait_for_timeout(80)
            r = pg.evaluate(CHK)
            if bad_back(r): w.shot(pg, rec, f"80-precedente{tag}"); raise RuntimeError(f"« Précédente » : {r}")
            out.append("Précédente")
        finally: ctx.close()
        ctx, pg = open_({"kaam_verify": "1"})
        try:
            pg.wait_for_selector("#avis-ok"); pg.click("#avis-ok"); pg.wait_for_selector("#avis-undo")
            pg.wait_for_timeout(300); pg.click("#avis-undo"); pg.wait_for_timeout(80)
            r = pg.evaluate(CHK)
            if bad_back(r): w.shot(pg, rec, f"80-annuler{tag}"); raise RuntimeError(f"« Annuler » (vérification) : {r}")
            out.append("Annuler")
        finally: ctx.close()
        return "glissement swap-back, carte en place, en-tête jamais chevauché : " + ", ".join(out)
    w.step("Précédente (dans l'ordre) et Annuler (vérification) : animation de retour sans classe .back", s_prev_undo)

    def s_mini(rec):
        ctx, pg = open_({"kaam_media": "audio", "kaam_hint": "9"})
        try:
            pg.evaluate("() => { const A = __kaam.allQuotes; __kaam.quoteIdx = A.findIndex(q => q.name === 'ARTHUR' && q.audio); __kaam.render(); }")
            pg.click("#btn-who"); pg.wait_for_selector("#fiche-list .ent")
            ok = pg.evaluate("""() => { const K = __kaam, cur = K.allQuotes[K.quoteIdx], qs = K.allQuotes.filter(q => q.name === cur.name);
                for (const e of document.querySelectorAll('#fiche-list .ent')) { const q = qs[+e.dataset.k];
                  if (q && q.audio && q.i !== cur.i) { e.querySelector('.ent-more').id = 'qa-more'; return true; } } return false; }""")
            if not ok: raise RuntimeError("aucune autre réplique avec son dans la fiche")
            pg.click("#qa-more"); pg.click("#sheet [data-m=audio]"); pg.wait_for_timeout(300)
            pg.evaluate("__kaam.player.loop = true")
            pg.click("#detail-back"); pg.wait_for_timeout(400)
            r = pg.evaluate("() => ({ mini: !document.getElementById('mini').hidden, paused: __kaam.player.paused, src: !!__kaam.player.src })")
            w.shot(pg, rec, f"81-mini-apres-fiche{tag}")
            if not r["mini"] or not r["src"]: raise RuntimeError(f"son de la fiche sans commande après Retour : {r}")
            # le son de la carte elle-même : pas de mini-lecteur (la carte le commande)
            pg.click("#mini-close"); pg.wait_for_timeout(150)
            pg.click("#btn-audio"); pg.wait_for_timeout(300)
            own = pg.evaluate("!document.getElementById('mini').hidden")
            if own: raise RuntimeError("mini-lecteur affiché pour le son de la carte elle-même")
            return f"Retour vers Répliques : mini-lecteur visible ({'en lecture' if not r['paused'] else 'en pause'}) ; son de la carte : pas de mini-lecteur"
        finally: ctx.close()
    w.step("Son lancé depuis une fiche : le mini-lecteur reste après Retour", s_mini)

    INFO = """() => { const c = document.getElementById('quote-card'), qb = c.querySelector('.qblock'), qt = c.querySelector('.quote');
        const rc = c.getBoundingClientRect(), rq = qb.getBoundingClientRect();
        return { fs: parseFloat(qt.style.fontSize || getComputedStyle(qt).fontSize), qh: Math.round(qb.clientHeight), more: !!c.querySelector('.more-h'),
                 spill: rq.bottom > rc.bottom + 1 }; }"""
    def stable(pg):
        # mesure stable (deux lectures identiques à 250 ms d'écart) : la machine du banc peut être chargée
        prev = None
        pg.wait_for_timeout(400)
        for _ in range(16):
            pg.wait_for_timeout(250)
            cur = pg.evaluate(INFO)
            if cur == prev: return cur
            prev = cur
        return prev
    def s_resize_one(media, sel):
        def run(rec):
            ctx, pg = open_({"kaam_media": media, "kaam_hint": "9"})
            try:
                vp = pg.viewport_size; W, H = vp["width"], vp["height"]
                pg.evaluate(f"() => {{ const A = __kaam.allQuotes; __kaam.quoteIdx = A.findIndex({sel}); __kaam.render(); }}")
                pg.evaluate("document.fonts.ready"); pg.wait_for_timeout(500)
                # barre d'adresse d'Android qui apparaît puis disparaît ; puis rotation aller-retour
                for vw, h in [(W, H - 56), (W, H), (H, W), (W, H)]:
                    pg.set_viewport_size({"width": vw, "height": h})
                    a = stable(pg)
                    pg.evaluate("__kaam.render()")
                    f = stable(pg)
                    if a["spill"] or abs(a["fs"] - f["fs"]) > 1 or abs(a["qh"] - f["qh"]) > 3 or a["more"] != f["more"]:
                        w.shot(pg, rec, f"82-resize-{media}{tag}")
                        raise RuntimeError(f"{media}, {vw}x{h} : après changement {a} ≠ rendu neuf {f}")
                return f"remesure identique à un rendu neuf après chaque changement de hauteur : {media} {f['fs']:.0f} px{' (Suite ↓)' if f['more'] else ''}"
            finally: ctx.close()
        return run
    def s_resize_quiz(rec):
        # quiz : rendu en paysage puis tourné en portrait, jamais coupé
        ctx, pg = open_()
        try:
            vp = pg.viewport_size; W, H = vp["width"], vp["height"]
            w.nav(pg, "quiz")
            for dims in [(H, W), (W, H)]:
                pg.set_viewport_size({"width": dims[0], "height": dims[1]}); pg.wait_for_timeout(600)
                r = pg.evaluate(QUIZ_CUT)
                if r["inner"] > 1 or (not r["qpage"] and r["cardBot"] > r["stBot"] + 1):
                    w.shot(pg, rec, f"82-resize-quiz{tag}"); raise RuntimeError(f"quiz coupé après rotation {dims} : {r}")
            w.shot(pg, rec, f"82-quiz-tourne{tag}")
            return "quiz paysage → portrait entier"
        finally: ctx.close()
    w.step("Rotation / barre d'adresse : réplique longue (texte) remesurée", s_resize_one("text", "q => q.quote.length > 600 && q.quote.length < 900"))
    w.step("Rotation / barre d'adresse : réplique moyenne (texte) remesurée", s_resize_one("text", "q => q.name === 'ARTHUR' && q.quote.length > 300 && q.quote.length < 380"))
    w.step("Rotation / barre d'adresse : réplique avec vidéo remesurée", s_resize_one("video", "q => q.video && q.quote.length > 200 && q.quote.length < 300"))
    w.step("Rotation : le quiz est remesuré", s_resize_quiz)

    def s_fav(rec):
        ctx, pg = open_({"kaam_hint": "9"})
        try:
            pg.evaluate("() => { const A = __kaam.allQuotes; __kaam.quoteIdx = A.findIndex(q => q.video && A.find(x => x.name === q.name) === q); __kaam.render(); }")
            st = lambda: pg.get_attribute("#btn-fav", "aria-pressed") + "/" + str(pg.evaluate("document.getElementById('btn-fav').classList.contains('on')")).lower()
            pg.click("#btn-video"); pg.wait_for_selector("#m-fav"); pg.click("#m-fav"); pg.wait_for_timeout(150)
            pg.click("#detail-back"); pg.wait_for_timeout(250)
            a = st()
            pg.click("#btn-who"); pg.wait_for_selector("#fiche-list .ent")
            pg.locator("#fiche-list .ent .ent-more").first.click(); pg.click("#sheet [data-m=fav]"); pg.wait_for_timeout(150)
            pg.click("#detail-back"); pg.wait_for_timeout(250)
            b = st()
            w.shot(pg, rec, f"83-etoile{tag}")
            if a != "true/true" or b != "false/false": raise RuntimeError(f"étoile de la carte : après la scène {a} (attendu true), après la fiche {b} (attendu false)")
            return "étoile à jour après la scène en grand (ajout) et après le menu de la fiche (retrait)"
        finally: ctx.close()
    w.step("Favori changé dans la scène ou la fiche : étoile de la carte à jour", s_fav)

    def s_counter(rec):
        ctx, pg = open_({"kaam_in_order": "1", "kaam_hint": "9", "kaam_media": "video", "kaam_sel": '["film"]'}, media_default=False)
        try:
            out = {}
            for nom, js in [("sans vidéo", "q => !q.video && q.part === 'film'"), ("hors sélection", "q => q.video && q.part === 'L1'")]:
                pg.evaluate(f"() => {{ const A = __kaam.allQuotes; __kaam.quoteIdx = A.findIndex({js}); __kaam.render(); }}")
                pg.wait_for_timeout(150)
                out[nom] = pg.evaluate("document.querySelector('.quote-counter')?.textContent || ''")
            w.shot(pg, rec, f"84-compteur{tag}")
            if out != {"sans vidéo": "Sans vidéo", "hors sélection": "Hors sélection"}: raise RuntimeError(f"compteur : {out}")
            return f"compteur : {out}"
        finally: ctx.close()
    w.step("Dans l'ordre : réplique hors parcours, jamais « 0 sur … »", s_counter)

    def s_copie(rec):
        ctx, pg = open_({"kaam_in_order": "1", "kaam_hint": "0"})
        try:
            pg.evaluate("() => { try { delete Navigator.prototype.share; } catch (e) {} navigator.share = undefined; }")
            pg.click("#btn-share"); pg.wait_for_timeout(200)
            r = pg.evaluate("""() => { const t = document.querySelector('#btn-share .t').getBoundingClientRect(), f = document.querySelector('.stage-foot').getBoundingClientRect();
                return { txt: document.querySelector('#btn-share .t').textContent, over: Math.min(t.bottom, f.bottom) - Math.max(t.top, f.top), right: t.right, vw: innerWidth }; }""")
            w.shot(pg, rec, f"85-copie{tag}")
            if r["over"] > 0 or r["right"] > r["vw"]: raise RuntimeError(f"« {r['txt']} » chevauche la ligne du bas ou sort de l'écran : {r}")
            return f"« {r['txt']} » à côté du pictogramme, sans chevaucher la ligne du bas"
        finally: ctx.close()
    w.step("Partager : « Copié » ne chevauche pas la ligne du bas", s_copie)

    def s_hist(rec):
        ctx, pg = open_({"kaam_hint": "9"})
        try:
            idx = lambda: pg.evaluate("__kaam.quoteIdx")
            pg.click("#btn-next"); pg.wait_for_timeout(250); b = idx()
            def order(v):
                pg.click("#mast-set"); pg.click(f'[data-order="{v}"]'); pg.click("#sheet-close"); pg.wait_for_timeout(200)
            order("seq")
            for _ in range(3): pg.click("#btn-next"); pg.wait_for_timeout(200)
            c = idx()
            order("random")
            pg.click("#btn-prev"); pg.wait_for_timeout(250); r1 = idx()
            pg.click("#btn-next"); pg.wait_for_timeout(250); r2 = idx()
            if r1 != b or r2 != c: raise RuntimeError(f"Retour → {r1} (attendu {b}), Autre → {r2} (attendu {c})")
            return "Dans l'ordre puis Aléatoire : Retour ramène à la dernière vue en aléatoire, Autre revient à celle atteinte dans l'ordre"
        finally: ctx.close()
    w.step("Historique : Dans l'ordre puis Aléatoire, Retour cohérent", s_hist)

    def s_offline(rec):
        ctx, pg = open_({"kaam_hint": "9"})
        try:
            vp = pg.viewport_size
            ctx.set_offline(True); pg.evaluate("dispatchEvent(new Event('offline'))"); pg.wait_for_timeout(200)
            out = []
            for W in (vp["width"], 300, 277):
                pg.set_viewport_size({"width": W, "height": vp["height"]}); pg.wait_for_timeout(500)
                r = pg.evaluate("""() => { const mt = document.querySelector('#mast-sub .mt'), off = document.querySelector('#mast-sub .off'), set = document.getElementById('mast-set');
                    const o = off && off.getBoundingClientRect(), s = set.getBoundingClientRect();
                    return { cut: mt.scrollWidth - mt.clientWidth, off: !!o && o.width > 0, sr: off ? off.textContent : '', hit: !!o && o.right > s.left + 10 && !set.hidden }; }""")
                if r["cut"] > 1 or not r["off"] or "Hors ligne" not in r["sr"] or r["hit"]:
                    w.shot(pg, rec, f"86-hors-ligne-{W}{tag}"); raise RuntimeError(f"{W} px : titre tronqué ou pastille absente : {r}")
                out.append(str(W))
            w.shot(pg, rec, f"86-hors-ligne-277{tag}")
            ctx.set_offline(False)
            return "grand titre entier à " + ", ".join(out) + " px, pastille « Hors ligne » (pictogramme seul si la place manque)"
        finally: ctx.close()
    w.step("Hors ligne : le grand titre n'est jamais tronqué par la pastille", s_offline)

    def s_favs_vides(rec):
        one = json.dumps(fav_objects()[:1], ensure_ascii=False)
        ctx, pg = open_({"kaam_fav": one})
        try:
            w.nav(pg, "favoris")
            before = pg.evaluate("[document.getElementById('fav-play').disabled, document.getElementById('fav-rand').disabled]")
            pg.locator(".ent-more").first.click(); pg.click("#sheet [data-m=fav]"); pg.wait_for_selector(".ent.off")
            after = pg.evaluate("[document.getElementById('fav-play').disabled, document.getElementById('fav-rand').disabled]")
            w.shot(pg, rec, f"87-favoris-vides{tag}")
            if before != [False, False] or after != [True, True]: raise RuntimeError(f"Lecture / Aléatoire désactivés : avant {before}, après {after}")
            return "dernier favori retiré : Lecture et Aléatoire grisés"
        finally: ctx.close()
    w.step("Favoris : Lecture et Aléatoire grisés quand il n'y a plus rien à lire", s_favs_vides)


def worker_main(kind, base, out):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        w = Worker(kind, base, p)
        w.out = out
        w.save()
        env = {**os.environ, "PULSE_SERVER": "unix:/nonexistent/qa-silence"}
        wk = lambda: p.webkit.launch(env=env, timeout=30000)
        try:
            if kind == "chromium":
                opts = dict(viewport={"width": 393, "height": 852}, device_scale_factor=2, is_mobile=True, has_touch=True)
                w.setup(lambda: p.chromium.launch(args=["--mute-audio", "--autoplay-policy=no-user-gesture-required"], env=env, timeout=30000), opts)
                scenario_screens(w)
            elif kind == "iphone13":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_screens(w)
            elif kind == "iphone13-safe":
                d = dict(p.devices["iPhone 13"]); d["viewport"] = {"width": 390, "height": 844}
                w.setup(wk, d, safe=True, ios_policy=True); scenario_screens(w)
            elif kind == "iphoneSE":
                w.setup(wk, dict(p.devices["iPhone SE"]), ios_policy=True); scenario_screens(w)
            elif kind == "vague2":
                w.setup(wk, dict(p.devices["iPhone SE"]), ios_policy=True); scenario_vague2(w)
            elif kind == "video-sound":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_video_sound(w)
            elif kind == "fonctions":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_fonctions(w)
            elif kind == "sombre":
                d = dict(p.devices["iPhone 13"]); d["color_scheme"] = "dark"
                w.setup(wk, d, ios_policy=True); scenario_sombre(w)
            elif kind == "mini-lecteur":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_mini(w)
            elif kind == "portraits":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_portraits(w); scenario_pilotes(w)
            elif kind == "selection":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_selection(w); scenario_lancement(w)
            elif kind == "selection-se":
                w.setup(wk, dict(p.devices["iPhone SE"]), ios_policy=True); scenario_selection(w, se=True)
            elif kind == "selection-sombre":
                d = dict(p.devices["iPhone 13"]); d["color_scheme"] = "dark"
                w.setup(wk, d, ios_policy=True); scenario_selection(w)
            elif kind == "correctifs":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_correctifs(w)
            elif kind == "combos":
                w.setup(wk, dict(p.devices["iPhone 13"]), ios_policy=True); scenario_combos(w)
        except Exception:
            w.steps.append({"name": "worker", "status": "ÉCHEC", "detail": traceback.format_exc()[-500:], "shots": [], "dur": 0})
        w.save(final=True)
        w.close()


# ---------------------------------------------------------------------------
# Orchestrateur
# ---------------------------------------------------------------------------
SERVER_CODE = r"""
import sys, json, re, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
app = sys.argv[2]
try: blocks = json.load(open(app + '/vercel.json', encoding='utf-8')).get('headers', [])
except Exception: blocks = []
rules = [(re.compile('^' + b['source'] + '$'), b['headers']) for b in blocks]
class H(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.json': 'application/json', '.js': 'text/javascript',
                      '.woff2': 'font/woff2', '.m4a': 'audio/mp4', '.mp4': 'video/mp4'}
    def log_message(self, *a): pass
    def end_headers(self):
        path = self.path.split('?')[0].split('#')[0]
        for rx, hs in rules:
            if rx.match(path):
                for h in hs: self.send_header(h['key'], h['value'])
        super().end_headers()
    def send_head(self):
        # réseau faible simulé (« lie-fi ») pour les seuls contextes qui portent le cookie qa_lent : 6 s par fichier de l'app
        if 'qa_lent=1' in (self.headers.get('Cookie') or '') and not self.path.startswith('/data.json'):
            import time; time.sleep(6)
        return super().send_head()
    def do_POST(self):
        self.send_response(501); self.send_header('Content-Length', '0'); self.end_headers()
ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer.request_queue_size = 128
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), functools.partial(H, directory=app)).serve_forever()
"""


def wait_http(port, timeout=15):
    import urllib.request
    t = time.time()
    while time.time() - t < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=2).read(10); return True
        except Exception:
            time.sleep(0.2)
    return False


def killgrp(pr):
    try: os.killpg(pr.pid, signal.SIGKILL)
    except Exception:
        try: pr.kill()
        except Exception: pass


def md_cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def quick_checks():
    """Tests unitaires (node --test) et contrôle de data.json, lancés en parallèle des navigateurs."""
    env = {**os.environ, "QA_APP": str(APP)}
    unit = subprocess.Popen(["node", "--test", str(QA.parent)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    data = subprocess.Popen([sys.executable, str(QA.parent / "check_data.py"), str(APP)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return [("tests unitaires (node --test)", unit), ("data.json (check_data.py)", data)]


def main():
    quick = "--quick" in sys.argv
    t0 = time.time()
    RES.mkdir(parents=True, exist_ok=True); SHOTS.mkdir(parents=True, exist_ok=True)
    for f in list(RES.glob("*.json")) + list(RES.glob("*.tmp")):
        f.unlink()
    wdeadline = t0 + GLOBAL_BUDGET
    port = free_port()
    base = f"http://127.0.0.1:{port}/"
    srv = subprocess.Popen([sys.executable, "-c", SERVER_CODE, str(port), str(APP)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs, checks = [], []
    try:
        if not wait_http(port):
            print("serveur local injoignable"); return 2
        print(f"App : {APP}\nServeur : {base}")
        checks = quick_checks()
        jobs = ["chromium", "iphone13-safe", "iphoneSE", "video-sound", "vague2", "fonctions", "sombre", "mini-lecteur", "portraits", "selection", "correctifs"]
        if not quick:
            jobs += ["iphone13", "combos", "selection-se", "selection-sombre"]
        for kind in jobs:
            out = RES / f"{kind}.json"
            args = [sys.executable, str(Path(__file__).resolve()), "--worker", kind, base, str(out)]
            procs.append((kind, subprocess.Popen(args, cwd=str(QA), start_new_session=True,
                                                 env={**os.environ, "QA_DEADLINE": str(wdeadline)})))
        deadline = wdeadline + 25
        for kind, pr in procs:
            try: pr.wait(timeout=max(1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                killgrp(pr); print(f"[{kind}] délai dépassé, arrêté (résultats partiels conservés)")
        check_out = []
        for lab, pr in checks:
            try: o, _ = pr.communicate(timeout=120)
            except subprocess.TimeoutExpired: pr.kill(); o = "délai dépassé"
            check_out.append((lab, pr.returncode, o))
    finally:
        for _, pr in procs + checks:
            if pr.poll() is None: killgrp(pr)
        srv.terminate()
        try: srv.wait(timeout=5)
        except subprocess.TimeoutExpired: srv.kill()

    results = []
    for kind, _ in procs:
        f = RES / f"{kind}.json"
        if f.exists():
            results.append(json.loads(f.read_text(encoding="utf-8")))
        else:
            results.append({"name": kind, "steps": [{"name": "worker", "status": "ÉCHEC", "detail": "aucun résultat (plantage ou délai)", "shots": [], "dur": 0}],
                            "console": [], "csp": [], "pageerrors": [], "dur": 0})
    dur = round(time.time() - t0, 1)
    tot = sum(len(r["steps"]) for r in results)
    ko = sum(1 for r in results for s in r["steps"] if s["status"] != "OK")
    partial = [r["name"] for r in results if r.get("partial")]
    checks_ko = [lab for lab, rc, _ in check_out if rc != 0]
    L = [f"# Rapport du banc Kaamelott ({time.strftime('%Y-%m-%d %H:%M')})", "",
         f"- Application : `{APP}` servie sur `{base}` avec les en-têtes de vercel.json (posés par le serveur)",
         f"- **Durée : {dur} s** ; étapes navigateur : {tot}, **OK : {tot - ko}, ÉCHEC : {ko}**"
         + (f" ; workers interrompus : {', '.join(partial)}" if partial else ""),
         f"- Contrôles rapides : " + ", ".join(f"{lab} **{'OK' if rc == 0 else 'ÉCHEC'}**" for lab, rc, _ in check_out), "",
         ("Médias Hugging Face : RÉELS (QA_REAL_MEDIA=1)." if REAL_MEDIA else
          "Médias Hugging Face remplacés par des fichiers muets locaux (stub/) ; /api/avis intercepté.")
         + " Toute erreur console, violation CSP ou exception de page fait échouer l'étape.", ""]
    for lab, rc, o in check_out:
        L += [f"## {lab} (code {rc})", "", "```"] + o.strip().splitlines()[-25:] + ["```", ""]
    for r in results:
        flag = (" , RÉSULTATS PARTIELS" if r.get("partial") else "") + (f" , navigateur relancé {r['restarts']} fois" if r.get("restarts") else "")
        L += [f"## {r['name']} ({r['dur']} s{flag})", "", "| Étape | Statut | Détail | Captures | s |", "|---|---|---|---|---|"]
        for s in r["steps"]:
            shots = "<br>".join(f"[{Path(x).name}]({x})" for x in s["shots"])
            L.append(f"| {md_cell(s['name'])} | {'OK' if s['status'] == 'OK' else '**ÉCHEC**'} | {md_cell(s['detail'])[:500]} | {shots} | {s['dur']} |")
        L.append("")
    (OUT / "rapport.md").write_text("\n".join(L), encoding="utf-8")
    fails = [f"{r['name']} / {s['name']} : {s['detail'][:200]}" for r in results for s in r["steps"] if s["status"] != "OK"]
    for f in fails[:40]: print("ÉCHEC", f)
    for lab in checks_ko: print("ÉCHEC", lab)
    bad = bool(ko or partial or checks_ko)
    print(f"Terminé en {dur} s : {tot - ko} OK / {ko} ÉCHEC navigateur ; contrôles rapides {'ÉCHEC' if checks_ko else 'OK'} -> {OUT / 'rapport.md'}")
    print("RÉSULTAT :", "ÉCHEC" if bad else "VERT")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker_main(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        sys.exit(main())
