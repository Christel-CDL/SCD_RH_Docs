# Collecte de pièces salariés – E&D Pessac

Application web qui permet aux assistantes RH de l'agence Essentiel & Domicile de Pessac de demander des pièces justificatives à un salarié. Le salarié les dépose depuis son smartphone, et l'assistante les reçoit par e-mail, en PDF. Ensuite, tout est supprimé.

Cahier des charges : `OneDrive - CDL EXPERTISES\DEV-CONSULT\SCD\SCD Services\PROMPT_collecte-pieces.md`. Le projet est construit par étapes, chacune validée par Christel.

| Étape | Contenu | État |
|---|---|---|
| 1 | Squelette, base de données, liens magiques | **fait** |
| 2 | Formulaire de demande, invitation, administration de la liste autorisée | **fait** |
| 3 | Dépôt avec brouillon (pièces chiffrées AES-256-GCM) | **fait** |
| 4 | Contrôle de lisibilité, génération des PDF | **fait** |
| 5 | Workflow n8n d'envoi final, purge vérifiée | à faire |
| 6 | Relances, expiration, suivi | à faire |

## Choix techniques

- **Node 24, sans framework et sans dépendance npm en production.** Le serveur HTTP est le module `node:http`. La base est **SQLite**, avec le module `node:sqlite` intégré à Node. Les PDF sont écrits par l'application elle-même (`src/pdf.js`). Moins il y a de dépendances, moins il y a de failles à surveiller (`npm audit`). Seul outil ajouté : **Playwright**, pour les tests, qui n'entre pas dans l'image de production.
- **Deux bibliothèques servies par l'application au téléphone du salarié** (jamais par un site tiers), copiées telles quelles depuis npm dans `public/vendor/`, versions figées, empreintes vérifiées par un test (`public/vendor/EMPREINTES.json`) : **pdf.js** 6.3.289 (Mozilla, Apache-2.0) pour transformer les PDF en images, et **libheif** 1.23.2 (LGPL-3.0) pour lire les photos HEIC d'iPhone. Le téléphone ne les télécharge que si le salarié envoie un PDF ou une photo HEIC.
- **Pages rendues côté serveur.** Seule la page de dépôt du salarié charge un script (`public/depot.js`, servi par l'application elle-même, sans script en ligne ni domaine tiers). Sans ce script, l'envoi classique des formulaires fonctionne quand même.
- **Tous les e-mails passent par n8n** (instance dédiée), via des webhooks signés HMAC-SHA256 (`src/notifications.js`). L'application n'envoie jamais d'e-mail elle-même.
- **Projet distinct de Constats et de PENA :** son propre dépôt, son image, sa base, ses secrets et son projet Docker. Seul le Traefik du VPS est partagé.

## Ce qui se modifie sans toucher au code

- `config/pieces.json` : liste des pièces (libellé, pages, « contrôle seulement », consigne au salarié) et modèles « embauche » / « mise à jour ». Une erreur de saisie bloque le démarrage avec un message précis.
- `config/textes.json` : textes des e-mails (connexion, invitations), nom d'expéditeur, mention RGPD, aide et messages de lisibilité affichés au salarié. Les mots entre `{{ }}` sont remplacés automatiquement.
- `config/controles.json` : seuils du contrôle de lisibilité (résolution, netteté, luminosité, reflets, nombre d'échecs avant « envoyer quand même »), réencodage des photos, taille visée et plafond des PDF. Une valeur hors limites bloque le démarrage avec un message précis.
- Écran **Administration** : adresses autorisées (ajout, désactivation, suppression avec confirmation), domaines autorisés, journal d'activité.

Après une modification d'un fichier `config/`, redémarrer l'application (en production : nouvelle image, puis Deploy).

Les écrans de réglage des durées et des textes depuis l'administration arriveront avec les relances (étape 6).

## Sécurité déjà en place (étapes 1 à 4)

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
| Le type réel est reconnu par les premiers octets du fichier, pas par son nom : le serveur n'accepte que des JPEG et des PNG (les PDF et les HEIC sont transformés en JPEG dans le téléphone, étape 4) | `src/fichiers.js` |
| Photos réencodées dans le téléphone avant l'envoi (position GPS et autres métadonnées supprimées) ; côté serveur, l'EXIF et les commentaires des JPEG, les blocs de texte des PNG sont retirés une seconde fois | `public/depot.js`, `src/fichiers.js` |
| Limites : 10 Mo par fichier, 10 pages par pièce, 80 Mo par demande, 40 envois par quart d'heure et par demande | `src/depot.js`, `src/app.js` |
| Remplacer une pièce efface aussitôt les anciens fichiers du disque | `src/depot.js` |
| « Envoyer mon dossier » n'est possible que lorsque toutes les pièces sont déposées ; après la date limite, plus aucun dépôt | `src/depot.js` |
| CSP ouverte au strict nécessaire : `script-src 'self'`, aperçus en `blob:`, `connect-src 'self'` ; tout POST de dépôt passe le contrôle d'origine | `src/http.js` |
| Style et script revalidés à chaque affichage (`no-cache` + ETag) : après une mise à jour, aucun téléphone ne garde l'ancien script | `src/app.js` |
| Mention d'information RGPD (article 13) en tête de la page de dépôt, **en projet** : les passages [À COMPLÉTER] doivent être validés par E&D avant la mise en service | `config/textes.json` |
| **Étape 4 – lisibilité et PDF** | |
| PDF « désarmés » : chaque page d'un PDF envoyé par le salarié est dessinée en image dans le téléphone (pdf.js, sans exécuter ses scripts : le moteur correspondant n'est même pas livré). L'application refait elle-même le PDF : ni auteur, ni logiciel, ni script, ni pièce jointe cachée ne peuvent arriver chez l'assistante. Un PDF brut reçu par le serveur est refusé | `public/depot.js`, `src/fichiers.js` |
| PDF finaux fabriqués en mémoire au moment de l'envoi, à partir des pages chiffrées : aucune copie en clair sur le disque. Pas de dictionnaire /Info ni de métadonnées XMP | `src/pdf.js`, `src/depot.js` |
| Nom des fichiers `NOM-ABREV.pdf` sans accents ni caractère de chemin ; pour « CNI ou passeport », l'abréviation de la pièce réellement fournie | `src/pdf.js` |
| Taille : le téléphone recompresse pour viser 1,5 Mo par pièce ; le serveur refuse au-delà de 3,5 Mo (limite Brevo : 4 Mo par pièce jointe) | `public/depot.js`, `src/depot.js` |
| Photo envoyée malgré le contrôle de lisibilité : pièce marquée « à vérifier » (mention à reprendre dans l'e-mail final de l'étape 5) | `src/depot.js` |
| WebAssembly (`'wasm-unsafe-eval'`), workers et polices autorisés **sur la seule page de dépôt**, et seulement depuis l'application ; toujours ni script en ligne, ni `eval`, ni site tiers | `src/http.js` |
| Bibliothèques servies depuis une liste fermée de chemins et de types (`/vendor/pdfjs/…`, `/vendor/libheif/…`) ; un test vérifie leurs empreintes | `src/app.js`, `tests/pdf.test.js` |
| Toute préparation (PDF, HEIC) est abandonnée au bout de 60 s avec un message : la page ne reste jamais figée | `public/depot.js` |

## Contrôle de lisibilité (étape 4)

Fait dans le téléphone, avant l'envoi de chaque photo. L'analyse porte sur une copie réduite à environ 1 000 pixels :

- **résolution** : au moins 1 000 pixels sur le petit côté ;
- **netteté** : force des contours des lettres (99,9ᵉ centile du laplacien après un léger lissage), rapportée au contraste de la photo. La « variance du laplacien » proposée par le cahier des charges a été essayée puis écartée : elle prenait le grain de l'appareil photo pour de la netteté et jugeait floue une carte d'identité nette mais peu remplie ;
- **luminosité** moyenne, et **reflet** : part des pixels « brûlés » (blanc pur). Une image presque entièrement brûlée est signalée comme trop claire plutôt que comme un reflet.

Chaque défaut a son message (« La photo est floue. Posez le document à plat… »). Après deux échecs sur le même emplacement, le salarié peut envoyer la photo quand même ; la pièce est alors marquée « à vérifier ».

**Décision de Christel (17/10/2026) : pas de recadrage automatique** (écart voulu au cahier des charges § 2.4 et § 6). À la place, un cadre-guide rappelle de poser le document à plat et de le faire remplir l'écran.

Calibrage du 17/10/2026, sur des photos **fictives** fabriquées dans le navigateur (`tests/e2e/fictifs-navigateur.js`), mesuré dans Chromium (Safari donne des scores de netteté 10 à 15 % plus élevés, du même côté du seuil sauf cas limite) :

| Photo fictive | Netteté | Luminosité | Reflet | Résultat |
|---|---|---|---|---|
| Page A4 nette (avec ou sans fort grain) | 148 | 183 | 0 % | acceptée |
| Page floue 3 px, encore lisible | 80 | 183 | 0 % | acceptée |
| Page floue 6 px, à peine lisible | 39 | 183 | 0 % | **floue** |
| Page floue 10 px | 15 | 183 | 0 % | **floue** |
| Carte d'identité nette / floue 3 px / floue 6 px | 211 / 147 / 73 | 186 | 0 % | acceptées |
| Page sombre (35 %) / très sombre (25 %) | 147 / 142 | 64 / 46 | 0 % | acceptée / **sombre** |
| Page surexposée (130 %) | 152 | 202 | 53 % | **trop claire** |
| Reflet moyen / petit reflet | 137 / 138 | 185 | 4,8 / 1,5 % | **reflet** / acceptée |
| Photo de 900 × 1 200 px | 144 | 184 | 0 % | **trop petite** |
| Document loin dans le cadre / et flou 4 px | 124 / 44 | 124 | 0 % | acceptée / **floue** |

Seuils retenus (`config/controles.json`) : netteté 55, luminosité 60 à 235, reflet 3 %. **À confirmer** lors d'un essai avec de vrais téléphones et des documents fictifs imprimés : des photos fabriquées par programme ne remplacent pas un appareil réel.

## Limites connues

- Un navigateur sans script (cas très rare sur téléphone) ne peut envoyer que des photos JPEG, ou des PNG simples (sans transparence) ; pas de PDF. Sans script, l'orientation des photos JPEG n'est pas corrigée.
- Le test de bout en bout HEIC a besoin d'une photo HEIC d'exemple, non versionnée (voir « Tests »).

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

Ce sont des tests unitaires et d'intégration (`node:test`) : vrai serveur, base temporaire, comptes fictifs, aucun e-mail envoyé.

Tests de bout en bout du parcours du salarié, sur iPhone (moteur de Safari) et Android (moteur de Chrome) simulés :

```powershell
npx playwright install chromium webkit
npm run test:e2e
```

La première commande ne sert qu'une fois (elle télécharge les navigateurs de test). Les photos et PDF utilisés sont fabriqués dans le navigateur, entièrement fictifs. Pour le test HEIC, placer une photo HEIC d'exemple sans donnée personnelle dans `tests/e2e/locaux/exemple.heic` (dossier non versionné) ; sinon ce test est sauté.

## Déploiement

Pas encore en production. Un push sur `main` lance les tests, puis GitHub Actions construit l'image `ghcr.io/christel-cdl/scd-rh-docs:latest`. Le fichier `docker-compose`, le guide de déploiement et la procédure de mise à jour seront livrés avant la mise en service, après accord de Christel.
