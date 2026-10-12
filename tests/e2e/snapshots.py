"""Instantanés du HTML produit (répliques fixées, hasard à graine fixe), pour vérifier qu'une réorganisation du code
ne change pas le rendu : python3 tests/e2e/snapshots.py avant.json, modifier, python3 tests/e2e/snapshots.py après.json, comparer."""
import sys, json, subprocess
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
import run_all as R
port = R.free_port()
srv = subprocess.Popen([sys.executable, "-c", R.SERVER_CODE, str(port), str(R.APP)])
R.wait_http(port)
SEED = "(() => { let a = 12345; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })()"
GET = "() => (document.getElementById('main-content').innerHTML + '\\n@@OV@@\\n' + document.getElementById('detail-overlay').innerHTML + '\\n@@SH@@\\n' + document.getElementById('sheet').innerHTML + '\\n@@MAST@@' + document.getElementById('mast-sub').innerHTML).replace(/blob:[^\"]+/g, 'BLOB').replace(/--p:[^;\"]+/g, '')"
out = {}
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    w = R.Worker("snap", f"http://127.0.0.1:{port}/", p)
    w.setup(lambda: p.webkit.launch(env={"PULSE_SERVER": "unix:/x"}), dict(p.devices["iPhone 13"]), ios_policy=True)
    def page(prefs=None, extra=None):
        pg = w.new_page(w.ctx(), prefs, extra); pg.add_init_script(SEED); w.goto(pg); return pg
    IDX = [0, 5, 100, 2000, 17000, 31000, 33000]
    for mode, prefs in [("texte", {}), ("video", {"kaam_video_only": "1"}), ("ordre", {"kaam_in_order": "1", "kaam_autoplay": "1"}), ("verif", {"kaam_verify": "1"})]:
        pg = page(prefs)
        for i in IDX:
            pg.evaluate(f"() => {{ __kaam.quoteIdx = {i}; __kaam.render(); }}"); pg.wait_for_timeout(120)
            out[f"{mode}/{i}"] = pg.evaluate(GET)
        pg.click("#btn-settings"); pg.wait_for_timeout(100); out[f"{mode}/reglages"] = pg.evaluate(GET)
        if mode == "verif":
            pg.click("#sheet-close"); pg.click("#avis-ko"); pg.wait_for_timeout(100); out["verif/probleme"] = pg.evaluate(GET)
        pg.close()
    pg = page()
    pg.click(".nav-btn[data-view=quiz]"); pg.wait_for_timeout(150); out["quiz/1"] = pg.evaluate(GET)
    pg.locator(".choice").nth(1).click(); pg.wait_for_timeout(150); out["quiz/1r"] = pg.evaluate(GET)
    pg.click("#quiz-next"); pg.wait_for_timeout(150); out["quiz/2"] = pg.evaluate(GET)
    pg.click("#quiz-daily"); pg.wait_for_timeout(150); out["quiz/daily"] = pg.evaluate(GET)
    pg.locator(".choice").nth(0).click(); pg.wait_for_timeout(150); out["quiz/dailyr"] = pg.evaluate(GET)
    pg.click(".nav-btn[data-view=personnages]"); pg.wait_for_timeout(150); out["pers/count"] = pg.evaluate(GET)
    pg.locator(".idx-row").nth(1).click(); pg.wait_for_timeout(150); out["pers/fiche"] = pg.evaluate(GET)
    pg.locator("#fiche-list [data-act=video]").first.click(); pg.wait_for_timeout(150); out["pers/scene"] = pg.evaluate(GET)
    pg.click("#detail-back"); pg.wait_for_timeout(150); out["pers/retour"] = pg.evaluate(GET)
    pg.click("#detail-back"); pg.click("[data-sort=alpha]"); pg.wait_for_timeout(150); out["pers/az"] = pg.evaluate(GET)
    pg.click(".nav-btn[data-view=recherche]"); pg.fill("#search-input", "roi"); pg.wait_for_timeout(400); out["cherche/roi"] = pg.evaluate(GET)
    pg.fill("#search-input", "c est pas faux"); pg.wait_for_timeout(400); out["cherche/faux"] = pg.evaluate(GET)
    pg.locator("#search-results [data-act=goto]").first.click(); pg.wait_for_timeout(150); out["cherche/goto"] = pg.evaluate(GET)
    pg.close()
    pg = page(extra={"kaam_fav": json.dumps(R.fav_objects(), ensure_ascii=False)})
    pg.click(".nav-btn[data-view=favoris]"); pg.wait_for_timeout(150); out["fav"] = pg.evaluate(GET)
    pg.locator("[data-act=fav]").first.click(); out["fav/retire"] = pg.evaluate(GET)
    pg.close()
srv.terminate()
json.dump(out, open(sys.argv[1], "w"), ensure_ascii=False, indent=0)
print(len(out), "instantanés")
