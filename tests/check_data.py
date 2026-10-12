#!/usr/bin/env python3
"""Cohérence de data.json, sans réseau.
Usage : python3 tests/check_data.py [dossier_app] [ancien_data.json]
Sans ancien fichier, compare au data.json du commit précédent (git show HEAD~1:data.json) s'il existe.
Code 1 si erreur. Les avis et favoris référencent l'index i : jamais de suppression ni de réordonnancement."""
import json, os, re, subprocess, sys
from collections import Counter

APP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OLD = sys.argv[2] if len(sys.argv) > 2 else None
d = json.load(open(os.path.join(APP, "data.json"), encoding="utf-8"))
err, warn = [], []
ALLOWED = {"character": str, "quote": str, "audio": str, "video": str, "v": int, "vv": int, "approx": int, "inedit": int, "hide": (int, bool)}
SRC = re.compile(r"livre\s+(I{1,3}V?|VI?)|épisode\s+\d+|premier volet|inédit", re.I)
if not isinstance(d, list) or not d:
    print("data.json : pas une liste non vide"); sys.exit(1)
for i, it in enumerate(d):
    for k, v in it.items():
        if k not in ALLOWED: err.append(f"{i}: champ inconnu {k!r}")
        elif not isinstance(v, ALLOWED[k]): err.append(f"{i}: {k} de type {type(v).__name__}")
    q, c, a = it.get("quote", ""), it.get("character", ""), it.get("audio")
    if not q.strip() or not c.strip(): err.append(f"{i}: quote/character vide")
    if q != q.strip() or re.search(r"[\x00-\x1f<>]", q): warn.append(f"{i}: espaces de bord, contrôle ou < >")
    if "," in c and not SRC.search(c): warn.append(f"{i}: source illisible {c[:60]!r}")
    if a and a.startswith("sons/auto/") and not re.fullmatch(r"sons/auto/[0-9a-f]{12}\.m4a", a): err.append(f"{i}: clé son {a!r}")
    if a and not a.startswith("sons/auto/") and not os.path.exists(os.path.join(APP, a)): err.append(f"{i}: son manuel absent {a}")
    if it.get("video") and not re.fullmatch(r"[0-9a-f]{12}", it["video"]): err.append(f"{i}: clé vidéo {it['video']!r}")
    if it.get("inedit") and (a or it.get("video")): err.append(f"{i}: inédit avec média")
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
if old:
    if len(d) < len(old): err.append(f"entrées supprimées : {len(old)} -> {len(d)}")
    changed = sum(1 for x, y in zip(old, d) if x.get("quote") != y.get("quote"))   # répliques, pas les noms (corrections de noms permises)
    if changed > max(20, 0.005 * len(old)): err.append(f"ordre probablement changé : {changed} répliques différentes au même index")
    elif changed: warn.append(f"{changed} répliques corrigées sur place")
print(f"data.json : {len(d)} entrées, {len(err)} erreur(s), {len(warn)} avertissement(s)"
      + (f", comparé à une version de {len(old)} entrées" if old else ", sans version précédente"))
for m in err[:30] + warn[:15]: print(m)
sys.exit(1 if err else 0)
