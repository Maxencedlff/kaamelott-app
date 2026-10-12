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

PREF_KEYS = ["kaam_source", "kaam_verify", "kaam_video_only", "kaam_audio_only", "kaam_in_order", "kaam_autoplay"]
# Couverture par paires (toutes les combinaisons deux à deux des 6 réglages), vérifiée par pairwise_ok() au lancement ;
# les 2 dernières lignes ajoutent le mode Son seul hors vérification.
COMBOS = [
    ["film", "0", "1", "0", "0", "1"], ["all", "1", "0", "1", "1", "1"], ["serie", "0", "1", "1", "1", "0"],
    ["serie", "1", "0", "0", "0", "0"], ["all", "0", "1", "0", "0", "0"], ["film", "1", "0", "1", "1", "0"],
    ["serie", "0", "0", "0", "1", "1"], ["film", "1", "1", "1", "0", "1"],
    ["all", "0", "0", "1", "0", "1"], ["film", "0", "0", "1", "1", "0"],
]

NAV = {"citations": "Répliques", "quiz": "Quiz", "personnages": "Personnages", "recherche": "Chercher", "favoris": "Favoris"}
MAIN_SEL = "#quote-card"


def pairwise_ok(rows):
    import itertools
    lv = [["all", "serie", "film"]] + [["0", "1"]] * 5
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
        page.on("pageerror", lambda e: self._err("pageerror", e))

    def new_page(self, ctx, prefs=None, extra_ls=None, clear=True):
        page = ctx.new_page()
        self.attach(page)
        sets = dict(prefs or {}); sets.update(extra_ls or {})
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
        page.wait_for_function("() => window.__kaam && __kaam.allQuotes.length > 0 && !!document.querySelector('#main-content button')", timeout=timeout)
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
        pg.click("#btn-settings")
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


# Invariant après chaque navigation : la réplique affichée respecte TOUS les filtres, et le pool aussi
INV = """p => { const K = __kaam, A = K.allQuotes, q = A[K.quoteIdx], P = K.pool();
  const ok = x => (p.kaam_source === 'all' || !!x.film === (p.kaam_source === 'film'))
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
                        else: pg.click("#btn-random")
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
                if ys != r["ys"]: raise RuntimeError(f"les réponses ont bougé : {r['ys']} -> {ys}")
                if not re.match(r"^(Juste|Faux)", live): raise RuntimeError(f"verdict non annoncé : {live!r}")
            else:
                pg.click("#quiz-next"); pg.wait_for_timeout(60)
        pg.close()
        if bad: raise RuntimeError(f"réponse D cachée ou absente {bad} fois sur 8")
        return "D toujours visible, lignes immobiles après réponse, verdict annoncé"
    w.step("Quiz : D visible, rien ne bouge, verdict annoncé", s_quizD)

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
        r = pg.evaluate("({ ep: document.querySelectorAll('.ep-h').length, cells: [...document.querySelectorAll('#fiche-list .ent-a')].map(a => a.children.length), livres: document.querySelectorAll('.livres button').length })")
        w.shot(pg, rec, "32-fiche-se")
        pg.close()
        if not r["ep"] or set(r["cells"]) != {3}: raise RuntimeError(f"fiche : {r}")
        return f"{r['ep']} en-têtes d'épisode, 3 cellules par entrée, {r['livres']} Livres"
    w.step("Fiche personnage : épisodes, 3 cellules fixes", s_fiche)

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
        if not marks or any(m != "roi" for m in marks): raise RuntimeError(f"surlignage absent ou hors mot : {marks[:6]}")
        if not n: raise RuntimeError("« c est pas faux » ne trouve rien")
        if v != "c est pas faux": raise RuntimeError(f"recherche oubliée : {v!r}")
        return f"« roi » : {len(marks)} soulignés, tous « roi » ; « c est pas faux » : {n} ; recherche gardée"
    w.step("Chercher : surlignage, ponctuation facultative, mémoire", s_search)

    def s_fav(rec):
        favs = fav_objects()
        pg = page(extra={"kaam_fav": json.dumps(favs, ensure_ascii=False)}); w.nav(pg, "favoris")
        pg.locator("[data-act=fav]").first.click(); pg.wait_for_selector(".ent.off")
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
        if not re.search(r"Consigné|Signalé", line) or left != 0 or not fin["fin"] or fin["ok"]: raise RuntimeError(f"ligne={line!r} restant={left} fin={fin}")
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
            r = pg.evaluate("({ sub: document.getElementById('mast-sub').dataset.t, n: document.querySelectorAll('.ent').length })")
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
        pg.click("#btn-settings"); pg.wait_for_selector("#sheet:not([hidden])")
        pg.click(f"#sheet {sel}"); pg.wait_for_timeout(80)
        pg.click("#sheet-close"); pg.wait_for_selector("#sheet", state="hidden")

    def s_order(rec):
        pg = w.new_page(w.ctx()); w.goto(pg)
        if "Aléatoire" not in pg.inner_text(".bar-sum"): raise RuntimeError("le mode par défaut n'est pas Aléatoire")
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
        if "ordre" not in pg.inner_text(".bar-sum"): raise RuntimeError("mode « Dans l'ordre » oublié au rechargement")
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
            for path in [""]:
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
        jobs = ["chromium", "iphone13-safe", "iphoneSE", "video-sound", "vague2", "fonctions"]
        if not quick:
            jobs += ["iphone13", "combos"]
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
