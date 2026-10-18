# Guide de déploiement – collecte de pièces et son n8n dédié

Pour Christel. Chaque étape dit **qui fait quoi**. Claude ne peut ni pousser sur GitHub, ni écrire sur le VPS, ni modifier les DNS : ces gestes sont les vôtres. Après chaque étape, une vérification permet de s'assurer que tout va bien.

Ce premier déploiement sert à **l'essai réel de l'étape 5**, avec des **documents fictifs uniquement**. Aucune vraie demande ne doit être créée avant la validation finale.

## Ce qui va tourner sur le VPS

Un projet Docker **séparé**, `scd-pieces`, avec deux conteneurs :

| Conteneur | Rôle | Adresse |
|---|---|---|
| `scd-pieces-app` | l'application | https://pieces.expertform.fr |
| `scd-pieces-n8n` | le n8n **dédié** : il envoie les e-mails par Brevo | https://n8n-pieces.srv1102696.hstgr.cloud (éditeur seulement) |

Les deux conteneurs se parlent par un réseau privé (`scd-interne`). Depuis Internet, on ne peut joindre :

- ni le port interne de l'application, où n8n télécharge les PDF ;
- ni les webhooks de n8n.

Les projets `root` (Traefik, n8n général, Suivi PENA) et `app-constats` ne sont pas modifiés.

## 1. Préparer les secrets (vous, sur votre PC)

Il faut **quatre** secrets différents. Générez chacun avec cette commande PowerShell, une fois par secret :

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

| Variable | À quoi elle sert | Si on la perd |
|---|---|---|
| `FILE_ENCRYPTION_KEY` | chiffre les pièces déposées | les dossiers en cours deviennent illisibles |
| `N8N_WEBHOOK_SECRET` | signe les messages de l'application vers n8n | on en génère un nouveau, à mettre aux deux endroits |
| `INTERNAL_API_SECRET` | protège le port interne où n8n télécharge les PDF | idem |
| `N8N_ENCRYPTION_KEY` | chiffre, dans n8n, l'identifiant Brevo | il faut ressaisir l'identifiant Brevo dans n8n |

Rangez-les dans votre gestionnaire de mots de passe. Ne les envoyez jamais par e-mail et ne les mettez jamais dans Git.

## 2. Publier le code (vous)

```powershell
cd C:\Users\Christel\Documents\SCD_RH_Docs
```

```powershell
git push
```

Attendez la **coche verte** sur GitHub → onglet **Actions** (tests puis construction de l'image).

La première fois seulement : GitHub → votre profil → **Packages** → `scd-rh-docs` → **Package settings** → **Change visibility** → **Public**. L'image ne contient ni donnée ni secret. Sans ce réglage, le VPS ne peut pas la télécharger et affiche « pull access denied ».

**Vérification :** la page du paquet indique « Public ».

## 3. Vérifier le DNS (vous, ou demandez-moi)

`pieces.expertform.fr` doit pointer vers l'adresse du VPS `72.61.102.144` (saisi chez OVH à l'étape 0). L'adresse `n8n-pieces.srv1102696.hstgr.cloud` fonctionne déjà, sans rien faire.

```powershell
Resolve-DnsName pieces.expertform.fr
```

**Vérification :** la réponse contient `72.61.102.144`.

## 4. Créer le projet dans hPanel (vous)

1. hPanel → VPS → **Docker Manager** → **Nouveau projet** (Compose).
2. Nom du projet : **`scd-pieces`**. Ce nom est important : jamais `root`.
3. Collez le contenu du fichier `deploy/docker-compose.scd-pieces.yml`.
4. Dans les **variables d'environnement** du projet, saisissez :
   - `ADMIN_EMAIL` : votre adresse ;
   - `ADMIN_NOM` : votre prénom et votre nom ;
   - les quatre secrets de l'étape 1.
5. **Déployer**.

**Vérification :**

- https://pieces.expertform.fr/sante affiche `ok`.
- Dans les journaux du conteneur `scd-pieces-app`, on lit « Port interne pour n8n : 0.0.0.0:3001 ».
- Le message « DÉMARRAGE IMPOSSIBLE » n'apparaît pas. S'il apparaît, la ligne suivante dit quelle variable manque.

## 5. Ouvrir n8n et créer votre compte (vous)

Ouvrez https://n8n-pieces.srv1102696.hstgr.cloud et créez le compte propriétaire avec **votre** adresse et un mot de passe fort. C'est un n8n neuf, distinct du n8n général.

## 6. Clé SMTP Brevo et identifiant dans n8n (vous)

1. Brevo → **SMTP & API** → onglet **SMTP** → **Générer une nouvelle clé SMTP**, nommée « n8n SCD pièces ». Il faut une clé **SMTP**, pas une clé API.
2. Dans n8n → **Credentials** → **Add credential** → **SMTP** :
   - **Name** : `Brevo SMTP SCD` (exactement ce nom) ;
   - **User** : l'identifiant SMTP affiché par Brevo (il ressemble à `xxxx@smtp-brevo.com`) ;
   - **Password** : la clé générée ;
   - **Host** : `smtp-relay.brevo.com`, **Port** : `587`, **SSL/TLS** : désactivé (le chiffrement se fait par STARTTLS).
