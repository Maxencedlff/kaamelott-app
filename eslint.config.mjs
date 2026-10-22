// ESLint (config « flat ») : règles recommandées seulement, pour attraper les vraies erreurs (variable non définie,
// code mort, faute de frappe) sans imposer de style. Chaque type de fichier a son environnement.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'docs/', 'tests/e2e/shots/'] },
  js.configs.recommended,
  { rules: {
    'no-empty': ['error', { allowEmptyCatch: true }],   // catch {} volontaire : stockage plein ou bloqué, on continue
    // espaces fines insécables de la typographie française dans les textes affichés
    'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true }],
    'no-unused-vars': ['error', { ignoreRestSiblings: true }],   // { inutile, ...garde } : retirer une clé
    'no-control-regex': 'off',   // regex qui retirent justement les caractères de contrôle des textes reçus
  } },
  { // appli : scripts classiques chargés par index.html
    files: ['app.js', 'compat.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    files: ['sw.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },
  { // fonctions Vercel (CommonJS)
    files: ['api/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['middleware.js', 'eslint.config.mjs', 'tests/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
];
