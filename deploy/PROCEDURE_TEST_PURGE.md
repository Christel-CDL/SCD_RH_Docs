# Procédure de test de purge

But : démontrer qu'après l'envoi d'un dossier à l'assistante, **il ne reste aucune trace des pièces** : ni sur le disque, ni dans la base, ni dans n8n, ni dans les journaux. Cahier des charges § 7, livrable 7.

À faire à la mise en service, puis après chaque mise à jour importante. **Uniquement avec des documents fictifs** (feuille imprimée « DOCUMENT FICTIF », nom « ZZ TEST »).

## Ce que les tests automatiques vérifient déjà

À chaque `npm test` (fichier `tests/envoi.test.js`) :

| Vérification | Test |
|---|---|
| Après la confirmation de n8n : plus aucun fichier dans `DATA_DIR/pieces`, plus aucune ligne `pieces` ni `pages` | « après confirmation de n8n, tout est effacé… » |
| Lien du salarié inutilisable (réponse 410), e-mail du salarié effacé de la base | idem |
| Plus rien à télécharger sur le port interne (404) | idem |
| Journal d'activité sans nom ni e-mail de salarié | idem |
| Envoi découpé : rien n'est effacé avant la confirmation du **dernier** e-mail | « envoi découpé… » |
| Purge à 15 jours : demande, pièces, pages, envoi et fichiers effacés, même si l'envoi a échoué | « purge à 15 jours… » |
| Fichiers orphelins de plus d'une heure effacés | « purge des fichiers orphelins… » |
| n8n ne reçoit jamais les pièces dans son message, seulement des adresses internes | « dossier complet : n8n reçoit… » |

## Essai réel sur le VPS

### 1. Déposer un dossier fictif

1. Se connecter à https://pieces.expertform.fr, créer une demande « Mise à jour » : civilité M., nom **ZZ TEST Purge**, e-mail du salarié = votre propre adresse, pièces : RIB et Justificatif de domicile.
2. Ouvrir le lien reçu, photographier une feuille « DOCUMENT FICTIF » pour chaque pièce, cliquer sur « Envoyer mon dossier ».
3. Noter l'heure.

### 2. Vérifier la réception

Dans la boîte de l'assistante (ici la vôtre) : un e-mail `[Mise à jour] Pièces reçues – M. ZZ TEST Purge – demande du …` avec `ZZ_TEST_PURGE-RIB.pdf` et `ZZ_TEST_PURGE-JDOM.pdf`.

### 3. Vérifier l'application

- Écran **Mes demandes** : « Complète et transmise », « Pièces envoyées par e-mail le …, puis supprimées de l'outil ».
- Rouvrir le lien du salarié : « Ce lien n'est plus valable ».
- **Administration → Journal d'activité** : « Pièces reçues par l'assistante, puis supprimées de l'outil ». Aucune ligne ne contient le nom « ZZ TEST » ni d'adresse de salarié.
- Journal du conteneur `scd-pieces-app` (hPanel → Docker Manager → scd-pieces → Logs) : les adresses apparaissent masquées (`/d/***`, `/interne/envois/***/pieces/***`). Aucun nom, aucun contenu.
- Disque : hPanel → Docker Manager → scd-pieces → conteneur scd-pieces-app → Terminal, puis :

  ```
  ls -la /data/pieces
  ```

  Le dossier doit être **vide**, sauf les pièces des autres dossiers en cours.

### 4. Vérifier n8n

- https://n8n-pieces.srv1102696.hstgr.cloud → **Executions** : la liste doit être **vide** (aucune exécution n'est sauvegardée, ni réussie ni en échec).
- Terminal du conteneur `scd-pieces-n8n` :

  ```
  ls -la /home/node/.n8n
  ```

  Il ne doit y avoir ni dossier `binaryData` ni dossier `storage` contenant des fichiers PDF.

### 5. Vérifier Brevo

Brevo → **Transactional** → **Logs** : l'e-mail apparaît (date, destinataire, objet). C'est le risque résiduel décrit dans `deploy/GUIDE_DEPLOIEMENT.md` (« Ce que Brevo conserve »). La règle de conservation choisie doit s'y appliquer.

### 6. Purge à 15 jours

Pas besoin d'attendre 15 jours : les tests automatiques couvrent ce cas. Sur le VPS, une demande laissée sans réponse disparaît de « Mes demandes » 15 jours après sa création, et le journal montre « Demande expirée effacée (purge à 15 jours) ».

### Résultat attendu

Toutes les cases ci-dessus vérifiées. Sinon, ne pas mettre en service : faire une capture d'écran et me la transmettre.
