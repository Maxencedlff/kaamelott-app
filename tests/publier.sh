#!/bin/bash
# Publication en une commande : tests → commit → push (jeton fine-grained) → déploiement Vercel de CE commit → CI GitHub → contrôle en ligne.
# CI rouge après la mise en ligne : la production est remise automatiquement sur le déploiement précédent (rollback).
# Fichier non suivi inattendu à la racine (export, .env…) : rien n'est publié (le dépôt est public).
# usage : tests/publier.sh "Message du commit"      (à lancer depuis la racine du dépôt kaamelott-app)
set -euo pipefail
cd "$(dirname "$0")/.."
MSG="${1:?message de commit manquant}"
T=$(cat ~/.config/kaam/github_token)
VT=$(cat ~/.config/kaam/vercel_token)          # fichier 600, jamais affiché
TEAM=team_vsrQBKB5DaJbha03esHVWjP3; PRJ=prj_rHkTDWayY3BeNjxjGqtkvhbSBLan
J=$(mktemp -d); trap 'rm -rf "$J"' EXIT         # journaux de cette publication (jamais dans /tmp partagé)
ok() { echo "✔ $*"; }; ko() { echo "✘ $*"; exit 1; }
# API Vercel : réponse vide ou tronquée (arrive de temps en temps) → jusqu'à 4 essais, jamais un JSON illisible plus loin
vercel() {
  local o
  for _ in 1 2 3 4; do
    o=$(curl -s -H "Authorization: Bearer $VT" "$@") && python3 -c 'import json,sys;json.loads(sys.stdin.read())' <<<"$o" 2>/dev/null && { printf '%s' "$o"; return 0; }
    sleep 3
  done
  printf '%s' "$o"; return 1
}

# non suivis : seulement aux emplacements attendus (un export ou un .env oublié partirait sur un dépôt public)
inattendus=$(git status --porcelain --untracked-files=all | sed -n 's/^?? //p' | grep -vE '^((api|tests|img|splash|fonts|sons)/|README\.md$|middleware\.js$)' || true)
[ -z "$inattendus" ] || { echo "$inattendus" | head -10; ko "fichiers non suivis inattendus : les ajouter à .gitignore, les déplacer, ou les committer à la main"; }

node --check app.js && node --check sw.js || ko "syntaxe JS"
node --test tests/ >"$J/unit.txt" 2>&1 || { tail -20 "$J/unit.txt"; ko "tests unitaires"; }; ok "tests unitaires"
git show HEAD:data.json > "$J/old.json"           # comparé au dernier commit (celui qui est en ligne), pas à HEAD~1
python3 tests/check_data.py . "$J/old.json" >"$J/data.txt" || { cat "$J/data.txt" | head -25; ko "contrôle de data.json"; }; ok "data.json"
python3 tests/e2e/run_all.py --quick --jobs 4 --relancer >"$J/banc.txt" 2>&1 || { tail -15 "$J/banc.txt"; ko "banc Playwright"; }
grep '^INSTABLE' "$J/banc.txt" || true; ok "banc Playwright"

python3 - <<'EOF'
import re; p='sw.js'; s=open(p).read()
s=re.sub(r"kaamelott-v(\d+)", lambda m: f"kaamelott-v{int(m.group(1))+1}", s, 1); open(p,'w').write(s)
EOF
git add -A .
git commit -qm "$MSG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
SHA=$(git rev-parse HEAD); S8=${SHA:0:8}
git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$T" | base64 -w0)" push -q https://github.com/Maxencedlff/kaamelott-app.git HEAD:main
ok "poussé $S8"

# déploiement Vercel de CE commit (relance manuelle si le push ne l'a pas déclenché)
for i in $(seq 40); do
  r=$(curl -s -H "Authorization: Bearer $VT" "https://api.vercel.com/v6/deployments?teamId=$TEAM&projectId=$PRJ&limit=1" | python3 -c "import json,sys;x=json.load(sys.stdin)['deployments'][0];print(x['state'],x.get('meta',{}).get('githubCommitSha','')[:8])")
  [ "$r" = "READY $S8" ] && break
  if [ "$i" = 8 ] && ! echo "$r" | grep -q "$S8"; then
    RID=$(curl -s -H "Authorization: Bearer $VT" "https://api.vercel.com/v9/projects/$PRJ?teamId=$TEAM" | python3 -c "import json,sys;print(json.load(sys.stdin)['link']['repoId'])")
    curl -s -X POST -H "Authorization: Bearer $VT" -H "Content-Type: application/json" "https://api.vercel.com/v13/deployments?teamId=$TEAM" \
      -d "{\"name\":\"kaamelott-app\",\"project\":\"$PRJ\",\"target\":\"production\",\"gitSource\":{\"type\":\"github\",\"repoId\":$RID,\"ref\":\"main\",\"sha\":\"$SHA\"}}" >/dev/null
    echo "… déploiement relancé à la main"
  fi
  sleep 8
