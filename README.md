# Collecte de pièces salariés – E&D Pessac

Application web qui permet aux assistantes RH de l'agence Essentiel & Domicile de Pessac de demander des pièces justificatives à un salarié. Le salarié les dépose depuis son smartphone, et l'assistante les reçoit par e-mail, en PDF. Ensuite, tout est supprimé.

Cahier des charges : `OneDrive - CDL EXPERTISES\DEV-CONSULT\SCD\SCD Services\PROMPT_collecte-pieces.md`. Le projet est construit par étapes, chacune validée par Christel.

| Étape | Contenu | État |
|---|---|---|
| 1 | Squelette, base de données, liens magiques | **fait** |
| 2 | Formulaire de demande, invitation, administration de la liste autorisée | **fait** |
| 3 | Dépôt avec brouillon (pièces chiffrées AES-256-GCM) | **fait** |
| 4 | Contrôle de lisibilité, génération des PDF | **fait** |
| 5 | Envoi par n8n, téléchargement des pièces, purge vérifiée | **fait**, en ligne sur le VPS |
| 6 | Relances, expiration, suivi | **en cours** (décisions du 18/10/2026 dans CLAUDE.md) : relance du salarié à J+7, e-mail d'expiration, guide utilisateur, boutons « Relancer le salarié » (une fois par 24 h, `src/relances.js`) et « Annuler la demande » (`src/annulation.js`) faits ; restent l'écran « Réglages », la note d'architecture et la fiche du registre |

Guide d'une page pour les personnes qui font les demandes : page **Aide** de l'application (`/aide`, imprimable) et `docs/Guide_utilisateur_agence.pdf`, refait par `node tests/e2e/guide-pdf.mjs docs/Guide_utilisateur_agence.pdf` après toute modification du texte (`pageGuide` dans `src/pages.js`).

## Choix techniques

