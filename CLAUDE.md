# CLAUDE.md

Application de collecte de pièces justificatives de salariés pour E&D Pessac (client de SCD Services), utilisée par Christel (administratrice, non-développeuse) et les assistantes RH. Code, commentaires, interface et messages de commit **en français**.

- **Feuille de route** : `C:\Users\Christel\OneDrive - CDL EXPERTISES\DEV-CONSULT\SCD\SCD Services\PROMPT_collecte-pieces.md`, à appliquer à la lettre (RGPD et sécurité non négociables). Travail par étapes (§ 8) : ne jamais commencer l'étape suivante sans la validation de Christel. Avancement dans `README.md`.
- **Décisions de l'étape 0 (17/10/2026)** : domaine `pieces.expertform.fr` (DNS OVH saisis par Christel) ; **n8n dédié** à l'application ; compte Brevo vérifié sur `expertform.fr`, **partagé** avec Constats et PENA (le compteur de 300/jour doit en tenir compte) ; **purge absolue à 15 jours** après la création de la demande, qui l'emporte sur « ne rien supprimer tant que l'envoi n'a pas réussi » ; date limite affichée au salarié : J+14 à 18 h.
- **Constats** (`github.com/Christel-CDL/APP_CONSTATS`) sert uniquement d'inspiration : ne jamais le modifier ni le copier.

## Commandes

- `npm test` : doit passer avant chaque commit. `npm run dev` : serveur local (copier d'abord `.env.example` en `.env`).
- Shell de Christel : **PowerShell** (pas de `&&`). L'outil Bash de Claude, lui, est Git Bash.
- Aucune donnée réelle de salarié, même en test : comptes et documents **fictifs** uniquement.

## Architecture

- Node 24, `node:http`, `node:sqlite`, **aucune dépendance npm** tant qu'on peut l'éviter (justifier chaque ajout, `npm audit` propre).
- `src/app.js` : routes (table `'MÉTHODE /chemin'`) ; `creerApp()` ne démarre rien, ce qui permet aux tests de l'utiliser.
- Toute redirection se construit depuis `config.appUrl` (APP_URL), jamais depuis l'en-tête Host. Derrière Traefik, l'IP du client est la **dernière** de X-Forwarded-For (`TRUST_PROXY=1`).
- Jetons : `nouveauJeton()` (256 bits), stockés par `empreinte()` uniquement. Tout POST passe le contrôle d'origine ; un POST connecté vérifie aussi le jeton `csrf` de la session.
- Le journal d'accès ne contient jamais la chaîne de requête ; la table `journal` ne contient jamais de nom, d'e-mail de salarié ni de contenu de pièce.
- Les e-mails partent **uniquement par n8n** (`notificateur.envoyer(evenement, donnees)`, signature HMAC). L'application ne contient aucun client SMTP.
- Migrations : ajouter une entrée à la fin de `MIGRATIONS` dans `src/db.js`, ne jamais modifier une migration déjà livrée.

## Déploiement — ce que Claude ne peut pas faire

`git push`, l'écriture sur le VPS (hPanel) et les DNS OVH sont faits **par Christel**. Claude committe localement, puis donne la commande PowerShell et la marche à suivre. Hostinger ne sait que tirer une image (`image:`), jamais construire. Vérifier tout « c'est fait » verbal (logs, capture d'écran).
