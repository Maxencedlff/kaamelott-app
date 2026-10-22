# Kaamelott

PWA des répliques de Kaamelott (texte, son, scène vidéo), en ligne sur https://kaamelott-app.vercel.app, protégée par un
code d'accès.

## Architecture

- **Front sans build** : `index.html`, `app.js` (tout l'écran, en `'use strict'`), `style.css`, `compat.js` (ES5 :
  message « appareil trop ancien »). Aucun framework, aucune étape de compilation : le dépôt est servi tel quel.
- **Service worker** `sw.js` : coquille en cache (version `CACHE = 'kaamelott-vNN'`), `data.json` servi depuis le cache
  et revalidé par ETag, portraits en cache d'abord.
- **Données** : `data.json` (une entrée par réplique), `perso.json` et `img/perso/` (portraits). Sons et vidéos sont sur
  Hugging Face (dataset `Maxencedlf/kaamelott-videos`, dossiers `s/`, `v/`, `cx/` pour les vidéos élargies de coupe).
- **Fonctions Vercel** (`api/`, Node) :
  - `avis.js` : avis du mode Vérifier, coupes réglées dans l'appli et demandes de recoupe, rangés dans un dépôt GitHub
    privé (`avis/…`, `faits.json`, `coupes.json`) ;
  - `extrait.js` : extrait coupé à la volée (ffmpeg) pour une coupe enregistrée et pas encore refaite sur le PC ;
  - `acces.js` : saisie du code d'accès (pose le cookie) ; `_acces.js` et `_debit.js` : code partagé (pas des routes).
- **Code d'accès** : `middleware.js` (Routing Middleware Vercel) refuse `data.json` et les fonctions sans le cookie
  `kaam_acces` ; la coquille reste libre pour que l'app puisse demander le code et se mettre à jour.
- **Chaîne des médias, hors dépôt** : `kaam-audio` sur le PC (découpe des sons et vidéos, envoi sur Hugging Face,
  finalisation horaire des coupes `coupes.py`, publication des données `publie.sh`).

## Invariants

- **L'index `i` d'une réplique est immuable** : avis, favoris, `faits.json` et `coupes.json` y renvoient. Jamais de
  suppression ni de réordonnancement (masquer avec `hide`). `tests/check_data.py` refuse toute réplique changée au même
  index, sauf correction déclarée dans `tests/corrections_autorisees.json` (`--autoriser` la remplit, à relire).
- **`PB_LISTS` (app.js) = `PROBLEMES` (api/avis.js)** : mêmes identifiants de problèmes des deux côtés.
- **`CACHE` de `sw.js` est incrémenté à chaque publication** (fait par `tests/publier.sh`) : c'est ce qui livre la
  nouvelle version aux appareils.

## Lancer en local

```sh
python3 -m http.server 8080      # puis http://localhost:8080 (pas de code d'accès en local : pas de middleware)
```

## Tester

```sh
npm run lint                                     # ESLint : règles recommandées (eslint.config.mjs)
node --test tests/                               # tests unitaires (front, avis, extrait, accès)
python3 tests/check_data.py                      # cohérence de data.json, comparé au commit précédent
python3 tests/e2e/run_all.py --quick --jobs 4    # banc Playwright (Chromium + WebKit, médias muets locaux)
```

Le banc écrit `tests/e2e/rapport.md`. `--relancer` relance une fois un worker en échec ; vert au 2e passage, il est
signalé « INSTABLE » (à corriger, pas à ignorer).

## Publier

```sh
tests/publier.sh "Message du commit"
```

Lint, tests, contrôle de `data.json` contre le dernier commit, banc, incrément du cache, commit, push, déploiement Vercel de
ce commit, attente de la CI GitHub (rollback automatique de la production si elle est rouge), contrôle en ligne.
Refuse de publier un fichier non suivi inattendu (le dépôt est public). Jetons lus dans `~/.config/kaam/` (fichiers 600).

## Code d'accès

Défini sur Vercel par `KAAM_ACCES_CODE` et `KAAM_ACCES_SECRET` (le cookie est un HMAC du code : changer le code
déconnecte tout le monde, puis redéployer). Copie locale pour les scripts dans `~/.config/kaam/acces.json` (600).
Le code n'est écrit nulle part dans le dépôt.