- **Node 24, sans framework et sans dépendance npm en production.** Le serveur HTTP est le module `node:http`. La base est **SQLite**, avec le module `node:sqlite` intégré à Node. Les PDF sont écrits par l'application elle-même (`src/pdf.js`). Moins il y a de dépendances, moins il y a de failles à surveiller (`npm audit`). Seul outil ajouté : **Playwright**, pour les tests, qui n'entre pas dans l'image de production.
- **Deux bibliothèques servies par l'application au téléphone du salarié** (jamais par un site tiers), copiées telles quelles depuis npm dans `public/vendor/`, versions figées, empreintes vérifiées par un test (`public/vendor/EMPREINTES.json`) : **pdf.js** 6.3.289 (Mozilla, Apache-2.0) pour transformer les PDF en images, et **libheif** 1.23.2 (LGPL-3.0) pour lire les photos HEIC d'iPhone. Le téléphone ne les télécharge que si le salarié envoie un PDF ou une photo HEIC.
- **Pages rendues côté serveur.** Seule la page de dépôt du salarié charge un script (`public/depot.js`, servi par l'application elle-même, sans script en ligne ni domaine tiers). Sans ce script, l'envoi classique des formulaires fonctionne quand même.
- **Tous les e-mails passent par n8n** (instance dédiée), via des webhooks signés HMAC-SHA256 (`src/notifications.js`). L'application n'envoie jamais d'e-mail elle-même : elle rédige chaque message, n8n se contente de l'envoyer par Brevo (phase 1), puis par Outlook (phase 2).
- **Les pièces ne partent jamais par e-mail** (`src/envoi.js`). À l'essai réel du 18/10/2026, Brevo conservait les pièces jointes dans ses journaux. Désormais, l'e-mail « pièces reçues » contient un bouton « Télécharger les pièces » : la personne qui a fait la demande se connecte et télécharge les PDF (un par un, ou en ZIP écrit par l'application, `src/zip.js`), fabriqués à la demande, en mémoire. n8n ne manipule plus aucune pièce, et il efface le journal Brevo de chaque e-mail une vingtaine de secondes après l'envoi, une fois la réponse rendue à l'application.
- **Projet distinct de Constats et de PENA :** son propre dépôt, son image, sa base, ses secrets et son projet Docker. Seul le Traefik du VPS est partagé.

## Ce qui se modifie sans toucher au code

- `config/pieces.json` : liste des pièces (libellé, pages, « contrôle seulement », consigne au salarié) et modèles « embauche » / « mise à jour ». Une erreur de saisie bloque le démarrage avec un message précis.
- `config/textes.json` : textes des e-mails (connexion, invitation, relance, pièces reçues, expiration, alertes) et des boutons, nom d'expéditeur, mention RGPD, aide et messages de lisibilité affichés au salarié. Les mots entre `{{ }}` sont remplacés automatiquement.
- `config/envoi.json` : délai de la relance automatique du salarié (7 jours, une seule relance, 0 pour aucune), part quotidienne d'e-mails sur le compte Brevo partagé (150) et seuil d'alerte (80 %), délais des nouvelles tentatives d'envoi (15 min, 1 h, 4 h).
- `config/controles.json` : seuils du contrôle de lisibilité (résolution, netteté, luminosité, reflets, nombre d'échecs avant « envoyer quand même »), réencodage des photos, taille visée et plafond des PDF. Une valeur hors limites bloque le démarrage avec un message précis.
- Écran **Administration** : adresses autorisées (ajout, désactivation, suppression avec confirmation), domaines autorisés, journal d'activité, nombre d'e-mails envoyés aujourd'hui, envois en échec avec un bouton « Relancer l'envoi ».

Après une modification d'un fichier `config/`, redémarrer l'application (en production : nouvelle image, puis Deploy).

Les écrans de réglage des durées et des textes depuis l'administration arriveront avec la fin de l'étape 6.

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
| Mention d'information RGPD (article 13) en tête de la page de dépôt, complétée le 18/10/2026 (SCD SERVICES responsable du traitement, CDL EXPERTISES sous-traitant, hébergement Hostinger en France) : validée par le gérant de l'agence le 18/10/2026 | `config/textes.json` |
| **Étape 4 – lisibilité et PDF** | |
| PDF « désarmés » : chaque page d'un PDF envoyé par le salarié est dessinée en image dans le téléphone (pdf.js, sans exécuter ses scripts : le moteur correspondant n'est même pas livré). L'application refait elle-même le PDF : ni auteur, ni logiciel, ni script, ni pièce jointe cachée ne peuvent arriver chez l'assistante. Un PDF brut reçu par le serveur est refusé | `public/depot.js`, `src/fichiers.js` |
| PDF finaux fabriqués en mémoire au moment de l'envoi, à partir des pages chiffrées : aucune copie en clair sur le disque. Pas de dictionnaire /Info ni de métadonnées XMP | `src/pdf.js`, `src/depot.js` |
| Nom des fichiers `NOM-ABREV.pdf` sans accents ni caractère de chemin ; pour « CNI ou passeport », l'abréviation de la pièce réellement fournie | `src/pdf.js` |
| Taille : le téléphone recompresse pour viser 1,5 Mo par pièce ; le serveur refuse au-delà de 3,5 Mo (limite Brevo : 4 Mo par pièce jointe) | `public/depot.js`, `src/depot.js` |
| Photo envoyée malgré le contrôle de lisibilité : pièce marquée « à vérifier », mention reprise dans l'e-mail final | `src/depot.js`, `src/emails.js` |
| WebAssembly (`'wasm-unsafe-eval'`), workers et polices autorisés **sur la seule page de dépôt**, et seulement depuis l'application ; toujours ni script en ligne, ni `eval`, ni site tiers | `src/http.js` |
| Bibliothèques servies depuis une liste fermée de chemins et de types (`/vendor/pdfjs/…`, `/vendor/libheif/…`) ; un test vérifie leurs empreintes | `src/app.js`, `tests/pdf.test.js` |
| Toute préparation (PDF, HEIC) est abandonnée au bout de 60 s avec un message : la page ne reste jamais figée | `public/depot.js` |
| **Étape 5 – mise à disposition des pièces et purges** | |
| **Aucune pièce par e-mail** : l'e-mail « pièces reçues » (objet `[Embauche] Pièces reçues – Mme NOM – demande du JJ/MM/AAAA`, liste des pièces, mentions « À VÉRIFIER » et « CONTRÔLE SEULEMENT ») contient seulement un bouton vers la page de téléchargement | `src/emails.js`, `src/envoi.js` |
| Page de téléchargement réservée à la personne qui a fait la demande (même l'administratrice n'y a pas accès), connexion obligatoire ; PDF un par un ou ZIP ; réponses `no-store` | `src/app.js`, `src/pages.js`, `src/zip.js` |
| Effacement des pièces, du lien et de l'e-mail du salarié : sur confirmation (« J'ai enregistré les pièces »), sinon 24 h après le premier téléchargement, et au plus tard à J+15 ; il ne reste que civilité, nom et statut | `src/envoi.js` |
| Journal Brevo de **chaque** e-mail effacé par n8n 20 s après l'envoi, une fois la réponse rendue à l'application (les journaux gardaient le contenu, liens personnels compris) ; n8n ne garde pendant ces 20 s que l'identifiant Brevo de l'e-mail, en mémoire | `deploy/n8n/SCD_evenements_application.json` |
| E-mail non parti (n8n ou Brevo en panne) : nouvelles tentatives à 15 min, 1 h et 4 h, puis alerte à l'administratrice et bouton « Relancer l'envoi » ; les pièces restent téléchargeables pendant ce temps | `src/envoi.js` |
| Relance du salarié à J+7 avec le même lien : le lien est gardé **chiffré** (AES-256-GCM) et effacé dès l'envoi du dossier ; pas de relance après la date limite | `src/relances.js`, `src/demandes.js` |
| Alertes sans nom ni donnée de salarié : seulement l'identifiant technique de la demande | `config/textes.json` |
| Purge de sécurité faite par l'application elle-même (au démarrage puis toutes les heures), même si n8n est arrêté : toute demande expirée (15 jours au plus) est effacée entièrement, et la personne qui l'a faite est prévenue si les pièces n'ont pas été récupérées ; les fichiers orphelins de plus d'une heure aussi | `src/purge.js`, `src/stockage.js` |
| Compteur des e-mails du jour (heure de Paris) ; alerte unique à l'administratrice à 80 % de la part réservée sur le compte Brevo partagé | `src/compteur.js` |
| n8n dédié : aucune exécution conservée, réussie ou en échec ; suppression **immédiate** des exécutions (`EXECUTIONS_DATA_PRUNE=false`) ; webhooks non joignables depuis Internet (règle Traefik) | `deploy/docker-compose.scd-pieces.yml` |

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

## Envoi par n8n et téléchargement des pièces (étape 5)

Livrables dans `deploy/` :

- `docker-compose.scd-pieces.yml` : projet Docker **séparé** `scd-pieces` (l'application et son n8n dédié), sur le réseau `root_default` pour Traefik, plus un réseau privé `scd-interne` entre l'application et n8n ;
- `n8n/SCD_envoyer_un_email.json` : sous-workflow unique d'envoi, piloté par `EMAIL_PROVIDER=brevo|outlook` ;
- `n8n/SCD_evenements_application.json` : réception des e-mails rédigés par l'application (signature HMAC vérifiée, horodatage de moins de 5 minutes), réponse à l'application, puis effacement du journal Brevo ;
- `GUIDE_DEPLOIEMENT.md` : déploiement pas à pas (qui fait quoi), ce que n8n et Brevo conservent ;
- `PROCEDURE_TEST_PURGE.md` : démontrer qu'il ne reste aucune trace des pièces (disque, base, n8n, Brevo, journaux).

**Historique.**
- 17/10/2026 : validation sur un n8n 2.43.5 provisoire. Pièges trouvés et corrigés : le sous-workflow doit lui aussi être **publié** ; `EXECUTIONS_DATA_PRUNE=true` ne fait que **marquer** les exécutions à supprimer, `false` les efface aussitôt.
- 18/10/2026 : déploiement sur le VPS, puis essais réels (Gmail, Sébastien DOMINGO, iPhone, photo floue). **Brevo conservait les pièces jointes** dans ses journaux, consultables depuis son tableau de bord : les pièces ne partent donc plus par e-mail, et les journaux Brevo sont effacés après chaque envoi. Sur demande de M. Domingo, relance du salarié à J+7 ; sur demande de Christel, e-mail d'expiration, logo et couleurs violettes d'Essentiel & Domicile.

**Ce que Brevo conserve :** par défaut, les journaux et aperçus des e-mails transactionnels sont gardés sans limite de durée. L'effacement automatique après chaque envoi s'en charge ; en filet de sécurité, régler la durée de conservation la plus courte du compte (partagé avec Constats et PENA). Voir le guide.

## Limites connues

- Un navigateur sans script (cas très rare sur téléphone) ne peut envoyer que des photos JPEG, ou des PNG simples (sans transparence) ; pas de PDF. Sans script, l'orientation des photos JPEG n'est pas corrigée.
- Le test de bout en bout HEIC a besoin d'une photo HEIC d'exemple, non versionnée (voir « Tests »).
- L'effacement d'un journal Brevo est traité par Brevo sous 72 h au plus (d'après son aide). Un échec d'effacement n'est pas signalé à l'application : le contrôle se fait dans les journaux Brevo (procédure de test de purge).
- 18/10/2026 : l'effacement fait avant la réponse de n8n dépassait les 10 s d'attente de l'application (invitation partie mais demande annulée) ; il se fait désormais après la réponse, et l'application attend jusqu'à 20 s.
- Phase 2 (Outlook) : le choix EMAIL_PROVIDER est en place, mais le nœud Outlook lui-même sera ajouté lors de la bascule (n8n refuse de publier un nœud Outlook sans identifiant).
- Le suivi de l'étape 6 n'est pas encore fait : pas de bouton « Relancer » ni « Annuler » pour la personne qui a fait la demande, pas de réglage des durées et des textes depuis l'administration.

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

Ce sont des tests unitaires et d'intégration (`node:test`) : vrai serveur, base temporaire, comptes fictifs, aucun e-mail envoyé. n8n y est simulé par une boîte aux lettres en mémoire, qui peut aussi jouer une panne (`tests/aide.js`).

Tests de bout en bout du parcours du salarié, sur iPhone (moteur de Safari) et Android (moteur de Chrome) simulés :

```powershell
npx playwright install chromium webkit
npm run test:e2e
```

La première commande ne sert qu'une fois (elle télécharge les navigateurs de test). Les photos et PDF utilisés sont fabriqués dans le navigateur, entièrement fictifs. Pour le test HEIC, placer une photo HEIC d'exemple sans donnée personnelle dans `tests/e2e/locaux/exemple.heic` (dossier non versionné) ; sinon ce test est sauté.

## Déploiement

Pas encore en production. Un push sur `main` lance les tests, puis GitHub Actions construit l'image `ghcr.io/christel-cdl/scd-rh-docs:latest`. La mise en place sur le VPS (application et n8n dédié) suit `deploy/GUIDE_DEPLOIEMENT.md`. Christel la fait elle-même, dans hPanel, après son accord.
