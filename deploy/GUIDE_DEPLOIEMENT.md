# Guide de déploiement – collecte de pièces et son n8n dédié

Pour Christel. Chaque étape dit **qui fait quoi**. Claude ne peut ni pousser sur GitHub, ni écrire sur le VPS, ni modifier les DNS : ces gestes sont les vôtres. Après chaque étape, une vérification permet de s'assurer que tout va bien.

Installé sur le VPS le 18/10/2026. Les essais se font avec des **documents fictifs uniquement** tant que la mise en service n'est pas validée.

## Ce qui tourne sur le VPS

Un projet Docker **séparé**, `scd-pieces`, avec deux conteneurs :

| Conteneur | Rôle | Adresse |
|---|---|---|
| `scd-pieces-app` | l'application | https://pieces.expertform.fr |
| `scd-pieces-n8n` | le n8n **dédié** : il envoie les e-mails par Brevo, puis efface leur journal chez Brevo | https://n8n-pieces.srv1102696.hstgr.cloud (éditeur seulement) |

L'application prévient n8n par un réseau privé (`scd-interne`). Les webhooks de n8n ne sont pas joignables depuis Internet. **Aucune pièce ne passe par n8n ni par Brevo** : la personne qui a fait la demande télécharge les pièces dans l'application.

Les projets `root` (Traefik, n8n général, Suivi PENA) et `app-constats` ne sont pas modifiés.

## 1. Les secrets (vous, sur votre PC)

Il faut **trois** secrets différents. Générez chacun avec cette commande PowerShell, une fois par secret :

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

| Variable | À quoi elle sert | Si on la perd |
|---|---|---|
| `FILE_ENCRYPTION_KEY` | chiffre les pièces déposées et les liens des salariés | les dossiers en cours deviennent illisibles |
| `N8N_WEBHOOK_SECRET` | signe les messages de l'application vers n8n | on en génère un nouveau, à mettre aux deux endroits |
| `N8N_ENCRYPTION_KEY` | chiffre, dans n8n, les identifiants Brevo | il faut ressaisir les identifiants Brevo dans n8n |

Rangez-les dans votre gestionnaire de mots de passe. Ne les envoyez jamais par e-mail et ne les mettez jamais dans Git. (Un quatrième secret, `INTERNAL_API_SECRET`, servait jusqu'au 18/10/2026 : il est devenu inutile et peut être retiré de hPanel.)

## 2. Publier le code (vous)

```powershell
cd C:\Users\Christel\Documents\SCD_RH_Docs
```

```powershell
git push
```

Attendez la **coche verte** sur GitHub → onglet **Actions** (tests puis construction de l'image). Le paquet `scd-rh-docs` est déjà public.

## 3. Le DNS (fait le 18/10/2026)

`pieces.expertform.fr` pointe vers le VPS (`72.61.102.144` et `2a02:4780:28:4213::1`). Le domaine d'envoi `expertform.fr` a un SPF unique (`v=spf1 include:mx.ovh.com include:spf.protection.outlook.com include:spf.brevo.com -all`), la signature DKIM de Brevo et un DMARC. **Ne jamais ajouter un second enregistrement SPF** : il faut modifier l'existant.

## 4. Le projet dans hPanel (vous)

1. hPanel → VPS → **Docker Manager** → projet **`scd-pieces`** (jamais `root`).
2. Contenu : le fichier `deploy/docker-compose.scd-pieces.yml`.
3. Variables d'environnement : `ADMIN_EMAIL`, `ADMIN_NOM` et les trois secrets de l'étape 1.
4. **Déployer**.

**Vérification :** https://pieces.expertform.fr/sante affiche `ok` ; le journal du conteneur `scd-pieces-app` ne contient pas « DÉMARRAGE IMPOSSIBLE » (sinon la ligne suivante dit quelle variable manque).

## 5. Votre compte dans n8n (fait le 18/10/2026)

Compte propriétaire avec votre adresse et un mot de passe propre à ce n8n. Activez la double vérification (avatar → Settings → Personal).

## 6. Les deux identifiants Brevo dans n8n (vous)

**a) Envoi des e-mails : clé SMTP** (fait le 18/10/2026)

- Brevo → **SMTP & API** → onglet **SMTP** → clé SMTP dédiée.
- n8n → **Credentials** → **SMTP**, nommé exactement `Brevo SMTP SCD` : User = identifiant SMTP Brevo (`…@smtp-brevo.com`), Password = la clé, Host `smtp-relay.brevo.com`, Port `587`, SSL/TLS désactivé.

**b) Effacement des journaux : clé API**

