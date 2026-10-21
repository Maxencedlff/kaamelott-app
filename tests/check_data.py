#!/usr/bin/env python3
"""Cohérence de data.json, sans réseau.
Usage : python3 tests/check_data.py [dossier_app] [ancien_data.json] [--autoriser]
Sans ancien fichier, compare au data.json du commit précédent (git show HEAD~1:data.json) s'il existe.
Code 1 si erreur. Les avis, favoris, faits.json et coupes.json référencent l'index i : jamais de suppression, de
réordonnancement ni de réplique remplacée par une autre au même index.
Correction voulue d'une réplique sur place (script_site.py, corrige_place.py…) : la déclarer dans
tests/corrections_autorisees.json, {"i": "nouveau texte"} (ou {"i": {"quote": …, "character": …}} si l'épisode change).
--autoriser y ajoute d'un coup toutes les différences constatées (à relire avant de committer)."""
import json, os, re, subprocess, sys
from collections import Counter

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
AUTORISER = "--autoriser" in sys.argv
APP = ARGS[0] if ARGS else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OLD = ARGS[1] if len(ARGS) > 1 else None
LISTE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corrections_autorisees.json")
d = json.load(open(os.path.join(APP, "data.json"), encoding="utf-8"))
err, warn = [], []
ALLOWED = {"character": str, "quote": str, "audio": str, "video": str, "v": int, "vv": int, "approx": int, "inedit": int, "tourne": int, "hide": (int, bool),
           "transcription": int, "acteur": str,   # transcription / acteur : pilotes et Dies Iræ (14/10/2026)
           "cx": list}                            # [pre, d, post] : vidéo élargie pour la coupe dans l'appli (20/10/2026)
SRC = re.compile(r"livre\s+(I{1,3}V?|VI?)|épisode\s+\d+|premier volet|inédit|court métrage", re.I)
TRANS = re.compile(r",\s*(pilote, épisode ([1-9]|10): \S.*|Dies Iræ \(court métrage, 2003\))$")
if not isinstance(d, list) or not d:
    print("data.json : pas une liste non vide"); sys.exit(1)
for i, it in enumerate(d):
    for k, v in it.items():
        if k not in ALLOWED: err.append(f"{i}: champ inconnu {k!r}")
        elif not isinstance(v, ALLOWED[k]): err.append(f"{i}: {k} de type {type(v).__name__}")
        elif k == "cx" and not (len(v) == 3 and all(isinstance(x, (int, float)) for x in v) and 0 <= v[0] <= 5 and 0 <= v[2] <= 5 and 0 < v[1] and sum(v) <= 150 and it.get("video")):
            err.append(f"{i}: cx invalide {v!r}")
    q, c, a = it.get("quote", ""), it.get("character", ""), it.get("audio")
    if not q.strip() or not c.strip(): err.append(f"{i}: quote/character vide")
    if q != q.strip() or re.search(r"[\x00-\x1f<>]", q): warn.append(f"{i}: espaces de bord, contrôle ou < >")
    if "," in c and not SRC.search(c): warn.append(f"{i}: source illisible {c[:60]!r}")
    if a and a.startswith("sons/auto/") and not re.fullmatch(r"sons/auto/[0-9a-f]{12}\.m4a", a): err.append(f"{i}: clé son {a!r}")
    if a and not a.startswith("sons/auto/") and not os.path.exists(os.path.join(APP, a)): err.append(f"{i}: son manuel absent {a}")
    if it.get("video") and not re.fullmatch(r"[0-9a-f]{12}", it["video"]): err.append(f"{i}: clé vidéo {it['video']!r}")
    if it.get("inedit") and not it.get("tourne") and (a or it.get("video")): err.append(f"{i}: inédit jamais tourné avec média")
    if it.get("tourne") and not it.get("inedit"): err.append(f"{i}: tourne sans inedit")
    if it.get("transcription") and not TRANS.search(c): err.append(f"{i}: transcription hors pilotes / Dies Iræ {c[:60]!r}")
    if TRANS.search(c) and not it.get("transcription"): err.append(f"{i}: pilote ou Dies Iræ sans « transcription »")
    if "acteur" in it and (not it.get("transcription") or not it["acteur"].strip()): err.append(f"{i}: acteur sans transcription, ou vide")
    if (it.get("v") and not a) or (it.get("vv") and not it.get("video")) or (it.get("approx") and not a): err.append(f"{i}: v/vv/approx sans média")