done
[ "$r" = "READY $S8" ] || ko "Vercel : $r"
UID8=$(vercel "https://api.vercel.com/v6/deployments?teamId=$TEAM&projectId=$PRJ&limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin)['deployments'][0]['uid'])")
# après un rollback, Vercel n'attribue plus le domaine aux nouveaux déploiements : celui-ci est promu explicitement
if vercel "https://api.vercel.com/v9/projects/$PRJ?teamId=$TEAM" | python3 -c "import json,sys;sys.exit(0 if json.load(sys.stdin).get('lastRollbackTarget') else 1)"; then
  vercel -X POST "https://api.vercel.com/v10/projects/$PRJ/promote/$UID8?teamId=$TEAM" >/dev/null; echo "… promu en production (rollback précédent levé)"
fi
ok "Vercel : en production"

# CI rouge alors que la version est déjà en ligne : production remise sur le dernier déploiement READY d'un autre commit
rollback() {
  local prev
  prev=$(vercel "https://api.vercel.com/v6/deployments?teamId=$TEAM&projectId=$PRJ&target=production&state=READY&limit=20" | python3 -c "
import json,sys
d=[x for x in json.load(sys.stdin)['deployments'] if not x.get('meta',{}).get('githubCommitSha','').startswith('$S8')]
print(d[0]['uid'], d[0].get('meta',{}).get('githubCommitSha','')[:8]) if d else print('')")
  [ -n "$prev" ] || ko "CI : $1 ; AUCUN déploiement précédent pour le rollback, version $S8 laissée en ligne"
  vercel -X POST "https://api.vercel.com/v10/projects/$PRJ/promote/${prev% *}?teamId=$TEAM" >/dev/null
  ko "CI : $1 ; production remise sur ${prev#* } (rollback), corriger puis republier"
}

# CI GitHub Actions
for i in $(seq 60); do
  c=$(curl -s -H "Authorization: Bearer $T" "https://api.github.com/repos/Maxencedlff/kaamelott-app/actions/runs?head_sha=$SHA" | python3 -c "import json,sys;r=json.load(sys.stdin)['workflow_runs'];print((r[0]['status']+' '+str(r[0]['conclusion'])) if r else 'attente')")
  case "$c" in "completed success") break;; completed*) rollback "$c";; esac; sleep 15
done
[ "$c" = "completed success" ] && ok "CI verte" || ko "CI : $c (toujours en cours après 15 min, version laissée en ligne)"

# contrôle en ligne (navigateur, pas de curl en boucle sur le site)
python3 - <<'EOF'
import subprocess
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.webkit.launch(); bad=[]
    for scheme in ("light","dark"):
        c=b.new_context(**p.devices["iPhone 13"], color_scheme=scheme, bypass_csp=True)
        n,v=subprocess.run(["python3","/home/maxdevops/kaam-audio/kaam_secrets.py","acces-cookie"],capture_output=True,text=True,check=True).stdout.strip().split("=",1)
        c.add_cookies([{"name":n,"value":v,"url":"https://kaamelott-app.vercel.app/","httpOnly":True,"secure":True,"sameSite":"Lax"}])   # code d'accès
        c.add_init_script("Object.defineProperty(HTMLMediaElement.prototype,'muted',{get(){return true},set(){}})")
        pg=c.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("https://kaamelott-app.vercel.app/")
        n=0
        for _ in range(60):
            n=pg.evaluate("window.__kaam && window.__kaam.allQuotes ? window.__kaam.allQuotes.length : (typeof allQuotes!=='undefined'?allQuotes.length:0)")
            if n: break
            pg.wait_for_timeout(500)
        print(f"  en ligne ({scheme}) : {n} répliques, erreurs : {errs[:2]}")
        if not n or errs: bad.append(scheme)
        c.close()
    b.close()
    raise SystemExit(1 if bad else 0)
EOF
ok "contrôle en ligne clair + sombre"
echo "PUBLIÉ $S8"