Brevo garde dans ses journaux le contenu des e-mails (liens personnels compris). n8n efface le journal de chaque e-mail juste après l'envoi ; il lui faut pour cela une clé **API** (différente de la clé SMTP).

1. Créer la clé dans Brevo :
   1. https://app.brevo.com, compte habituel (`expertform.fr`).
   2. En haut à droite, cliquez sur le **nom du compte** (ou vos initiales) → **SMTP & API**.
   3. Onglet **Clés API** (parfois « Clés API & MCP »), pas l'onglet SMTP. Ne touchez pas aux clés existantes (Constats, PENA).
   4. **Générer une nouvelle clé API** (si Brevo demande le type : clé API, pas MCP).
   5. Nom : `n8n SCD pièces – effacement des journaux` → **Générer**.
   6. La clé (commence par `xkeysib-`) n'est affichée **qu'une fois** : **Copier**, puis collez-la dans votre gestionnaire de mots de passe. Fenêtre fermée trop tôt ? Supprimez la clé et recommencez.
2. n8n → **Credentials** → **Create credential** → cherchez **Header Auth** :
   - nom de l'identifiant (en haut) : `Brevo API SCD`, exactement ;
   - **Name** : `api-key` ;
   - **Value** : la clé API.
3. **Save**.

Brevo → **Sécurité** → **Adresses IP autorisées** : `72.61.102.144` doit y figurer, sinon Brevo refuse les envois et les effacements.

## 7. Les workflows dans n8n (vous)

Les deux workflows sont déjà installés. Pour les **mettre à jour** sans casser le lien entre eux, on remplace leur contenu au lieu de les réimporter à côté :

1. Ouvrez **« SCD – Envoyer un e-mail »** → cliquez dans le dessin → **Ctrl+A** puis **Suppr** → menu **…** → **Import from File…** → `deploy/n8n/SCD_envoyer_un_email.json`.
   - Nœud **« Brevo (SMTP) »** : identifiant `Brevo SMTP SCD`.
   - **Save**, puis **Publish** (nom de version, par exemple `v3 – effacement des journaux`).
2. Ouvrez **« SCD – Événements de l'application »** → même méthode → `deploy/n8n/SCD_evenements_application.json`.
   - Nœud **« Envoyer l'e-mail »** : choisissez « SCD – Envoyer un e-mail » dans la liste.
   - Nœud **« Effacer le journal Brevo »** : identifiant `Brevo API SCD`.
   - **Save**, puis **Publish**.

Les **deux** workflows doivent être publiés : un sous-workflow non publié ne s'exécute pas (constaté le 17/10/2026). Pour une première installation, utilisez simplement **Create workflow** → **Import from File** pour chacun.

**Vérification :** les deux workflows sont marqués « Published ». Demandez un lien de connexion : il arrive, et quelques minutes plus tard son journal n'apparaît plus dans Brevo (ou au plus tard sous 72 h, selon Brevo). Si le journal reste au-delà de 72 h, vérifiez l'identifiant `Brevo API SCD` dans le nœud « Effacer le journal Brevo ».

## 8. Essai complet (vous, avec des documents fictifs)