for k in ("audio", "video"):
    dup = [x for x, n in Counter(it.get(k) for it in d if it.get(k)).items() if n > 1]
    if dup: err.append(f"{k} partagé : {dup[:5]}")
dup = [k for k, n in Counter((it["quote"], it["character"]) for it in d if not it.get("hide")).items() if n > 1]
if dup: warn.append(f"{len(dup)} doublons visibles (les masquer par hide, ne jamais supprimer)")

old = None
if OLD:
    old = json.load(open(OLD, encoding="utf-8"))
else:
    try:
        txt = subprocess.run(["git", "-C", APP, "show", "HEAD~1:data.json"], capture_output=True, timeout=60).stdout
        old = json.loads(txt) if txt else None
    except Exception:
        old = None

# ancienne version vide alors que data.json a un historique : comparaison impossible, jamais un « sans version précédente »
def historique():
    try:
        return bool(subprocess.run(["git", "-C", APP, "log", "-1", "--format=%h", "--", "data.json"], capture_output=True, text=True, timeout=60).stdout.strip())
    except Exception:
        return False
if old is not None and not old and historique():
    err.append("ancienne version vide alors que data.json a un historique : comparaison impossible (git show raté ?)")

# épisode d'une réplique : tout ce qui suit le nom (« ARTHUR, Livre I, épisode 3 : … » → « Livre I, épisode 3 : … »)
episode = lambda c: c.split(",", 1)[1].strip() if "," in c else ""
if old:
    if len(d) < len(old): err.append(f"entrées supprimées : {len(old)} -> {len(d)}")
    try:
        autorisees = json.load(open(LISTE, encoding="utf-8"))
    except FileNotFoundError:
        autorisees = {}
    def permis(i, champ, val):
        a = autorisees.get(str(i))
        return (a == val) if champ == "quote" and isinstance(a, str) else isinstance(a, dict) and a.get(champ) == val
    changees, nouvelles = [], {}
    for i, (x, y) in enumerate(zip(old, d)):
        qa, qn, ca, cn = x.get("quote", ""), y.get("quote", ""), x.get("character", ""), y.get("character", "")
        if qa != qn:
            if permis(i, "quote", qn): warn.append(f"{i}: réplique corrigée sur place (liste blanche)")
            else: changees.append(f"{i}: {qa[:40]!r} -> {qn[:40]!r}"); nouvelles.setdefault(str(i), {})["quote"] = qn
        if episode(ca) != episode(cn):
            if permis(i, "character", cn): warn.append(f"{i}: épisode changé (liste blanche)")
            else: changees.append(f"{i}: épisode {episode(ca)[:40]!r} -> {episode(cn)[:40]!r}"); nouvelles.setdefault(str(i), {})["character"] = cn
        elif ca != cn: warn.append(f"{i}: nom corrigé {ca.split(',')[0]!r} -> {cn.split(',')[0]!r}")
    if changees:
        n = len(nouvelles)
        err.append(f"{n} index dont la réplique ou l'épisode a changé{' : ordre probablement changé' if n > max(20, 0.005 * len(old)) else ''}"
                   f" ; si ce sont des corrections voulues, les déclarer dans tests/corrections_autorisees.json"
                   f" (ou relancer avec --autoriser, puis relire le fichier)")
        err.extend(changees[:20])
        if n <= 20:
            exemple = {k: (v["quote"] if list(v) == ["quote"] else v) for k, v in nouvelles.items()}
            err.append("à ajouter : " + json.dumps(exemple, ensure_ascii=False)[:600])
    if AUTORISER and nouvelles:
        for k, v in nouvelles.items():
            autorisees[k] = v["quote"] if list(v) == ["quote"] else {**(autorisees.get(k) if isinstance(autorisees.get(k), dict) else {}), **v}
        json.dump(autorisees, open(LISTE, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)
        print(f"{len(nouvelles)} correction(s) ajoutée(s) à {LISTE} : relire le fichier, puis relancer sans --autoriser")
print(f"data.json : {len(d)} entrées, {len(err)} erreur(s), {len(warn)} avertissement(s)"
      + (f", comparé à une version de {len(old)} entrées" if old else ", sans version précédente"))
for m in err[:30] + warn[:15]: print(m)
sys.exit(1 if err else 0)
