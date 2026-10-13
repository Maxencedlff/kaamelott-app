#!/bin/bash
# Publication en une commande : tests → commit → push (jeton fine-grained) → déploiement Vercel de CE commit → CI GitHub → contrôle en ligne.
# usage : tests/publier.sh "Message du commit"      (à lancer depuis la racine du dépôt kaamelott-app)
set -euo pipefail
cd "$(dirname "$0")/.."
MSG="${1:?message de commit manquant}"
T=$(cat ~/.config/kaam/github_token)
VT=$(grep -o 'vcp_[A-Za-z0-9]*' /home/maxdevops/.claude/projects/-home-maxdevops/memory/reference_vercel.md | head -1)
TEAM=team_vsrQBKB5DaJbha03esHVWjP3; PRJ=prj_rHkTDWayY3BeNjxjGqtkvhbSBLan
ok() { echo "✔ $*"; }; ko() { echo "✘ $*"; exit 1; }

node --check app.js && node --check sw.js || ko "syntaxe JS"
node --test tests/ >/tmp/kaam_unit.txt 2>&1 || { tail -20 /tmp/kaam_unit.txt; ko "tests unitaires"; }; ok "tests unitaires"
python3 tests/check_data.py >/dev/null || ko "contrôle de data.json"; ok "data.json"
python3 tests/e2e/run_all.py --quick >/tmp/kaam_banc.txt 2>&1 || { tail -15 /tmp/kaam_banc.txt; ko "banc Playwright"; }; ok "banc Playwright"

python3 - <<'EOF'
import re; p='sw.js'; s=open(p).read()
s=re.sub(r"kaamelott-v(\d+)", lambda m: f"kaamelott-v{int(m.group(1))+1}", s, 1); open(p,'w').write(s)
EOF
git add -A .
git commit -qm "$MSG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
SHA=$(git rev-parse HEAD); S8=${SHA:0:8}
git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$T" | base64 -w0)" push -q https://github.com/Maxencedlff/kaamelott-app.git main
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
[ "$r" = "READY $S8" ] && ok "Vercel : en production" || ko "Vercel : $r"

# CI GitHub Actions
for i in $(seq 60); do
  c=$(curl -s -H "Authorization: Bearer $T" "https://api.github.com/repos/Maxencedlff/kaamelott-app/actions/runs?head_sha=$SHA" | python3 -c "import json,sys;r=json.load(sys.stdin)['workflow_runs'];print((r[0]['status']+' '+str(r[0]['conclusion'])) if r else 'attente')")
  case "$c" in "completed success") break;; completed*) ko "CI : $c";; esac; sleep 15
done
[ "$c" = "completed success" ] && ok "CI verte" || ko "CI : $c"

# contrôle en ligne (navigateur, pas de curl en boucle sur le site)
python3 - <<'EOF'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.webkit.launch(); bad=[]
    for scheme in ("light","dark"):
        c=b.new_context(**p.devices["iPhone 13"], color_scheme=scheme, bypass_csp=True)
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
