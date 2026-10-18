# CLAUDE.md

Application de collecte de pièces justificatives de salariés pour E&D Pessac (client de SCD Services), utilisée par Christel (administratrice, non-développeuse) et les assistantes RH. Code, commentaires, interface et messages de commit **en français**.

- **Feuille de route** : `C:\Users\Christel\OneDrive - CDL EXPERTISES\DEV-CONSULT\SCD\SCD Services\PROMPT_collecte-pieces.md`, à appliquer à la lettre (RGPD et sécurité non négociables). Travail par étapes (§ 8) : ne jamais commencer l'étape suivante sans la validation de Christel. Avancement dans `README.md`.
- **Décisions de l'étape 0 (17/10/2026)** : domaine `pieces.expertform.fr` (DNS OVH saisis par Christel) ; **n8n dédié** à l'application ; compte Brevo vérifié sur `expertform.fr`, **partagé** avec Constats et PENA (le compteur de 300/jour doit en tenir compte) ; **purge absolue à 15 jours** après la création de la demande, qui l'emporte sur « ne rien supprimer tant que l'envoi n'a pas réussi » ; date limite affichée au salarié : J+14 à 18 h.
- **Décisions de l'étape 4 (17/10/2026)** : **pas de recadrage automatique** (écart voulu au cahier des charges § 2.4 et § 6 : cadre-guide à l'écran, contrôles de résolution, netteté, luminosité et reflets conservés) ; **PDF reçus « désarmés »** : chaque page est rendue en image dans le téléphone (pdf.js, servi par l'application) puis l'application refait le PDF, sans métadonnées ni contenu actif.
- **Décisions de l'étape 5 (17/10/2026)** : essai réel sur le **n8n dédié installé sur le VPS** (Claude fournit le compose et le guide ; Christel installe dans hPanel et saisit elle-même l'identifiant Brevo), envoi à son adresse avec des pièces fictives. Alertes à `ADMIN_EMAIL` ; après l'envoi, seuls civilité, nom et statut restent jusqu'à la purge à J+15 ; l'application compte ses propres e-mails du jour (Brevo partagé) et alerte à 80 % d'un quota réglable (150 par jour par défaut).
- **Décisions après les essais réels (18/10/2026)** : **aucune pièce par e-mail** (Brevo gardait les pièces jointes dans ses journaux) : l'e-mail « pièces reçues » renvoie vers `/demandes/:id/pieces`, réservée à la personne qui a fait la demande (PDF ou ZIP), puis effacement sur sa confirmation, sinon 24 h après le premier téléchargement, au plus tard J+15 ; n8n **efface le journal Brevo** de chaque e-mail (clé API, identifiant n8n « Brevo API SCD »), **après** avoir répondu à l'application (attente 20 s, sinon dépassement du délai : invitation partie mais demande annulée, vu le 18/10/2026) ; plus de port interne ni de `INTERNAL_API_SECRET`. Relance unique du salarié à J+7 avec le même lien (gardé chiffré dans `jeton_chiffre`, effacé à l'envoi du dossier) ; e-mail d'expiration à la personne qui a fait la demande ; pas d'heure dans les dates affichées (`dateJour`). Textes : jamais « assistante », toujours le nom de la personne qui a fait la demande (`{{demandeur}}`). CNI, passeport et photo d'identité retirés du formulaire (`dans_formulaire: false`). Logo Essentiel & Domicile et violet `#602075`. Mention RGPD validée par le gérant, Sébastien DOMINGO.
- **Constats** (`github.com/Christel-CDL/APP_CONSTATS`) sert uniquement d'inspiration : ne jamais le modifier ni le copier.

## Commandes

- `npm test` : doit passer avant chaque commit. `npm run test:e2e` (Playwright, iPhone et Android simulés) : avant chaque commit qui touche `public/` ou la page de dépôt. `npm run dev` : serveur local (copier d'abord `.env.example` en `.env`).
- Shell de Christel : **PowerShell** (pas de `&&`). L'outil Bash de Claude, lui, est Git Bash.
- Aucune donnée réelle de salarié, même en test : comptes et documents **fictifs** uniquement.

## Architecture

- Node 24, `node:http`, `node:sqlite`, **aucune dépendance npm en production** (justifier chaque ajout, `npm audit` propre). Seule dépendance de développement : `@playwright/test`, version exacte.
- `public/vendor/` : pdf.js et libheif copiés tels quels depuis npm (versions dans `EMPREINTES.json`). Toute mise à jour : copier les fichiers, régénérer les empreintes SHA-256, ne jamais livrer `quickjs` ni `sandbox` (scripts de PDF). Servis uniquement par la RegExp `VENDOR` de `src/app.js`.
- pdf.js : rendu avec `intent: 'print'` (sinon il attend `requestAnimationFrame` et peut rester figé), libération par `chargement.destroy()` (pdf.js 6 n'a plus `doc.destroy()`).
- `src/app.js` : routes (`{ m, c, acces: 'public'|'session'|'admin', f }`, `c` chaîne ou RegExp), contrôle d'accès et CSRF centralisés ; `creerApp()` ne démarre rien, ce qui permet aux tests de l'utiliser.
- Toute redirection se construit depuis `config.appUrl` (APP_URL), jamais depuis l'en-tête Host. Derrière Traefik, l'IP du client est la **dernière** de X-Forwarded-For (`TRUST_PROXY=1`).
- `Referrer-Policy: same-origin`, **pas** `no-referrer` : avec ce dernier, Chrome envoie `Origin: null` sur nos formulaires (bug vu le 17/10/2026, invisible pour les tests `fetch`). Vérifier tout nouvel écran dans le navigateur, pas seulement par les tests.
- Jetons : `nouveauJeton()` (256 bits), stockés par `empreinte()` uniquement. Tout POST passe le contrôle d'origine ; un POST connecté vérifie aussi le jeton `csrf` de la session.
- Le journal d'accès ne contient jamais la chaîne de requête ; la table `journal` ne contient jamais de nom, d'e-mail de salarié ni de contenu de pièce.
- Les e-mails sont **composés par l'application** (`src/emails.js`, textes dans `config/textes.json`) et partent **uniquement par n8n** (`notificateur.envoyer('email', { destinataire, sujet, texte, repondre_a, nom_expediteur, categorie })`, signature HMAC). n8n ne fait qu'envoyer ; l'application ne contient aucun client SMTP.
- Pièces : chiffrées AES-256-GCM (`FILE_ENCRYPTION_KEY`, obligatoire, AAD = nom du fichier) sous un nom aléatoire dans `DATA_DIR/pieces`. Le seul script est `public/depot.js` (CSP `script-src 'self'`, rien en ligne ; la page de dépôt seule reçoit `CSP_DEPOT` : wasm, worker, polices) ; les fichiers de `public/` sont servis en `no-cache` + ETag pour qu'une mise à jour arrive aussitôt sur les téléphones.
- CSS : la règle `[hidden] { display: none !important; }` est indispensable (un `display: block` l'emportait sur `hidden`, vu le 17/10/2026). Tout essai navigateur doit forcer le rechargement de `styles.css` et `depot.js` si le serveur a changé.
- Photos de test fictives : `tests/e2e/fictifs-navigateur.js`. Le flou y est calculé pixel par pixel : `ctx.filter` n'existe pas dans Safari et les réductions-agrandissements de WebKit laissent des bords nets (photo « floue » acceptée à tort, vu le 17/10/2026).
- Migrations : ajouter une entrée à la fin de `MIGRATIONS` dans `src/db.js`, ne jamais modifier une migration déjà livrée.

## Déploiement — ce que Claude ne peut pas faire

`git push`, l'écriture sur le VPS (hPanel) et les DNS OVH sont faits **par Christel**. Claude committe localement, puis donne la commande PowerShell et la marche à suivre. Hostinger ne sait que tirer une image (`image:`), jamais construire. Vérifier tout « c'est fait » verbal (logs, capture d'écran).
