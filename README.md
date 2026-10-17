# Collecte de pièces salariés – E&D Pessac

Application web qui permet aux assistantes RH de l'agence Essentiel & Domicile de Pessac de demander des pièces justificatives à un salarié. Le salarié les dépose depuis son smartphone, et l'assistante les reçoit par e-mail, en PDF. Ensuite, tout est supprimé.

Cahier des charges : `OneDrive - CDL EXPERTISES\DEV-CONSULT\SCD\SCD Services\PROMPT_collecte-pieces.md`. Le projet est construit par étapes, chacune validée par Christel.

| Étape | Contenu | État |
|---|---|---|
| 1 | Squelette, base de données, liens magiques | **fait** |
| 2 | Formulaire de demande, invitation, administration de la liste autorisée | **fait** |
| 3 | Dépôt avec brouillon (pièces chiffrées AES-256-GCM) | **fait** |
| 4 | Contrôle de lisibilité, génération des PDF | à faire |
| 5 | Workflow n8n d'envoi final, purge vérifiée | à faire |
| 6 | Relances, expiration, suivi | à faire |

## Choix techniques

- **Node 24, sans framework et sans dépendance npm** à ce stade. Le serveur HTTP est le module `node:http`. La base est **SQLite**, avec le module `node:sqlite` intégré à Node. Moins il y a de dépendances, moins il y a de failles à surveiller (`npm audit`).
- **Pages rendues côté serveur.** Seule la page de dépôt du salarié charge un script (`public/depot.js`, servi par l'application elle-même, sans script en ligne ni domaine tiers). Sans ce script, l'envoi classique des formulaires fonctionne quand même.
- **Tous les e-mails passent par n8n** (instance dédiée), via des webhooks signés HMAC-SHA256 (`src/notifications.js`). L'application n'envoie jamais d'e-mail elle-même.
- **Projet distinct de Constats et de PENA :** son propre dépôt, son image, sa base, ses secrets et son projet Docker. Seul le Traefik du VPS est partagé.

## Ce qui se modifie sans toucher au code

- `config/pieces.json` : liste des pièces (libellé, pages, « contrôle seulement », consigne au salarié) et modèles « embauche » / « mise à jour ». Une erreur de saisie bloque le démarrage avec un message précis.
- `config/textes.json` : textes des e-mails (connexion, invitations), nom d'expéditeur. Les mots entre `{{ }}` sont remplacés automatiquement.
- Écran **Administration** : adresses autorisées (ajout, désactivation, suppression avec confirmation), domaines autorisés, journal d'activité.

Après une modification d'un fichier `config/`, redémarrer l'application (en production : nouvelle image, puis Deploy).

Les écrans de réglage des durées et des textes depuis l'administration arriveront avec les relances (étape 6).

## Sécurité déjà en place (étapes 1 à 3)

| Mesure | Où |
|---|---|
| Jetons de 256 bits ; la base ne stocke que leur empreinte SHA-256 | `src/securite/jetons.js` |
| Lien de connexion à usage unique, valable 15 min, consommé de façon atomique | `src/auth.js` |
| Ouvrir le lien (GET) ne le consomme pas : il faut cliquer sur « Me connecter » (POST). Les antivirus de messagerie qui ouvrent les liens ne les grillent donc pas | `src/auth.js` |
| Réponse identique que l'adresse soit autorisée ou non, envoi sans attente : même le temps de réponse ne révèle rien | `src/app.js` |
| Session de 8 h stockée côté serveur ; cookie `HttpOnly`, `Secure`, `SameSite=Lax`, préfixe `__Host-` ; désactiver un compte coupe sa session immédiatement | `src/auth.js`, `src/http.js` |
| CSRF : contrôle de l'origine sur tout POST, jeton CSRF de session sur les actions connectées | `src/http.js`, `src/app.js` |
| Limitation de débit : 10 demandes par IP et 5 par adresse e-mail par quart d'heure ; 30 essais de lien par IP | `src/app.js` |
| En-têtes : CSP stricte, HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy: same-origin`, `noindex` | `src/http.js` |
| Journaux sans chaîne de requête (les jetons n'apparaissent jamais) ; journal d'activité sans nom, sans e-mail de salarié ni contenu | `src/app.js`, `src/db.js` |
| SQLite `secure_delete` : les données supprimées sont écrasées sur le disque | `src/db.js` |
| Lien du salarié : 256 bits, empreinte seule en base, dans le chemin `/d/…` masqué dans le journal d'accès | `src/demandes.js`, `src/app.js` |
| Contrôle d'accès centralisé : chaque route déclare « public », « session » ou « admin », vérifié avant tout traitement | `src/app.js` |
| Si l'invitation ne part pas, la demande est supprimée aussitôt : aucune donnée de salarié orpheline | `src/app.js` |
| Invitation : civilité, nom, liste des pièces, date limite, agence, nom de l'assistante ; réponse adressée à l'assistante (`Reply-To`) ; aucune demande de mot de passe ni de coordonnées bancaires | `config/textes.json` |
| **Étape 3 – dépôt des pièces** | |
| Chaque pièce est chiffrée sur le disque (AES-256-GCM, clé `FILE_ENCRYPTION_KEY`), sous un nom aléatoire qui ne dit rien du salarié ni de la pièce ; le nom du fichier est lié au chiffrement : un fichier renommé ou modifié est refusé | `src/securite/chiffrement.js`, `src/stockage.js` |
| Le type réel est reconnu par les premiers octets du fichier, pas par son nom : seuls JPEG, PNG et PDF sont acceptés ; le HEIC (iPhone) est refusé avec un message expliquant quoi faire | `src/fichiers.js` |
| Photos réencodées dans le téléphone avant l'envoi (position GPS et autres métadonnées supprimées) ; côté serveur, l'EXIF et les commentaires des JPEG, les blocs de texte des PNG sont retirés une seconde fois | `public/depot.js`, `src/fichiers.js` |
| Limites : 10 Mo par fichier, 10 pages par pièce, 80 Mo par demande, 40 envois par quart d'heure et par demande | `src/depot.js`, `src/app.js` |
| Remplacer une pièce efface aussitôt les anciens fichiers du disque | `src/depot.js` |
| « Envoyer mon dossier » n'est possible que lorsque toutes les pièces sont déposées ; après la date limite, plus aucun dépôt | `src/depot.js` |
| CSP ouverte au strict nécessaire : `script-src 'self'`, aperçus en `blob:`, `connect-src 'self'` ; tout POST de dépôt passe le contrôle d'origine | `src/http.js` |
| Style et script revalidés à chaque affichage (`no-cache` + ETag) : après une mise à jour, aucun téléphone ne garde l'ancien script | `src/app.js` |
| Mention d'information RGPD (article 13) en tête de la page de dépôt, **en projet** : les passages [À COMPLÉTER] doivent être validés par E&D avant la mise en service | `config/textes.json` |

## Reporté à l'étape 4

- **HEIC sur Chrome Android** : aujourd'hui refusé avec un message ; il faudra un décodeur dans le navigateur (Safari sur iPhone convertit déjà la photo tout seul).
- **Recadrage automatique et contrôle de lisibilité** des photos (flou, document coupé).
- **PDF reçus tels quels** : leurs métadonnées (auteur, logiciel) ne sont pas encore nettoyées ; ils sont néanmoins chiffrés et seront supprimés avec le reste.

## Développement local

```powershell
Copy-Item .env.example .env
```

Dans `.env`, renseignez `ADMIN_EMAIL` et `ADMIN_NOM` (valeurs fictives) et une `FILE_ENCRYPTION_KEY` (la commande pour la générer est dans le fichier), puis lancez :

```powershell
npm run dev
```

Ouvrez http://localhost:3000. Avec `DEV_LOG_LINKS=1`, le lien de connexion s'affiche dans la console au lieu d'être envoyé.

## Tests

```powershell
npm test
```

Ce sont des tests unitaires et d'intégration (`node:test`) : vrai serveur, base temporaire, comptes fictifs, aucun e-mail envoyé. Le parcours du salarié a aussi été essayé à la main au format téléphone (375 × 812), avec des documents fictifs générés pour l'occasion. Les tests de bout en bout automatisés sur mobile (Playwright) arriveront avec l'étape 4.

## Déploiement

Pas encore en production. Un push sur `main` lance les tests, puis GitHub Actions construit l'image `ghcr.io/christel-cdl/scd-rh-docs:latest`. Le fichier `docker-compose`, le guide de déploiement et la procédure de mise à jour seront livrés avant la mise en service, après accord de Christel.
