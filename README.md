# Collecte de pièces salariés – E&D Pessac

Application web qui permet aux assistantes RH de l'agence Essentiel & Domicile de Pessac de demander des pièces justificatives à un salarié. Le salarié les dépose depuis son smartphone, et l'assistante les reçoit par e-mail, en PDF. Ensuite, tout est supprimé.

Cahier des charges : `OneDrive - CDL EXPERTISES\DEV-CONSULT\SCD\SCD Services\PROMPT_collecte-pieces.md`. Le projet est construit par étapes, chacune validée par Christel.

| Étape | Contenu | État |
|---|---|---|
| 1 | Squelette, base de données, liens magiques | **fait** |
| 2 | Formulaire de demande, invitation, administration de la liste autorisée | **fait** |
| 3 | Dépôt avec brouillon (pièces chiffrées AES-256-GCM) | **fait** |
| 4 | Contrôle de lisibilité, génération des PDF | **fait** |
| 5 | Workflow n8n d'envoi final, purge vérifiée | **fait** (déploiement sur le VPS à faire) |
| 6 | Relances, expiration, suivi | à faire |

## Choix techniques

- **Node 24, sans framework et sans dépendance npm en production.** Le serveur HTTP est le module `node:http`. La base est **SQLite**, avec le module `node:sqlite` intégré à Node. Les PDF sont écrits par l'application elle-même (`src/pdf.js`). Moins il y a de dépendances, moins il y a de failles à surveiller (`npm audit`). Seul outil ajouté : **Playwright**, pour les tests, qui n'entre pas dans l'image de production.
- **Deux bibliothèques servies par l'application au téléphone du salarié** (jamais par un site tiers), copiées telles quelles depuis npm dans `public/vendor/`, versions figées, empreintes vérifiées par un test (`public/vendor/EMPREINTES.json`) : **pdf.js** 6.3.289 (Mozilla, Apache-2.0) pour transformer les PDF en images, et **libheif** 1.23.2 (LGPL-3.0) pour lire les photos HEIC d'iPhone. Le téléphone ne les télécharge que si le salarié envoie un PDF ou une photo HEIC.
- **Pages rendues côté serveur.** Seule la page de dépôt du salarié charge un script (`public/depot.js`, servi par l'application elle-même, sans script en ligne ni domaine tiers). Sans ce script, l'envoi classique des formulaires fonctionne quand même.
- **Tous les e-mails passent par n8n** (instance dédiée), via des webhooks signés HMAC-SHA256 (`src/notifications.js`). L'application n'envoie jamais d'e-mail elle-même : elle rédige chaque message, n8n se contente de l'envoyer par Brevo (phase 1), puis par Outlook (phase 2).
- **Envoi final du dossier** (`src/envoi.js`) : n8n ne reçoit jamais les pièces dans son message, seulement le texte de l'e-mail et l'adresse **interne** de chaque PDF. Il les télécharge sur un second port de l'application (`src/interne.js`), qui n'est relié à aucun nom de domaine et exige son propre secret. Les PDF y sont fabriqués à la demande, en mémoire.
- **Projet distinct de Constats et de PENA :** son propre dépôt, son image, sa base, ses secrets et son projet Docker. Seul le Traefik du VPS est partagé.

## Ce qui se modifie sans toucher au code

- `config/pieces.json` : liste des pièces (libellé, pages, « contrôle seulement », consigne au salarié) et modèles « embauche » / « mise à jour ». Une erreur de saisie bloque le démarrage avec un message précis.
- `config/textes.json` : textes des e-mails (connexion, invitations), nom d'expéditeur, mention RGPD, aide et messages de lisibilité affichés au salarié. Les mots entre `{{ }}` sont remplacés automatiquement.
- `config/envoi.json` : seuil de découpage des envois (15 Mo), part quotidienne d'e-mails sur le compte Brevo partagé (150) et seuil d'alerte (80 %), délais des nouvelles tentatives (15 min, 1 h, 4 h), délai avant l'alerte « n8n sans nouvelles » (6 h).
- `config/controles.json` : seuils du contrôle de lisibilité (résolution, netteté, luminosité, reflets, nombre d'échecs avant « envoyer quand même »), réencodage des photos, taille visée et plafond des PDF. Une valeur hors limites bloque le démarrage avec un message précis.
- Écran **Administration** : adresses autorisées (ajout, désactivation, suppression avec confirmation), domaines autorisés, journal d'activité, nombre d'e-mails envoyés aujourd'hui, envois en échec avec un bouton « Relancer l'envoi ».

Après une modification d'un fichier `config/`, redémarrer l'application (en production : nouvelle image, puis Deploy).

Les écrans de réglage des durées et des textes depuis l'administration arriveront avec les relances (étape 6).

## Sécurité déjà en place (étapes 1 à 5)

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
| Photo envoyée malgré le contrôle de lisibilité : pièce marquée « à vérifier », mention reprise dans l'e-mail final | `src/depot.js`, `src/emails.js` |
| WebAssembly (`'wasm-unsafe-eval'`), workers et polices autorisés **sur la seule page de dépôt**, et seulement depuis l'application ; toujours ni script en ligne, ni `eval`, ni site tiers | `src/http.js` |
| Bibliothèques servies depuis une liste fermée de chemins et de types (`/vendor/pdfjs/…`, `/vendor/libheif/…`) ; un test vérifie leurs empreintes | `src/app.js`, `tests/pdf.test.js` |
| Toute préparation (PDF, HEIC) est abandonnée au bout de 60 s avec un message : la page ne reste jamais figée | `public/depot.js` |
| **Étape 5 – envoi final et purges** | |
| E-mail final à l'assistante : objet `[Embauche] Pièces reçues – Mme NOM – demande du JJ/MM/AAAA` (ou `[Mise à jour] …`), liste des pièces, mentions « À VÉRIFIER » et « CONTRÔLE SEULEMENT : à consulter puis supprimer, ne pas archiver » (casier judiciaire, permis), aucune donnée tirée des pièces ; découpé en (1/2), (2/2)… au-delà de 15 Mo | `src/emails.js`, `src/envoi.js` |
| n8n ne reçoit que des adresses de PDF, sur un port interne non publié par Traefik, protégé par `INTERNAL_API_SECRET` (comparé à temps constant) ; le PDF n'est servi que pour un envoi en cours | `src/interne.js` |
| Dès que n8n confirme le dernier e-mail : fichiers effacés, pièces et pages supprimées, lien du salarié invalidé, son e-mail effacé ; il ne reste que civilité, nom et statut « transmise » jusqu'à la purge | `src/envoi.js` |
| Échec (n8n injoignable ou envoi refusé) : nouvelles tentatives à 15 min, 1 h et 4 h, en ne renvoyant que les e-mails non confirmés, puis alerte à l'administratrice ; alerte aussi si n8n reste 6 h sans nouvelles (sans renvoi, pour éviter un doublon) ; relance manuelle dans l'administration | `src/envoi.js` |
| Alertes sans nom ni donnée de salarié : seulement l'identifiant technique de la demande | `config/textes.json` |
| Purge de sécurité faite par l'application elle-même (au démarrage puis toutes les heures), même si n8n est arrêté : toute demande expirée (15 jours au plus) est effacée entièrement, même si l'envoi n'a pas réussi ; les fichiers orphelins de plus d'une heure aussi | `src/purge.js`, `src/stockage.js` |
| Compteur des e-mails du jour (heure de Paris) ; alerte unique à l'administratrice à 80 % de la part réservée sur le compte Brevo partagé | `src/compteur.js` |
| n8n dédié : aucune exécution conservée, réussie ou en échec ; suppression **immédiate** des exécutions (`EXECUTIONS_DATA_PRUNE=false`, voir ci-dessous) ; pièces jointes en mémoire seulement ; webhooks non joignables depuis Internet (règle Traefik) | `deploy/docker-compose.scd-pieces.yml` |

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

## Envoi final par n8n (étape 5)

Livrables dans `deploy/` :

- `docker-compose.scd-pieces.yml` : projet Docker **séparé** `scd-pieces` (l'application et son n8n dédié), sur le réseau `root_default` pour Traefik, plus un réseau privé `scd-interne` entre l'application et n8n ;
- `n8n/SCD_envoyer_un_email.json` : sous-workflow unique d'envoi, piloté par `EMAIL_PROVIDER=brevo|outlook` ;
- `n8n/SCD_evenements_application.json` : réception des événements (signature HMAC vérifiée, horodatage de moins de 5 minutes), e-mails simples, envoi du dossier, confirmations et échecs ;
- `GUIDE_DEPLOIEMENT.md` : déploiement pas à pas (qui fait quoi), ce que n8n et Brevo conservent ;
- `PROCEDURE_TEST_PURGE.md` : démontrer qu'il ne reste aucune trace des pièces (disque, base, n8n, journaux).

**Validation du 17/10/2026**, sur un n8n 2.43.5 provisoire installé sur le PC, avec un faux serveur d'e-mail local et des données fictives. Rien n'est parti sur Internet. Ce qui a été vérifié :

- le lien de connexion et l'invitation arrivent par n8n ;
- l'e-mail final arrive avec ses PDF en vraies pièces jointes ;
- après la confirmation, l'application a tout effacé et le lien du salarié répond « plus valable » ;
- un envoi refusé par le serveur d'e-mail est signalé à l'application, puis réussit à la nouvelle tentative.

Trois pièges de n8n 2.x ont été trouvés et corrigés :

- le sous-workflow doit lui aussi être **publié** ;
- les pièces jointes passent par l'option « fileAttachments » (« attachments » les insère dans le corps du message) ;
- avec `EXECUTIONS_DATA_PRUNE=true`, n8n se contente de **marquer** les exécutions à supprimer et garde les PDF dans sa base jusqu'à un nettoyage ultérieur. Avec `false`, il les efface aussitôt.

Le n8n provisoire et les données d'essai ont été supprimés ensuite.

**Ce que Brevo conserve :** par défaut, les journaux et aperçus des e-mails transactionnels sont gardés sans limite de durée. Une règle de conservation plus courte se règle dans le compte, qui est partagé avec Constats et PENA. Le guide détaille ce point et le risque résiduel.

## Limites connues

- Un navigateur sans script (cas très rare sur téléphone) ne peut envoyer que des photos JPEG, ou des PNG simples (sans transparence) ; pas de PDF. Sans script, l'orientation des photos JPEG n'est pas corrigée.
- Le test de bout en bout HEIC a besoin d'une photo HEIC d'exemple, non versionnée (voir « Tests »).
- Pendant les quelques secondes de l'envoi, les PDF passent par la base de n8n ; des octets peuvent subsister dans l'espace libéré de ce fichier jusqu'au prochain redémarrage de n8n (`DB_SQLITE_VACUUM_ON_STARTUP`).
- Phase 2 (Outlook) : le choix EMAIL_PROVIDER est en place, mais le nœud Outlook lui-même sera ajouté lors de la bascule (n8n refuse de publier un nœud Outlook sans identifiant).
- Si n8n a bien envoyé l'e-mail mais que sa confirmation se perd, l'application ne renvoie rien : elle prévient l'administratrice au bout de 6 h. Mieux vaut un doublon évité qu'un dossier envoyé deux fois.

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

Ce sont des tests unitaires et d'intégration (`node:test`) : vrai serveur, base temporaire, comptes fictifs, aucun e-mail envoyé. n8n y est simulé : `tests/envoi.test.js` joue son rôle sur le port interne (téléchargement des PDF, confirmations, échecs).

Tests de bout en bout du parcours du salarié, sur iPhone (moteur de Safari) et Android (moteur de Chrome) simulés :

```powershell
npx playwright install chromium webkit
npm run test:e2e
```

La première commande ne sert qu'une fois (elle télécharge les navigateurs de test). Les photos et PDF utilisés sont fabriqués dans le navigateur, entièrement fictifs. Pour le test HEIC, placer une photo HEIC d'exemple sans donnée personnelle dans `tests/e2e/locaux/exemple.heic` (dossier non versionné) ; sinon ce test est sauté.

## Déploiement

Pas encore en production. Un push sur `main` lance les tests, puis GitHub Actions construit l'image `ghcr.io/christel-cdl/scd-rh-docs:latest`. La mise en place sur le VPS (application et n8n dédié) suit `deploy/GUIDE_DEPLOIEMENT.md`. Christel la fait elle-même, dans hPanel, après son accord.