Suivez `deploy/PROCEDURE_TEST_PURGE.md`. Envoyez-moi une capture d'écran de chaque vérification : je ne considère rien comme fait sans l'avoir vu.

## Ce que n8n conserve

Validé le 17/10/2026 sur un n8n 2.43.5 provisoire :

- n8n écrit chaque exécution dans sa base dès son début, puis l'**efface dès la fin** avec les réglages du docker-compose.
- **`EXECUTIONS_DATA_PRUNE: "false"` est indispensable** : avec « true », n8n ne fait que marquer l'exécution pour une suppression ultérieure.
- Depuis le 18/10/2026, les exécutions ne contiennent plus aucune pièce : seulement le texte des e-mails (civilité et nom du salarié, liens personnels), le temps de l'envoi.

## Ce que Brevo conserve

D'après l'aide de Brevo (octobre 2026), les **journaux et aperçus des e-mails sont conservés sans limite de durée par défaut**. L'essai du 18/10/2026 l'a confirmé : la **pièce jointe** d'un e-mail se rouvrait depuis le journal. D'où les deux mesures prises :

1. **plus aucune pièce par e-mail** (téléchargement dans l'application) ;
2. **effacement automatique** du journal de chaque e-mail, 20 s après l'envoi (étape 6 b). n8n répond d'abord à l'application, puis efface : sinon l'application attendait trop longtemps (essai du 18/10/2026). Brevo traite l'effacement sous 72 h au plus.

En filet de sécurité, réglez aussi la durée de conservation la plus courte : **Paramètres → E-mails transactionnels → Règles de conservation**. Ce réglage s'applique à tout le compte, donc aussi à Constats et PENA.

**Suivi des ouvertures et des clics** (constaté le 18/10/2026 : événements « Ouvert », « Cliqué ») : Brevo réécrit les liens des e-mails et ajoute un pixel. Il n'offre pas de désactivation complète pour les e-mails transactionnels, seulement : **Paramètres → Automations → E-mails transactionnels → Suivi → Suivi anonyme des emails : Oui**, et **Paramètres → Contacts → consentement au pixel de suivi** : « Non » pour les contacts au consentement inconnu (recommandation CNIL). Les deux valent pour tout le compte (Constats, PENA). Les liens de dépôt transitent donc par Brevo : ils n'ouvrent qu'une demande, expirent et deviennent inutilisables à l'envoi du dossier. Seul l'envoi par Outlook (phase 2) supprime ce passage.

**Risque résiduel**, à mentionner dans le registre des traitements (Brevo, sous-traitant ultérieur) : pendant au plus 72 h, Brevo garde l'e-mail (nom du salarié, liste des pièces, lien personnel), jamais le contenu des pièces.

## Passage à Outlook (phase 2, plus tard)

Dans le docker-compose, `EMAIL_PROVIDER: outlook`. Puis, dans le workflow « SCD – Envoyer un e-mail », remplacez le nœud « Outlook (phase 2, pas encore installé) » par un nœud « Microsoft Outlook » (envoi de message), relié à la boîte de l'agence : identifiant OAuth, avec le consentement de l'administrateur Microsoft 365 du réseau. n8n refuse de publier un nœud Outlook sans identifiant : il ne peut pas être préparé à l'avance. L'effacement des journaux Brevo devient alors inutile pour ces e-mails. Vérifiez aussi l'adresse et le nom d'expéditeur. Rien d'autre ne change dans l'application.

## Mise à jour de l'application

1. Je committe ; vous faites `git push`.
2. Vous attendez la coche verte.
3. Dans hPanel → projet `scd-pieces` → **Déployer** (l'image `latest` est retéléchargée).
4. Si je vous l'indique : mise à jour des workflows n8n (étape 7) ou du docker-compose.

Les volumes `scd-pieces-data` et `scd-pieces-n8n` ne doivent **jamais** être supprimés : ils contiennent la base, les pièces en cours (chiffrées), les workflows et les identifiants Brevo.
