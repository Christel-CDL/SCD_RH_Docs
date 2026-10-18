# Procédure de test de purge

But : démontrer qu'une fois les pièces récupérées, **il ne reste aucune trace des pièces** : ni sur le disque, ni dans la base, ni dans n8n, ni chez Brevo, ni dans les journaux. Cahier des charges § 7, livrable 7.

À faire à la mise en service, puis après chaque mise à jour importante. **Uniquement avec des documents fictifs** (feuille imprimée « DOCUMENT FICTIF », nom « ZZ TEST »).

Rappel du fonctionnement (depuis le 18/10/2026) : les pièces ne partent **jamais** par e-mail. La personne qui a fait la demande reçoit un e-mail avec un bouton « Télécharger les pièces », les télécharge dans l'application, puis elles sont effacées : sur sa confirmation, sinon 24 h après le premier téléchargement, et au plus tard à J+15.

## Ce que les tests automatiques vérifient déjà

À chaque `npm test` (fichiers `tests/envoi.test.js` et `tests/relances.test.js`) :

| Vérification | Test |
|---|---|
| L'e-mail « pièces reçues » ne contient aucune pièce, ni l'e-mail du salarié | « dossier complet : un e-mail sans pièce… » |
| Téléchargement réservé à la personne qui a fait la demande (même l'administratrice n'y a pas accès) | « téléchargement : réservé… » |
| Après « J'ai enregistré les pièces » : plus aucun fichier dans `DATA_DIR/pieces`, plus aucune ligne `pieces` ni `pages`, lien du salarié inutilisable (410), e-mail du salarié effacé, journal sans nom | « J'ai enregistré les pièces… » |
| Sans confirmation : effacement 24 h après le premier téléchargement | « sans confirmation… » |
| Purge à 15 jours : tout est effacé, même si rien n'a été récupéré, et la personne qui a fait la demande est prévenue | « expiration sans dossier envoyé… », « expiration d'un dossier complet… » |
| Fichiers orphelins de plus d'une heure effacés | « purge des fichiers orphelins… » |
| Lien du salarié gardé chiffré pour la relance, effacé dès l'envoi du dossier | « pas de relance si le dossier est envoyé… » |

## Essai réel sur le VPS

### 1. Déposer un dossier fictif

1. Se connecter à https://pieces.expertform.fr, créer une demande « Mise à jour » : civilité M., nom **ZZ TEST Purge**, e-mail du salarié = votre propre adresse, pièces : Relevé d'identité bancaire et Justificatif de domicile.
2. Ouvrir le lien reçu (bouton « Déposer mes documents »), photographier une feuille « DOCUMENT FICTIF » pour chaque pièce, cliquer sur « Envoyer mon dossier ».

### 2. Recevoir et télécharger

1. Dans votre boîte : un e-mail `[Mise à jour] Pièces reçues – M. ZZ TEST Purge – demande du …`, **sans pièce jointe**, avec un bouton « Télécharger les pièces ».
2. Le bouton (ou « Mes demandes » → « Télécharger les pièces ») ouvre la page des pièces : télécharger le ZIP, vérifier qu'il contient `ZZ_TEST_PURGE-RIB.pdf` et `ZZ_TEST_PURGE-JDOM.pdf`, lisibles.
3. Cliquer sur **« J'ai enregistré les pièces : les supprimer de l'outil »**.

### 3. Vérifier l'application

- Écran **Mes demandes** : « Pièces récupérées, puis supprimées de l'outil le … ».
- Rouvrir le lien du salarié : « Ce lien n'est plus valable ». Rouvrir la page des pièces : « supprimées de l'outil ».
- **Administration → Journal d'activité** : « Pièces enregistrées par la personne qui les a demandées, puis supprimées de l'outil ». Aucune ligne ne contient le nom « ZZ TEST » ni d'adresse de salarié.
- Journal du conteneur `scd-pieces-app` (hPanel → Docker Manager → scd-pieces → Journaux) : les adresses de dépôt apparaissent masquées (`/d/***`). Aucun nom, aucun contenu.
- Disque : hPanel → Docker Manager → scd-pieces → conteneur scd-pieces-app → Terminal, puis :

  ```
  ls -la /data/pieces
  ```

  Le dossier doit être **vide**, sauf les pièces des autres dossiers en cours.

### 4. Vérifier n8n

- https://n8n-pieces.srv1102696.hstgr.cloud → **Executions** : la liste doit être **vide**.

### 5. Vérifier Brevo

Brevo → **Transactionnel** → **Journaux** : les e-mails de l'essai (invitation, pièces reçues) doivent **disparaître** (effacement automatique, traité par Brevo sous 72 h au plus). Les rouvrir avant leur disparition ne doit jamais montrer de pièce jointe. Si un journal reste au-delà de 72 h : vérifier l'identifiant `Brevo API SCD` dans le nœud « Effacer le journal Brevo » du workflow « SCD – Événements de l'application ».

### 6. Purge à 15 jours et relance

Pas besoin d'attendre : les tests automatiques couvrent ces cas. Sur le VPS, une demande laissée sans réponse reçoit une relance à J+7, puis disparaît 15 jours après sa création ; la personne qui l'a faite reçoit alors un e-mail « Lien expiré », et le journal montre « Demande expirée effacée (purge à 15 jours) ».

### Résultat attendu

Toutes les cases ci-dessus vérifiées. Sinon, ne pas mettre en service : faire une capture d'écran et me la transmettre.