3. Brevo → **Sécurité** → **Adresses IP autorisées** : vérifiez que `72.61.102.144` y figure. Elle y est sans doute déjà pour Constats ; sinon Brevo bloque les envois.

## 7. Importer les workflows (vous)

Dans n8n, **dans cet ordre** :

1. **Import from File** → `deploy/n8n/SCD_envoyer_un_email.json`. Ouvrez le nœud « Brevo (SMTP) » et vérifiez que l'identifiant `Brevo SMTP SCD` est choisi. **Enregistrez**, puis **publiez** (bouton « Publish » en haut à droite).
2. **Import from File** → `deploy/n8n/SCD_evenements_application.json`. Ouvrez les nœuds « Envoyer l'e-mail simple » et « Envoyer l'e-mail du dossier », puis choisissez dans la liste « SCD – Envoyer un e-mail ». **Enregistrez**, puis **publiez**.

Les **deux** workflows doivent être publiés. Si seul le second l'est, chaque e-mail échoue aussitôt. Constaté le 17/10/2026 sur n8n 2.43.5 : un sous-workflow non publié ne s'exécute pas.

**Vérification :** les deux workflows sont marqués « Published ».

## 8. Essai complet (vous, avec des documents fictifs)

Suivez `deploy/PROCEDURE_TEST_PURGE.md`, sections 1 à 5. Le premier e-mail qui doit arriver est votre lien de connexion à https://pieces.expertform.fr : il prouve que l'application, n8n et Brevo se parlent.

Envoyez-moi une capture d'écran de chaque vérification : je ne considère rien comme fait sans l'avoir vu.

## Ce que n8n conserve

Validé le 17/10/2026 sur un n8n 2.43.5 provisoire, avec un faux serveur d'e-mail et des données fictives :

- **Exécutions :** n8n écrit chaque exécution dans sa base **dès son début**, données comprises. Pour l'e-mail final, ces données incluent les PDF. Avec les réglages du docker-compose, il l'**efface dès la fin** de l'exécution : aucune ne reste visible ni stockée.
- **Le réglage `EXECUTIONS_DATA_PRUNE: "false"` est indispensable.** Avec « true », n8n ne fait que **marquer** l'exécution pour une suppression ultérieure, et les PDF restent dans sa base en attendant.
- **Risque résiduel :** pendant les quelques secondes de l'envoi, les PDF sont dans la base de n8n. Après effacement, des octets peuvent subsister dans l'espace libéré du fichier de base, jusqu'au prochain redémarrage de n8n, qui réécrit la base (`DB_SQLITE_VACUUM_ON_STARTUP`).
- **Version future de n8n :** n8n annonce la disparition du mode « pièces jointes en mémoire » (`N8N_DEFAULT_BINARY_DATA_MODE: default`). Avant toute mise à jour de l'image n8n, il faudra revérifier ce point avec la procédure de test de purge.

## Ce que Brevo conserve (à régler)

D'après l'aide de Brevo (octobre 2026), les **journaux et aperçus des e-mails transactionnels sont conservés sans limite de durée par défaut**. Une durée plus courte se règle dans **Paramètres → E-mails transactionnels → Règles de conservation**. La suppression est rétroactive et prend jusqu'à 72 h.

- **Ce qui est concerné ici** : l'aperçu de l'e-mail final. Il contient l'objet, le texte (civilité et nom du salarié, liste des pièces) et sans doute le nom des pièces jointes. L'aide de Brevo ne dit pas si le **contenu** des pièces jointes est conservé dans l'aperçu. À vérifier sur le premier e-mail d'essai : ouvrez son aperçu dans les journaux Brevo.
- **Recommandation** : la règle de conservation la plus courte proposée. Comme le compte est **partagé** avec Constats et PENA, cette règle s'appliquera aussi à leurs e-mails. À décider en connaissance de cause.
- **Risque résiduel** : même avec une règle courte, Brevo garde ces informations quelque temps. Le nom du salarié et la liste des pièces y figurent, jamais le contenu des pièces côté application. À mentionner dans le registre des traitements, avec Brevo comme sous-traitant ultérieur.

## Passage à Outlook (phase 2, plus tard)

Dans le docker-compose, `EMAIL_PROVIDER: outlook`. Puis, dans le workflow « SCD – Envoyer un e-mail », remplacez le nœud « Outlook (phase 2, pas encore installé) » par un nœud « Microsoft Outlook » (envoi de message). n8n refuse de publier un nœud Outlook sans identifiant : il ne peut pas être préparé à l'avance.

- identifiant OAuth de la boîte de l'agence (consentement de l'administrateur Microsoft 365 du réseau) ;
- pièces jointes : propriétés binaires listées dans `pieces_binaires`.

Vérifiez aussi :

- la limite de taille des pièces jointes d'Exchange Online, et réglez `seuil_decoupage_mo` dans `config/envoi.json` en conséquence ;
- l'adresse et le nom d'expéditeur.

Rien d'autre ne change dans l'application.

## Mise à jour de l'application (plus tard)

1. Je committe ; vous faites `git push`.
2. Vous attendez la coche verte.
3. Dans hPanel → projet `scd-pieces` → **Déployer** (l'image `latest` est retéléchargée).

Les volumes `scd-pieces-data` et `scd-pieces-n8n` ne doivent **jamais** être supprimés : ils contiennent la base, les pièces en cours (chiffrées), les workflows et l'identifiant Brevo.
